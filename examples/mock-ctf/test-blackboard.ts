/**
 * 黑板系统功能测试脚本
 *
 * 测试流程：
 *   1. 创建 Project 和 Solver（使用 .env 中的真实模型）
 *   2. Agent 读取黑板（验证 origin 已自动创建）
 *   3. Agent 记录多条 evidence
 *   4. Agent 声明一个 multi-source opportunity
 *   5. Agent 结论该 opportunity（同时产出新 evidence）
 *   6. Agent 再次读取黑板验证完整状态
 *
 * 运行: pnpm --filter @ctf-agent/example-mock-ctf test:blackboard
 */

import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import type { AgentOptions } from "@earendil-works/pi-agent-core"
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions"
import { getModel, type Model } from "@earendil-works/pi-ai/compat"
import { Project, serializeBlackboard } from "@ctf-agent/solver"
import { mockPlatform } from "@ctf-agent/platform-mock"

// ── 加载 .env ──
function loadEnvFile(): void {
  const candidates = [
    resolve(import.meta.dirname, "..", "..", ".env"),
    resolve(process.cwd(), ".env"),
  ]
  for (const path of candidates) {
    if (!existsSync(path)) continue
    const content = readFileSync(path, "utf-8")
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("#")) continue
      const m = /^([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*"?([^"#]*?)"?\s*(?:#.*)?$/.exec(trimmed)
      if (!m) continue
      if (process.env[m[1]!]) continue
      process.env[m[1]!] = m[2]!
    }
    return
  }
}
loadEnvFile()

const apiKey = process.env.CTF_MODEL_API_KEY ?? process.env.OPENROUTER_API_KEY
const modelId = process.env.CTF_MODEL_ID ?? process.env.OPENROUTER_MODEL
const provider = process.env.CTF_MODEL_PROVIDER ?? "openrouter"
const baseUrl = process.env.CTF_MODEL_BASE_URL

if (!apiKey || !modelId) {
  console.error("请配置 .env 文件（参考 .env.example）：设置 CTF_MODEL_API_KEY 和 CTF_MODEL_ID")
  process.exit(1)
}

const model: Model<"openai-completions"> = baseUrl ? {
  id: modelId, name: modelId, api: "openai-completions", provider,
  baseUrl: baseUrl.replace(/\/+$/, ""), reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: Number(process.env.CTF_MODEL_CONTEXT_WINDOW ?? 64_000),
  maxTokens: Number(process.env.CTF_MODEL_MAX_TOKENS ?? 4_096),
  compat: {
    supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false,
    supportsUsageInStreaming: false, supportsStrictMode: false, supportsLongCacheRetention: false,
    maxTokensField: "max_tokens",
  },
} : (() => {
  const builtin = getModel(provider as never, modelId as never) as Model<"openai-completions"> | undefined
  if (!builtin) throw new Error(`模型 ${provider}/${modelId} 未在 Pi 中找到`)
  return { ...builtin, ...(Number(process.env.CTF_MODEL_CONTEXT_WINDOW) ? { contextWindow: Number(process.env.CTF_MODEL_CONTEXT_WINDOW) } : {}), reasoning: false }
})()

// ── 测试 ──
const root = resolve(import.meta.dirname)
let project: Project | undefined
let solver: Awaited<ReturnType<Project["createSolver"]>> | undefined

