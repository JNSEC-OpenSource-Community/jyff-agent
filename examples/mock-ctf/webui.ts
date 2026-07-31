import { resolve } from "node:path"
import { mockPlatform } from "@ctf-agent/platform-mock"
import { ContestScheduler, Project } from "@ctf-agent/solver"
import { startWebUi } from "@ctf-agent/webui"
import { loadModelEnvironment } from "./agent-config.ts"

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

const project = await Project.open({
  root,
  platforms: [mockPlatform],
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
  compaction: { reserveTokens: 3_000, keepRecentTokens: 8_000 },
})
const webui = await startWebUi({
  project,
  scheduler,
  modelConfiguration: model,
  host,
  port,
  pollIntervalMs,
})
let closing = false

console.log(`CTF Agent WebUI 已启动：${webui.url}`)
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
    await scheduler.shutdown()
    await project.close()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

process.once("SIGINT", () => void shutdown("SIGINT"))
process.once("SIGTERM", () => void shutdown("SIGTERM"))
