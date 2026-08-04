import { describe, expect, it } from "vitest"
import {
  extractAssistantText,
  extractThinkingText,
  MAX_ASSISTANT_TEXT_CHARS,
  MAX_REASONING_CHARS,
} from "../../src/thinking.js"

describe("extractThinkingText(从 message_end 消息提取整 turn 思考块)", () => {
  it("多 thinking 块按 \\n 合并(整 turn 聚合,天然每 turn 一条)", () => {
    const message = {
      content: [
        { type: "thinking", thinking: "先分析附件格式" },
        { type: "text", text: "输出正文" },
        { type: "thinking", thinking: "再检查校验位" },
      ],
    }
    expect(extractThinkingText(message)).toBe("先分析附件格式\n再检查校验位")
  })

  it("无思考块返回空串(调用方跳过持久化)", () => {
    expect(extractThinkingText({ content: [] })).toBe("")
    expect(extractThinkingText({ content: [{ type: "text", text: "hi" }] })).toBe("")
  })

  it("content 缺失或非数组返回空串", () => {
    expect(extractThinkingText({})).toBe("")
    expect(extractThinkingText({ content: "plain string" })).toBe("")
  })

  it("单条思考超过 4KB 截断(保留开头,与旧自建通道约束一致)", () => {
    const long = "x".repeat(MAX_REASONING_CHARS + 100)
    const text = extractThinkingText({ content: [{ type: "thinking", thinking: long }] })
    expect(text.length).toBe(MAX_REASONING_CHARS)
    expect(text).toBe("x".repeat(MAX_REASONING_CHARS))
  })

  it("多块合计超过 4KB 时在合并结果上截断", () => {
    const half = "x".repeat(MAX_REASONING_CHARS - 100)
    const text = extractThinkingText({
      content: [
        { type: "thinking", thinking: half },
        { type: "thinking", thinking: "y".repeat(300) },
      ],
    })
    expect(text.length).toBe(MAX_REASONING_CHARS)
    // join 分隔符 \n 计入截断预算:3996 x + \n + 99 y
    expect(text.startsWith(half)).toBe(true)
    expect(text.endsWith("y".repeat(99))).toBe(true)
  })

  it("忽略非 thinking 块(文本/工具调用/图片)", () => {
    const message = {
      content: [
        { type: "text", text: "not thinking" },
        { type: "toolCall", id: "call_1", name: "bash", arguments: {} },
        { type: "image", mimeType: "image/png", data: "..." },
        { type: "thinking", thinking: "real thought" },
      ],
    }
    expect(extractThinkingText(message)).toBe("real thought")
  })
})

describe("extractAssistantText(从 message_end 提取 assistant 文本回复)", () => {
  it("提取 assistant 消息的文本块(整 turn 聚合)", () => {
    const message = {
      role: "assistant",
      content: [
        { type: "text", text: "附件是 ELF。" },
        { type: "thinking", thinking: "先看文件头" },
        { type: "text", text: "准备用 bash 分析。" },
      ],
    }
    expect(extractAssistantText(message)).toBe("附件是 ELF。\n准备用 bash 分析。")
  })

  it("跳过 user 消息与 toolResult 消息(message_end 也会对它们触发)", () => {
    expect(extractAssistantText({ role: "user", content: [{ type: "text", text: "人类消息" }] })).toBe("")
    expect(extractAssistantText({ role: "tool", content: [{ type: "text", text: "结果" }] })).toBe("")
    expect(extractAssistantText({ role: "assistant", content: [] })).toBe("")
    expect(extractAssistantText({ content: [{ type: "text", text: "无 role" }] })).toBe("")
  })

  it("单条文本超过 8KB 截断(保留开头)", () => {
    const long = "x".repeat(MAX_ASSISTANT_TEXT_CHARS + 100)
    const text = extractAssistantText({ role: "assistant", content: [{ type: "text", text: long }] })
    expect(text.length).toBe(MAX_ASSISTANT_TEXT_CHARS)
  })
})
