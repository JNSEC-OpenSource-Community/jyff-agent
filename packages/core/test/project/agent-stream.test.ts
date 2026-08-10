import type { AgentMessage } from "@earendil-works/pi-agent-core"
import { describe, expect, it } from "vitest"
import { appendAgentMessageDelta } from "../../src/project/agent-stream.ts"

describe("appendAgentMessageDelta", () => {
  it("按 contentIndex 累积 thinking 增量且不修改原消息", () => {
    const original = assistantMessage([
      { type: "thinking", thinking: "先检查", redacted: false },
      { type: "text", text: "" },
    ])

    const updated = appendAgentMessageDelta(
      original,
      0,
      "thinking",
      " ELF header",
    )

    expect(updated).not.toBe(original)
    expect(updated).toMatchObject({
      content: [
        { type: "thinking", thinking: "先检查 ELF header" },
        { type: "text", text: "" },
      ],
    })
    expect(original).toMatchObject({
      content: [
        { type: "thinking", thinking: "先检查" },
        { type: "text", text: "" },
      ],
    })
  })

  it("缺少目标 block 时创建对应的增量 block", () => {
    const updated = appendAgentMessageDelta(
      assistantMessage([]),
      0,
      "thinking",
      "恢复内容",
    )

    expect(updated).toMatchObject({
      content: [{ type: "thinking", thinking: "恢复内容" }],
    })
  })
})

function assistantMessage(
  content: Extract<AgentMessage, { role: "assistant" }>["content"],
): AgentMessage {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "test",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1,
  }
}
