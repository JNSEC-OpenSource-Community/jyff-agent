// @vitest-environment jsdom

import type { AgentMessage } from "@earendil-works/pi-agent-core"
import { render, screen, waitFor } from "@testing-library/react"
import { createElement } from "react"
import { describe, expect, it } from "vitest"
import { MessageBody } from "../src/pages/challenge/MessageBody.tsx"

describe("MessageBody", () => {
  it("默认展开短小工具结果并保持大型结果折叠", () => {
    const { unmount } = render(
      createElement(MessageBody, { message: toolResult("flag found") }),
    )
    expect(
      screen
        .getByRole("button", { name: /终端命令 · 返回/ })
        .getAttribute("aria-expanded"),
    ).toBe("true")

    unmount()
    render(createElement(MessageBody, { message: toolResult("x".repeat(600)) }))
    expect(
      screen
        .getByRole("button", { name: /终端命令 · 返回/ })
        .getAttribute("aria-expanded"),
    ).toBe("false")
  })

  it("流式推理默认展开并在下一条消息进入后收缩", async () => {
    const message = thinkingMessage()
    const { rerender } = render(
      createElement(MessageBody, { message, streaming: true, latest: true }),
    )
    const trigger = screen.getByRole("button", { name: /正在推理/ })
    expect(trigger.getAttribute("aria-expanded")).toBe("true")

    rerender(
      createElement(MessageBody, { message, streaming: false, latest: true }),
    )
    expect(
      screen
        .getByRole("button", { name: /推理记录/ })
        .getAttribute("aria-expanded"),
    ).toBe("true")

    rerender(
      createElement(MessageBody, { message, streaming: false, latest: false }),
    )
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: /推理记录/ })
          .getAttribute("aria-expanded"),
      ).toBe("false"),
    )
  })

  it("使用 Markdown 渲染推理记录", () => {
    render(
      createElement(MessageBody, {
        message: thinkingMessage(),
        streaming: true,
        latest: true,
      }),
    )
    expect(screen.getByText("关键假设").tagName).toBe("STRONG")
  })
})

function toolResult(text: string): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: "tool-1",
    toolName: "bash",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 1,
  }
}

function thinkingMessage(): AgentMessage {
  return {
    role: "assistant",
    content: [
      {
        type: "thinking",
        thinking: "**关键假设**\n\n```python\nprint('test')\n```",
        redacted: false,
      },
    ],
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
