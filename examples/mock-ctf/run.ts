import { access } from "node:fs/promises"
import { join, resolve } from "node:path"
import { getModel, streamSimple, type Model } from "@earendil-works/pi-ai/compat"
import { Project } from "@ctf-agent/solver"
import { mockPlatform } from "@ctf-agent/platform-mock"

const modelId = process.env.OPENROUTER_MODEL ?? "cohere/north-mini-code:free"
const apiKey = process.env.OPENROUTER_API_KEY
if (!apiKey) throw new Error("请设置 OPENROUTER_API_KEY；此脚本不会读取或保存任何凭据文件")

const builtin = getModel("openrouter", modelId as never) as Model<any> | undefined
if (!builtin) throw new Error(`Pi 未内置 OpenRouter 模型: ${modelId}`)

// 免费模型会报告过大的窗口；显式上限避免 OpenRouter 按巨量 max_tokens 拒绝请求。
const model = {
  ...builtin,
  contextWindow: 16_000,
  maxTokens: 4_096,
  reasoning: false,
  compat: {
    ...builtin.compat,
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
  },
}

const root = resolve(import.meta.dirname)
let project: Project | undefined
let solver: Awaited<ReturnType<Project["createSolver"]>> | undefined

try {
  console.log("\n[1/4] 打开 Mock CTF Project")
  project = await Project.open({ root, platforms: [mockPlatform] })

  console.log("[2/4] 创建 warmup-flag 的独立 Docker Solver")
  solver = await project.createSolver("warmup-flag", {
    agent: {
      streamFn: streamSimple,
      getApiKey: (provider) => provider === "openrouter" ? apiKey : undefined,
      initialState: {
        model,
        thinkingLevel: "off",
        systemPrompt: "你是 CTF Solver；所有命令和文件操作必须使用 Docker sandbox tools。",
      },
    },
    compaction: { reserveTokens: 3_000, keepRecentTokens: 8_000 },
  })

  solver.subscribe((event) => {
    if (event.type === "tool_execution_start") console.log(`  → ${event.toolName}(${JSON.stringify(event.args)})`)
    if (event.type === "tool_execution_end") console.log(`  ${event.isError ? "×" : "✓"} ${JSON.stringify(event.result)}`)
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      process.stdout.write(event.assistantMessageEvent.delta)
    }
  })

  console.log("[3/4] 交给 OpenRouter Agent 解题\n")
  await solver.prompt([
    "解决当前 CTF 题目。"
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
  const requiredTools = ["ctf_challenge_info", "ctf_download_attachment", "read", "ctf_submit_flag"]
  const missing = requiredTools.filter((name) => !toolCalls.includes(name))
  if (missing.length > 0) throw new Error(`Agent 未完成要求的工具调用: ${missing.join(", ")}`)

  const submissions = solver.state.messages
    .filter((message) => message.role === "toolResult" && message.toolName === "ctf_submit_flag")
    .map((message) => JSON.stringify(message))
  await access(join(solver.workspace, "attachments", "flag.txt"))

  console.log("\n[4/4] 成功：附件已保留在 workspace，Flag 已被接受。")
} catch (error) {
  console.error(`\n全链路失败：${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
} finally {
  await solver?.close()
  await project?.close()
}
