import { access } from "node:fs/promises"
import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import type { AgentOptions } from "@earendil-works/pi-agent-core"
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions"
import { getModel, type Model } from "@earendil-works/pi-ai/compat"
import { Project } from "@ctf-agent/project"
import { mockPlatform } from "@ctf-agent/platform-mock"
import { deepseekThinkingLevelMap, thinkingEnabledFromEnv, thinkingLevelFromEnv } from "./agent-config.ts"

// 从项目根目录的 .env 文件加载环境变量（不依赖 dotenv 包）
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
      if (process.env[key]) continue // 不覆盖已有的环境变量
      process.env[key] = match[2]!
    }
    return
  }
}
loadEnvFile()

const apiKey = process.env.CTF_MODEL_API_KEY ?? process.env.OPENROUTER_API_KEY
const modelId = process.env.CTF_MODEL_ID ?? process.env.OPENROUTER_MODEL
const provider = process.env.CTF_MODEL_PROVIDER ?? "openrouter"
const baseUrl = process.env.CTF_MODEL_BASE_URL

if (!apiKey) {
  throw new Error(
    "未设置 API Key。请在项目根目录创建 .env 文件（参考 .env.example）：\n" +
    "  CTF_MODEL_API_KEY = \"sk-...\"\n" +
    "  CTF_MODEL_ID = \"deepseek-chat\"\n" +
    "或设置环境变量 CTF_MODEL_API_KEY / OPENROUTER_API_KEY"
  )
}
if (!modelId) {
  throw new Error(
    "未设置 MODEL。请在项目根目录创建 .env 文件（参考 .env.example）：\n" +
    "  CTF_MODEL_ID = \"deepseek-chat\"\n" +
    "或设置环境变量 CTF_MODEL_ID / OPENROUTER_MODEL"
  )
}

const model: Model<"openai-completions"> = baseUrl ? {
  id: modelId,
  name: modelId,
  api: "openai-completions",
  provider,
  baseUrl: baseUrl.replace(/\/+$/, ""),
  reasoning: thinkingEnabledFromEnv(),
  thinkingLevelMap: provider === "deepseek" || baseUrl.includes("deepseek.com")
    ? deepseekThinkingLevelMap(modelId)
    : undefined,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: Number(process.env.CTF_MODEL_CONTEXT_WINDOW ?? 64_000),
  maxTokens: Number(process.env.CTF_MODEL_MAX_TOKENS ?? 4_096),
  compat: {
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsUsageInStreaming: false,
    supportsStrictMode: false,
    supportsLongCacheRetention: false,
    maxTokensField: "max_tokens",
  },
} : (() => {
  const builtin = getModel(provider as never, modelId as never) as Model<"openai-completions"> | undefined
  if (!builtin) throw new Error(`Pi 未内置模型: ${provider}/${modelId}。自定义 API 请设置 .env 中的 API-KEY 和 MODEL，脚本会自动使用 ${provider} 的 API endpoint（当前推断: ${baseUrl ?? "未知"}）`)
  return {
    ...builtin,
    contextWindow: Math.min(builtin.contextWindow, Number(process.env.CTF_MODEL_CONTEXT_WINDOW ?? 16_000)),
    maxTokens: Math.min(builtin.maxTokens, Number(process.env.CTF_MODEL_MAX_TOKENS ?? 4_096)),
    reasoning: thinkingEnabledFromEnv(),
    compat: {
      ...builtin.compat,
      supportsDeveloperRole: false,
    },
  }
})()

const root = resolve(import.meta.dirname)
let project: Project | undefined
let solver: Awaited<ReturnType<Project["createSolver"]>> | undefined

try {
  console.log("\n[1/4] 打开 Mock CTF Project")
  project = await Project.open({ root, platforms: [mockPlatform] })

  console.log("[2/4] 创建 warmup-flag 的独立 Docker Solver")
  solver = await project.createSolver("warmup-flag", {
    source: "test",
    agent: {
      streamFn: streamSimple as AgentOptions["streamFn"],
      getApiKey: (requestedProvider) => requestedProvider === provider ? apiKey : undefined,
      initialState: {
        model,
        thinkingLevel: thinkingLevelFromEnv(),
        systemPrompt: [
          "你是 CTF Solver；所有命令和文件操作必须使用 Docker sandbox tools。",
          "请始终使用中文进行思考和推理（reasoning 输出中文）。",
          "开始时必须调用 ctf_blackboard_read 查看共享知识。",
          "必须先调用 ctf_challenge_info，使用 ctf_download_attachment 下载附件，使用 read 读取附件。",
          "必须使用 bash 解码附件，使用 ctf_blackboard_record 记录解码结果，最后调用 ctf_submit_flag。",
        ].join("\n"),
      },
    },
    compaction: true,
  })

  solver.subscribe((event) => {
    if (event.type === "tool_execution_start") console.log(`  → ${event.toolName}(${JSON.stringify(event.args)})`)
    if (event.type === "tool_execution_end") console.log(`  ${event.isError ? "×" : "✓"} ${JSON.stringify(event.result)}`)
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      process.stdout.write(event.assistantMessageEvent.delta)
    }
  })

  console.log(`[3/4] 交给 ${provider}/${modelId} Agent 解题\n`)
  await solver.prompt([
    "解决当前 CTF 题目。严格完成黑板读取、题目信息、附件下载、read 读取、bash 分析、黑板记录和 Flag 提交的完整工具链。"
  ].join("\n"))
  await solver.waitForIdle()

  const assistantErrors = solver.state.messages
    .filter((message) => message.role === "assistant" && message.stopReason === "error")
    .map((message) => "errorMessage" in message ? message.errorMessage : undefined)
    .filter(Boolean)
  if (assistantErrors.length > 0) throw new Error(`模型调用失败: ${assistantErrors.join("; ")}`)

  const toolCalls = solver.state.messages
    .filter((message) => message.role === "assistant")
    .flatMap((message) => message.content)
    .filter((content) => content.type === "toolCall")
    .map((content) => (content as { name: string }).name)
  const requiredTools = [
    "ctf_blackboard_read",
    "ctf_challenge_info",
    "ctf_download_attachment",
    "read",
    "bash",
    "ctf_blackboard_record",
    "ctf_submit_flag",
  ]
  const missing = requiredTools.filter((name) => !toolCalls.includes(name))
  if (missing.length > 0) throw new Error(`Agent 未完成要求的工具调用: ${missing.join(", ")}`)

  const accepted = solver.state.messages.some((message) => {
      if (message.role !== "toolResult" || message.toolName !== "ctf_submit_flag") return false
      const status = ("details" in message
        ? message.details
        : undefined) as { status?: string } | undefined
      return status?.status === "accepted" || status?.status === "already_solved"
    })
  if (!accepted) throw new Error("Agent 未成功提交 Flag")

  const blackboard = project.blackboard("warmup-flag")
  if (blackboard.evidence.length < 2) {
    throw new Error("Agent 未将解题结果持久化到黑板")
  }
  await access(join(solver.workspace, "attachments", "flag.txt"))

  console.log("\n[4/4] 成功：附件已保留在 workspace，Flag 已被接受。")
} catch (error) {
  console.error(`\n全链路失败：${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
} finally {
  await solver?.close()
  await project?.close()
}
