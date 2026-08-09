// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react"
import { createElement } from "react"
import { describe, expect, it, vi } from "vitest"
import { INITIAL_AGENT_ACTIVITY } from "../src/lib/conversation-stream.ts"
import { ConversationPanel } from "../src/pages/challenge/ConversationPanel.tsx"

vi.mock("../src/hooks/useConversation.ts", () => ({
  useConversation: () => ({
    conversation: {
      messages: [
        {
          entryId: "message-1",
          timestamp: "2026-08-09T10:00:00.000Z",
          message: {
            role: "user",
            content: "existing message",
            timestamp: 1,
          },
        },
      ],
    },
    loading: false,
    error: "",
    message: "",
    sending: false,
    activity: { ...INITIAL_AGENT_ACTIVITY, connection: "connected" },
    setMessage: vi.fn(),
    send: vi.fn(),
  }),
}))

describe("ConversationPanel scroll affordance", () => {
  it("离开底部时显示悬浮按钮并可平滑回到底部", () => {
    const { container } = render(
      createElement(ConversationPanel, {
        target: { type: "solver" },
        attempt: 1,
        runStatus: "running",
        hasConversation: true,
        conversationUrl: "/conversation",
        streamUrl: "/events",
        sendUrl: "/message",
        onChanged: async () => {},
      }),
    )
    const scroller = container.querySelector<HTMLDivElement>(".overflow-y-auto")
    if (!scroller) throw new Error("conversation scroller missing")
    Object.defineProperties(scroller, {
      scrollHeight: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 400 },
      scrollTop: { configurable: true, writable: true, value: 100 },
    })
    const scrollTo = vi.fn()
    scroller.scrollTo = scrollTo

    fireEvent.scroll(scroller)
    fireEvent.click(screen.getByRole("button", { name: "回到底部" }))

    expect(scrollTo).toHaveBeenCalledWith({ top: 1_000, behavior: "smooth" })
    expect(screen.queryByRole("button", { name: "回到底部" })).toBeNull()
  })
})
