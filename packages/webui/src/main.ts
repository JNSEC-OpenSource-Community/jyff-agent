import { join, resolve } from "node:path"
import {
  ContestScheduler,
  ControlPlane,
  FileSecretStore,
} from "@ctf-agent/core"
import { ctfdPlatform, gzctfPlatform } from "@ctf-agent/platform"
import { createFileModelAuthentication } from "./model-authentication.ts"
import { createFileModelConfiguration } from "./model-configuration.ts"
import { createFileSchedulerConfiguration } from "./scheduler-configuration.ts"
import { startWebUi } from "./server.ts"

interface WebUiProcessOptions {
  root: string
  host: string
  port: number
  pollIntervalMs: number
  maxConcurrent: number
  maxAttempts: number
  maxSessionInterruptions: number
  challengeTimeoutMs: number
  retryDelayMs: number
  workspaceVolume?: string
  authFile: string
  autoStart: boolean
}

const options = parseOptions(process.argv.slice(2))
const stateDirectory = join(options.root, ".ctf-agent")
const secretStore = await FileSecretStore.open(
  join(stateDirectory, "secrets.json"),
)
const modelAuthentication = await createFileModelAuthentication({
  storagePath: join(stateDirectory, "auth.json"),
  importPath: options.authFile,
})
const modelConfiguration = await createFileModelConfiguration({
  storagePath: join(stateDirectory, "model-config.json"),
  secretStore,
  authentication: modelAuthentication,
})
const schedulerConfiguration = await createFileSchedulerConfiguration({
  storagePath: join(stateDirectory, "scheduler-config.json"),
  fallback: options.maxConcurrent,
})
const controlPlane = await ControlPlane.create({
  root: options.root,
  platforms: [ctfdPlatform, gzctfPlatform],
  secretStore,
  project: {
    telemetry: { level: "full", maxTextLength: 8_000 },
    ...(options.workspaceVolume
      ? {
          workspaceMount: ({ relativeWorkspace }) => ({
            type: "volume" as const,
            source: options.workspaceVolume as string,
            subpath: relativeWorkspace,
          }),
        }
      : {}),
  },
  createScheduler: (project) =>
    new ContestScheduler(project, {
      maxConcurrent: schedulerConfiguration.snapshot(),
      maxAttempts: options.maxAttempts,
      maxSessionInterruptions: options.maxSessionInterruptions,
      challengeTimeoutMs: options.challengeTimeoutMs,
      retryDelayMs: options.retryDelayMs,
      availability: () => {
        const model = modelConfiguration.snapshot()
        return {
          available: model.configured,
          ...(model.unavailableReason
            ? { unavailableReason: model.unavailableReason }
            : {}),
        }
      },
      createAgentOptions: () => modelConfiguration.createAgentOptions(),
      compaction: true,
      onMaxConcurrentChange: async (maxConcurrent) => {
        await schedulerConfiguration.update(maxConcurrent)
      },
    }),
})

await controlPlane.start()
const webui = await startWebUi({
  controlPlane,
  modelAuthentication,
  modelConfiguration,
  host: options.host,
  port: options.port,
  pollIntervalMs: options.pollIntervalMs,
})

console.log(`CTF Agent WebUI 已启动：${webui.url}`)
if (controlPlane.snapshot().phase !== "ready") {
  console.log("比赛平台尚未连接，请在 WebUI 中完成配置")
}
if (options.autoStart && controlPlane.currentScheduler()) {
  const availability = modelConfiguration.snapshot()
  if (availability.configured) {
    await controlPlane.currentScheduler()?.startAuto()
    console.log("自主调度已开启")
  } else {
    console.log(`自主调度未开启：${availability.unavailableReason}`)
  }
}

let closing = false
async function shutdown(signal: string): Promise<void> {
  if (closing) return
  closing = true
  console.log(`收到 ${signal}，正在关闭 WebUI…`)
  try {
    await webui.close()
    await controlPlane.close()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

process.once("SIGINT", () => void shutdown("SIGINT"))
process.once("SIGTERM", () => void shutdown("SIGTERM"))

function parseOptions(args: string[]): WebUiProcessOptions {
  const values = new Map<string, string>()
  let autoStart = false
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index]
    if (name === "--auto-start") {
      autoStart = true
      continue
    }
    if (!name?.startsWith("--")) throw new Error(`无效启动参数: ${name}`)
    const value = args[index + 1]
    if (!value || value.startsWith("--")) throw new Error(`${name} 缺少值`)
    values.set(name, value)
    index += 1
  }
  const known = new Set([
    "--root",
    "--host",
    "--port",
    "--poll-interval-ms",
    "--max-concurrent",
    "--max-attempts",
    "--max-session-interruptions",
    "--challenge-timeout-ms",
    "--retry-delay-ms",
    "--workspace-volume",
    "--auth-file",
  ])
  for (const name of values.keys()) {
    if (!known.has(name)) throw new Error(`未知启动参数: ${name}`)
  }
  return {
    root: resolve(values.get("--root") ?? process.cwd()),
    host: values.get("--host") ?? "0.0.0.0",
    port: positiveInteger(values, "--port", 3_000, 65_535),
    pollIntervalMs: positiveInteger(
      values,
      "--poll-interval-ms",
      1_000,
      60_000,
    ),
    maxConcurrent: positiveInteger(values, "--max-concurrent", 2, 64),
    maxAttempts: positiveInteger(values, "--max-attempts", 2, 100),
    maxSessionInterruptions: positiveInteger(
      values,
      "--max-session-interruptions",
      3,
      100,
    ),
    challengeTimeoutMs: positiveInteger(
      values,
      "--challenge-timeout-ms",
      30 * 60_000,
      24 * 60 * 60_000,
    ),
    retryDelayMs: positiveInteger(
      values,
      "--retry-delay-ms",
      2_000,
      60 * 60_000,
    ),
    ...(values.get("--workspace-volume")
      ? { workspaceVolume: values.get("--workspace-volume") }
      : {}),
    authFile: resolve(values.get("--auth-file") ?? "/auth.json"),
    autoStart,
  }
}

function positiveInteger(
  values: ReadonlyMap<string, string>,
  name: string,
  fallback: number,
  maximum: number,
): number {
  const raw = values.get(name)
  if (raw === undefined) return fallback
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} 必须是 1 到 ${maximum} 的整数`)
  }
  return parsed
}