async function main() {
  // ── 阶段 1：创建 Project ──
  console.log("\n══════════════════════════════════════════")
  console.log("  黑板系统功能测试")
  console.log("══════════════════════════════════════════")
  console.log(`  模型: ${provider}/${modelId}`)

  project = await Project.open({ root, platforms: [mockPlatform] })
  console.log("\n[阶段 1] 创建 Solver（含黑板 origin 自动创建）")

  solver = await project.createSolver("warmup-flag", {
    source: "test",
    agent: {
      streamFn: streamSimple as AgentOptions["streamFn"],
      getApiKey: () => apiKey!,
      initialState: {
        model,
        thinkingLevel: "off",
        systemPrompt: [
          "You are testing the CTF blackboard system.",
          "",
          "Follow these steps EXACTLY in order:",
          "",
          "Step 1: Call ctf_blackboard_read. You should see an origin evidence with title 'Warmup Flag'.",
          "",
          "Step 2: Call ctf_blackboard_record to add TWO pieces of evidence:",
          "  evidence: { description: '附件 flag.txt 是 base64 编码的文本文件' }",
          "  (make this a separate call)",
          "  evidence: { description: '解码后内容为 MOCK{platform-plugin-works}' }",
          "",
          "Step 3: Call ctf_blackboard_record to declare an opportunity:",
          "  opportunity: { description: '分析 flag.txt 的编码方式', sourceEvidenceIds: [use the id from step 1 origin] }",
          "",
          "Step 4: Call ctf_blackboard_record to conclude that opportunity:",
          "  concludeOpportunity: { opportunityId: [use the id from step 3], resultDescription: 'flag.txt 使用标准 base64 编码，解码后得到 Flag' }",
          "",
          "Step 5: Call ctf_blackboard_read again to verify everything was recorded.",
          "",
          "Step 6: Output the exact text 'ALL_BLACKBOARD_TESTS_PASSED'",
          "",
          "Important: Each step MUST be completed before moving to the next.",
          "Use exact IDs from the tool responses.",
        ].join("\n"),
      },
    },
    compaction: false,
  })

  // ── 阶段 2：运行 Agent ──
  console.log("\n[阶段 2] Agent 执行黑板操作序列\n")

  let toolCount = 0
  solver.subscribe((event) => {
    if (event.type === "tool_execution_start") {
      toolCount++
      const args = JSON.stringify(event.args)
      const short = args.length > 120 ? args.slice(0, 120) + "..." : args
      console.log(`  [${toolCount}] → ${event.toolName}(${short})`)
    }
    if (event.type === "tool_execution_end") {
      const tag = event.isError ? "✗" : "✓"
      const resultStr = JSON.stringify(event.result)
      const short = resultStr.length > 200 ? resultStr.slice(0, 200) + "..." : resultStr
      console.log(`       ${tag} ${short}`)
    }
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      process.stdout.write(event.assistantMessageEvent.delta)
    }
  })

  await solver.prompt("Complete all steps from your system prompt.")
  await solver.waitForIdle()

  // ── 阶段 3：验证 ──
  console.log("\n\n[阶段 3] 验证结果")

  const toolCalls = solver.state.messages
    .filter((m) => m.role === "assistant")
    .flatMap((m) => m.content)
    .filter((c) => c.type === "toolCall")
    .map((c) => (c as { name: string }).name)

  const finalText = solver.state.messages
    .filter((m) => m.role === "assistant")
    .flatMap((m) => m.content)
    .filter((c) => c.type === "text")
    .map((c) => (c as { text: string }).text)
    .join(" ")

  const blackboardReads = toolCalls.filter((t) => t === "ctf_blackboard_read")
  const blackboardRecords = toolCalls.filter((t) => t === "ctf_blackboard_record")

  let passed = 0
  let failed = 0

  function check(label: string, condition: boolean): void {
    if (condition) { console.log(`  ✓ ${label}`); passed++ }
    else { console.log(`  ✗ ${label}`); failed++ }
  }

  check("至少调用 2 次 ctf_blackboard_read", blackboardReads.length >= 2)
  check("至少调用 3 次 ctf_blackboard_record", blackboardRecords.length >= 3)
  check("Agent 输出包含 ALL_BLACKBOARD_TESTS_PASSED", finalText.includes("ALL_BLACKBOARD_TESTS_PASSED"))
  check("至少调用了 5 次工具", toolCount >= 5)

  // 验证实际持久化内容，而不只检查工具是否被调用。
  const runs = project.runs()
  const blackboard = project.blackboard("warmup-flag")
  check("黑板测试 Run 已持久化", runs.some((r) => r.challengeId === "warmup-flag"))
  check(
    "两条 Agent Evidence 已持久化",
    blackboard.evidence.some((e) => e.description === "附件 flag.txt 是 base64 编码的文本文件") &&
      blackboard.evidence.some((e) => e.description === "解码后内容为 MOCK{platform-plugin-works}"),
  )
  check(
    "Opportunity 已结论并关联结果 Evidence",
    blackboard.opportunities.some((o) => o.status === "concluded" && o.targetEvidenceId !== null),
  )

  console.log(`\n  通过: ${passed}  失败: ${failed}`)
  if (failed > 0) {
    console.log("\n  ⚠ 部分测试失败，请检查 Agent 输出")
    process.exitCode = 1
  } else {
    console.log("  ✓ 黑板系统功能测试全部通过")
  }
}

main().catch((error) => {
  console.error(`\n测试异常: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}).finally(async () => {
  await solver?.close().catch(() => {})
  await project?.close().catch(() => {})
})
