// @vitest-environment jsdom

import type { AgentMessage } from "@earendil-works/pi-agent-core"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { createElement } from "react"
import { describe, expect, it, vi } from "vitest"
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
    expect(
      trigger.querySelectorAll(".agent-thinking-wave > span"),
    ).toHaveLength(3)

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

  it("将 SubAgent 工具结果呈现为可跳转的 worker 通道", () => {
    const select = vi.fn()
    render(
      createElement(MessageBody, {
        message: {
          role: "toolResult",
          toolCallId: "tool-subagent",
          toolName: "Agent",
          content: [
            {
              type: "text",
              text: JSON.stringify({
                id: "worker-123456789",
                status: "running",
              }),
            },
          ],
          isError: false,
          timestamp: 1,
        },
        onSelectSubagent: select,
      }),
    )

    fireEvent.click(
      screen.getByRole("button", {
        name: "打开 SubAgent worker-123456789 对话",
      }),
    )
    expect(select).toHaveBeenCalledWith("worker-123456789")
  })

  it("把 wait 调用和结构化完成通知显示为 SubAgent 语义", () => {
    const select = vi.fn()
    const { unmount } = render(
      createElement(MessageBody, {
        message: assistantToolCall("get_subagent_result", {
          agent_id: "worker-wait",
          wait: true,
        }),
        onSelectSubagent: select,
      }),
    )
    expect(screen.getByText(/等待完成/)).toBeTruthy()
    expect(
      screen.getByRole("button", {
        name: "打开 SubAgent worker-wait 对话",
      }),
    ).toBeTruthy()

    unmount()
    render(
      createElement(MessageBody, {
        message: {
          role: "user",
          content:
            "<subagent_notification>\n  <id>worker-done</id>\n  <role>explorer</role>\n  <status>completed</status>\n  <output>offset &lt; 0x40</output>\n</subagent_notification>",
          timestamp: 1,
        },
        onSelectSubagent: select,
      }),
    )
    expect(screen.getByText("SubAgent 已回报")).toBeTruthy()
    expect(screen.getByText("offset < 0x40")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: /打开对话/ }))
    expect(select).toHaveBeenCalledWith("worker-done")
  })

  it("将 Blocked 收尾提示渲染为独立卡片而非 Active SubAgents", () => {
    render(
      createElement(MessageBody, {
        message: {
          role: "user",
          content:
            '<blocked_finalization>\n<active_subagents encoding="json">\n[]\n</active_subagents>\n\nThe investigation is now considered stuck.\n</blocked_finalization>',
          timestamp: 1,
        },
      }),
    )
    expect(screen.getByText("Blocked Finalization")).toBeTruthy()
    expect(
      screen.getByText(/investigation is now considered stuck/),
    ).toBeTruthy()
    expect(screen.queryByText("Active SubAgents")).toBeNull()
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

function assistantToolCall(
  name: string,
  args: Record<string, unknown>,
): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id: "tool-subagent", name, arguments: args }],
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
    stopReason: "toolUse",
    timestamp: 1,
  }
}
