import { join, resolve } from "node:path"
import {
  ContestScheduler,
  ControlPlane,
  FileSecretStore,
  webAccessSecretName,
} from "@ctf-agent/core"
import { ctfdPlatform, gzctfPlatform } from "@ctf-agent/platform"
import { createFileModelAuthentication } from "./domain/model-auth.ts"
import { createFileModelConfiguration } from "./domain/model-pool.ts"
import { createFileProjectRuntimeConfiguration } from "./domain/runtime.ts"
import { createFileSchedulerConfiguration } from "./domain/scheduler-config.ts"
import { createFileWebAccessConfiguration } from "./domain/web-access-config.ts"
import { createFileWebUiAuthentication } from "./domain/webui-auth.ts"
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
const webAccessConfiguration = await createFileWebAccessConfiguration({
  storagePath: join(stateDirectory, "web-access.json"),
  secretStore,
})
const schedulerConfiguration = await createFileSchedulerConfiguration({
  storagePath: join(stateDirectory, "scheduler-config.json"),
  fallback: options.maxConcurrent,
})
const authentication = await createFileWebUiAuthentication(
  join(stateDirectory, "global-config.json"),
)
const projectRuntimeConfigurations = new Map<
  string,
  Awaited<ReturnType<typeof createFileProjectRuntimeConfiguration>>
>()
async function projectRuntimeConfiguration(context: {
  projectId: string
  stateDirectory: string
}) {
  const existing = projectRuntimeConfigurations.get(context.projectId)
  if (existing) return existing
  const globalModels = modelConfiguration.snapshot()
  const configuration = await createFileProjectRuntimeConfiguration({
    storagePath: join(context.stateDirectory, "runtime-config.json"),
    fallback: {
      solverModelId: globalModels.solverModelId,
      tldrModelId: globalModels.tldrModelId,
      subagentModels: globalModels.subagentModels,
      maxConcurrent: schedulerConfiguration.snapshot(),
    },
    availableModelIds: () =>
      new Set(modelConfiguration.snapshot().models.map((model) => model.id)),
  })
  projectRuntimeConfigurations.set(context.projectId, configuration)
  return configuration
}
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
    // web-access 插件默认关闭；启用时把 allowlist + 密钥 + 模型解析器组装成
    // WebAccessConfig。密钥只从全局 SecretStore 读取，读 API 永不返回值。
    webAccessConfig: async (workspace, signal) => {
      const snapshot = await webAccessConfiguration.projectSnapshot()
      if (!snapshot.enabled || snapshot.providers.length === 0) return null
      return {
        providers: snapshot.providers,
        workflow: snapshot.workflow,
        resolveSecret: (provider) =>
          secretStore.get(webAccessSecretName(provider)),
        modelAuth: modelConfiguration.resolveModelAuth(),
        ...(snapshot.summaryModel
          ? { summaryModel: snapshot.summaryModel }
          : {}),
        workspaceHostPath: workspace,
        ssrf: snapshot.ssrf,
        timeouts: snapshot.timeouts,
        ...(snapshot.providerConfig
          ? { providerConfig: snapshot.providerConfig }
          : {}),
        sessionSignal: signal,
      }
    },
  },
  createProjectOptions: async (context) => {
    const runtime = await projectRuntimeConfiguration(context)
    return {
      subagents: {
        modelForRole: (role) =>
          modelConfiguration.modelForSubagent(role, runtime.snapshot()),
      },
    }
  },
  createScheduler: async (project, context) => {
    const runtime = await projectRuntimeConfiguration(context)
    return new ContestScheduler(project, {
      maxConcurrent: runtime.snapshot().maxConcurrent,
      maxAttempts: options.maxAttempts,
      maxSessionInterruptions: options.maxSessionInterruptions,
      writeup: true,
      challengeTimeoutMs: options.challengeTimeoutMs,
      retryDelayMs: options.retryDelayMs,
      availability: () => {
        const model = modelConfiguration.snapshot(runtime.snapshot())
        return {
          available: model.configured,
          ...(model.unavailableReason
            ? { unavailableReason: model.unavailableReason }
            : {}),
        }
      },
      createAgentOptions: () =>
        modelConfiguration.createAgentOptions("solver", runtime.snapshot()),
      compaction: true,
      onMaxConcurrentChange: async (maxConcurrent) => {
        await runtime.update({ ...runtime.snapshot(), maxConcurrent })
      },
    })
  },
})

await controlPlane.start()
const webui = await startWebUi({
  controlPlane,
  modelAuthentication,
  modelConfiguration,
  authentication,
  webAccessConfiguration,
  projectRuntimeConfiguration: (projectId) =>
    projectRuntimeConfigurations.get(projectId),
  onProjectDeleted: (projectId) => {
    projectRuntimeConfigurations.delete(projectId)
  },
  host: options.host,
  port: options.port,
  pollIntervalMs: options.pollIntervalMs,
})

console.log(`JYFF Agent WebUI 已启动：${webui.url}`)
if (controlPlane.snapshot().phase !== "ready") {
  console.log("比赛平台尚未连接，请在 WebUI 中完成配置")
}
if (options.autoStart) {
  for (const project of controlPlane.projectSnapshots()) {
    const scheduler = controlPlane.currentScheduler(project.id)
    const runtime = projectRuntimeConfigurations.get(project.id)
    if (!scheduler || !runtime) continue
    const availability = modelConfiguration.snapshot(runtime.snapshot())
    if (availability.configured) {
      await scheduler.startAuto()
      console.log(`${project.name}：自主调度已开启`)
    } else {
      console.log(
        `${project.name}：自主调度未开启：${availability.unavailableReason}`,
      )
    }
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
    maxConcurrent: positiveInteger(values, "--max-concurrent", 8, 64),
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
