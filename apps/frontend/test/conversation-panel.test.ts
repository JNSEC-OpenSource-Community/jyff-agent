// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { createElement } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { INITIAL_AGENT_ACTIVITY } from "../src/lib/conversation-stream.ts"
import {
  ConversationPanel,
  type ConversationViewStateStore,
} from "../src/pages/challenge/ConversationPanel.tsx"

const initialMessage = {
  entryId: "message-1",
  timestamp: "2026-08-09T10:00:00.000Z",
  message: {
    role: "user" as const,
    content: "existing message",
    timestamp: 1,
  },
}
let mockMessages = [initialMessage]

vi.mock("../src/hooks/useConversation.ts", () => ({
  useConversation: () => ({
    conversation: {
      messages: mockMessages,
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

beforeEach(() => {
  mockMessages = [initialMessage]
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

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
    const button = screen.getByRole("button", { name: "回到底部" })
    expect(button.className).toContain("size-9")
    expect(button.className).toContain("opacity-80")
    expect(button.className).toContain("animate-in")
    expect(button.textContent).toBe("")
    expect(button.parentElement?.className).toContain("justify-center")
    fireEvent.click(button)

    expect(scrollTo).toHaveBeenCalledWith({ top: 1_000, behavior: "smooth" })
    expect(screen.queryByRole("button", { name: "回到底部" })).toBeNull()
  })

  it("有新内容时只显示数量徽标", () => {
    const props = {
      target: { type: "solver" as const },
      attempt: 1,
      runStatus: "running" as const,
      hasConversation: true,
      conversationUrl: "/conversation",
      streamUrl: "/events",
      sendUrl: "/message",
      onChanged: async () => {},
    }
    const { container, rerender } = render(
      createElement(ConversationPanel, props),
    )
    const scroller = container.querySelector<HTMLDivElement>(".overflow-y-auto")
    if (!scroller) throw new Error("conversation scroller missing")
    Object.defineProperties(scroller, {
      scrollHeight: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 400 },
      scrollTop: { configurable: true, writable: true, value: 100 },
    })
    fireEvent.scroll(scroller)

    mockMessages = [
      initialMessage,
      {
        ...initialMessage,
        entryId: "message-2",
        message: { ...initialMessage.message, content: "new message" },
      },
    ]
    rerender(createElement(ConversationPanel, props))

    const button = screen.getByRole("button", {
      name: "回到底部，1 条新内容",
    })
    expect(button.textContent).toBe("1")
    expect(screen.queryByText("1 条新内容")).toBeNull()
  })

  it("切换 Agent 后恢复各自的浏览位置", () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    })
    const flushFrames = () => {
      act(() => {
        for (const callback of frames.splice(0)) callback(0)
      })
    }
    const store: ConversationViewStateStore = new Map()
    const { container, rerender } = render(conversation("solver", store))
    let scroller = configureScroller(container, 240)
    flushFrames()
    scroller.scrollTop = 240
    fireEvent.scroll(scroller)

    rerender(conversation("worker-1", store))
    expect(store.get("solver")?.scrollTop).toBe(240)
    scroller = configureScroller(container, 120)
    flushFrames()
    scroller.scrollTop = 120
    fireEvent.scroll(scroller)

    rerender(conversation("solver", store))
    scroller = configureScroller(container, 0)
    flushFrames()

    expect(scroller.scrollTop).toBe(240)
    expect(screen.getByRole("button", { name: "回到底部" })).toBeTruthy()
  })
})

function conversation(viewKey: string, store: ConversationViewStateStore) {
  return createElement(ConversationPanel, {
    key: viewKey,
    target: { type: "solver" },
    attempt: 1,
    runStatus: "running",
    hasConversation: true,
    conversationUrl: `/${viewKey}/conversation`,
    streamUrl: `/${viewKey}/events`,
    sendUrl: `/${viewKey}/message`,
    viewKey,
    viewStateStore: store,
    onChanged: async () => {},
  })
}

function configureScroller(container: HTMLElement, scrollTop: number) {
  const scroller = container.querySelector<HTMLDivElement>(".overflow-y-auto")
  if (!scroller) throw new Error("conversation scroller missing")
  Object.defineProperties(scroller, {
    scrollHeight: { configurable: true, value: 1_000 },
    clientHeight: { configurable: true, value: 400 },
    scrollTop: { configurable: true, writable: true, value: scrollTop },
  })
  return scroller
}
