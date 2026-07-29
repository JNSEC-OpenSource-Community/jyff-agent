import type { AgentMessage, AgentState } from "@earendil-works/pi-agent-core"
import { describe, expect, it } from "vitest"
import { compactMessages, findCompactionCut, serializeForCompaction, shouldCompact } from "../../src/agent/compaction.js"

const timestamp = 1
const user = (text: string) => ({ role: "user", content: text, timestamp }) as AgentMessage
const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }], timestamp, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }) as AgentMessage
const toolResult = (text: string) => ({ role: "toolResult", toolCallId: "call", toolName: "bash", content: [{ type: "text", text }], details: {}, isError: false, timestamp }) as AgentMessage
const model = { contextWindow: 100 } as AgentState["model"]

describe("Context compaction", () => {
  it("只在 user turn 边界截断，不会让 tool result 脱离其发起 turn", () => {
    const messages = [user("old"), assistant("result"), toolResult("tool output"), user("new"), assistant("latest")]
    expect(findCompactionCut(messages, 3)).toBe(3)
  })

  it("摘要旧消息、保留最近完整 turn，并可被 Pi convertToLlm 转换", async () => {
    const messages = [user("old ".repeat(500)), assistant("found a clue"), toolResult("x".repeat(500)), user("new task"), assistant("latest")]
    const compacted = await compactMessages(
      { model, thinkingLevel: "off", messages },
      { keepRecentTokens: 40, summarize: async (conversation) => `summary:${conversation.slice(0, 12)}` },
    )
    expect(compacted?.[0]).toMatchObject({ role: "ctf_compaction", summary: expect.stringContaining("summary") })
    expect(compacted?.slice(1)).toEqual(messages.slice(3))
  })

  it("手动压缩即使历史未超过自动阈值也能生成摘要", async () => {
    const messages = [user("one"), assistant("done")]
    const compacted = await compactMessages(
      { model, thinkingLevel: "off", messages },
      { summarize: async () => "manual summary" },
      undefined,
      "focus on findings",
      true,
    )
    expect(compacted).toHaveLength(1)
    expect(compacted?.[0]).toMatchObject({ role: "ctf_compaction", summary: "manual summary" })
  })

  it("小上下文窗口使用比例 reserve，而不是 16k 默认值导致永久压缩", () => {
    const state = { model, messages: [user("x".repeat(400))] }
    expect(shouldCompact(state)).toBe(true)
    expect(shouldCompact({ ...state, messages: [user("short")] })).toBe(false)
  })

  it("序列化时截断巨大 tool result，避免摘要请求被输出淹没", () => {
    const text = serializeForCompaction([toolResult("x".repeat(2_100))])
    expect(text).toContain("[truncated 100 chars]")
    expect(text.length).toBeLessThan(2_200)
  })
})
