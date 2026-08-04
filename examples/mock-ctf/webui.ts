import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { mockPlatform } from "@ctf-agent/platform-mock"
import { ctfdPlatform } from "@ctf-agent/platform-ctfd"
import {
  ContestScheduler,
  Project,
  parseProjectConfig,
  type ProjectConfig,
} from "@ctf-agent/project"
import { startWebUi } from "@ctf-agent/webui"
import { loadModelEnvironment } from "./agent-config.ts"

// 与 run-myctf.ts 同款 .env 加载器(webui 此前不读 .env,导致 CTF_SCHEDULER_* 等配置不生效)
function loadEnvFile(): void {
  const candidates = [
    join(resolve(import.meta.dirname), "..", "..", ".env"),
    join(process.cwd(), ".env"),
  ]
  for (const path of candidates) {
    if (!existsSync(path)) continue
    const content = readFileSync(path, "utf-8")
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("#")) continue
      const match = /^([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*"?([^"#]*?)"?\s*(?:#.*)?$/.exec(trimmed)
      if (!match) continue
      const key = match[1]!
      if (process.env[key]) continue
      process.env[key] = match[2]!
    }
    return
  }
}
loadEnvFile()

const root = resolve(import.meta.dirname)
const host = process.env.CTF_WEBUI_HOST ?? "127.0.0.1"
const port = Number(process.env.CTF_WEBUI_PORT ?? 3000)
const pollIntervalMs = Number(process.env.CTF_WEBUI_POLL_INTERVAL_MS ?? 1_000)
const maxConcurrent = Number(process.env.CTF_SCHEDULER_MAX_CONCURRENT ?? 2)
const maxAttempts = Number(process.env.CTF_SCHEDULER_MAX_ATTEMPTS ?? 2)
const autoStart = process.env.CTF_SCHEDULER_AUTO_START === "true"
const workspaceVolume = process.env.CTF_DOCKER_WORKSPACE_VOLUME
const model = loadModelEnvironment({
  storagePath: resolve(root, ".ctf-agent", "model-config.json"),
})

// 平台模式由 .pi/ctf-config.json 的 platform.plugin 决定；
// 与 Project.open 共用 parseProjectConfig 统一 schema 校验。
const configPath = join(root, ".pi", "ctf-config.json")
let parsedConfig: ProjectConfig
try {
  parsedConfig = parseProjectConfig(JSON.parse(readFileSync(configPath, "utf-8")))
} catch (error) {
  console.error(`无法读取 ctf-config.json:${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
const activePlatform = parsedConfig.platform.plugin

const project = await Project.open({
  root,
  platforms: [mockPlatform, ctfdPlatform],
  resolveSecret: (name) => name === "CTFD_TOKEN"
    ? model.platformToken() ?? process.env[name]
    : process.env[name],
  telemetry: {
    level: process.env.CTF_TELEMETRY_LEVEL === "safe" ? "safe" : "full",
    maxTextLength: Number(process.env.CTF_TELEMETRY_MAX_TEXT_LENGTH ?? 8_000),
  },
  ...(workspaceVolume
    ? {
        workspaceMount: ({ relativeWorkspace }: { relativeWorkspace: string }) => ({
          type: "volume" as const,
          source: workspaceVolume,
          subpath: relativeWorkspace,
        }),
      }
    : {}),
})
const scheduler = new ContestScheduler(project, {
  maxConcurrent,
  maxAttempts,
  challengeTimeoutMs: Number(process.env.CTF_SCHEDULER_TIMEOUT_MS ?? 30 * 60_000),
  retryDelayMs: Number(process.env.CTF_SCHEDULER_RETRY_DELAY_MS ?? 2_000),
  availability: () => ({
    available: model.configured,
    ...(model.unavailableReason
      ? { unavailableReason: model.unavailableReason }
      : {}),
  }),
  createAgentOptions: () => model.createAgentOptions(),
  compaction: true,
})
// 停止调度(暂停自主/关闭)时自动销毁全部运行实例
async function destroyAllInstances(): Promise<void> {
  for (const env of await project.environments()) {
    if (env.status === "running") await project.destroyEnvironment(env.id)
  }
}
const originalPauseAuto = scheduler.pauseAuto.bind(scheduler)
scheduler.pauseAuto = () => {
  void destroyAllInstances()
  return originalPauseAuto()
}
const webui = await startWebUi({
  project,
  scheduler,
  modelConfiguration: model,
  host,
  port,
  pollIntervalMs,
})
let closing = false

console.log(`CTF Agent WebUI 已启动：${webui.url}(平台模式: ${activePlatform})`)
console.log(
  model.configured
    ? `调度模型：${model.provider}/${model.modelId}`
    : `调度器已暂停：${model.unavailableReason}`,
)
if (autoStart && model.configured) {
  await scheduler.startAuto()
  console.log("自主调度已自动开启")
}

async function shutdown(signal: string): Promise<void> {
  if (closing) return
  closing = true
  console.log(`\n收到 ${signal}，正在关闭 WebUI…`)
  try {
    await webui.close()
    await destroyAllInstances()
    await scheduler.shutdown()
    await project.close()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

process.once("SIGINT", () => void shutdown("SIGINT"))
process.once("SIGTERM", () => void shutdown("SIGTERM"))
