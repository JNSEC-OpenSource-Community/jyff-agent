// @vitest-environment jsdom

import type { AgentStreamEvent, AgentStreamPayload } from "@ctf-agent/core"
import type { AgentMessage } from "@earendil-works/pi-agent-core"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { createElement, type ChangeEvent } from "react"
import type * as React from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test"
import { useConversation, type ConversationSource } from "../src/hooks/useConversation.ts"

const createdAt = "2026-08-09T10:00:00.000Z"

class FakeEventSource {
  static instances: FakeEventSource[] = []
  readonly listeners = new Map<string, Set<(event: Event) => void>>()
  readonly close = vi.fn()
  onerror: (() => void) | null = null

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, listener: (event: Event) => void): void {
    const listeners = this.listeners.get(type) ?? new Set()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  emit(type: string, data: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data } as MessageEvent<string>)
    }
  }

  fail(): void {
    this.onerror?.()
  }
}

describe("useConversation", () => {
  beforeEach(() => {
    vi.stubGlobal("EventSource", FakeEventSource)
    FakeEventSource.instances = []
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("加载权威对话，在 ready 后重新校准，并批量应用实时事件", async () => {
    let requestCount = 0
    const fetchMock = vi.fn<typeof fetch>(async (_input, _init) => {
      requestCount += 1
      return jsonResponse(requestCount === 1 ? conversation("saved") : conversation("reloaded"))
    })
    vi.stubGlobal("fetch", fetchMock)
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    })
    vi.stubGlobal("cancelAnimationFrame", vi.fn())

    render(
      createElement(ConversationProbe, {
        hasConversation: true,
        onChanged: vi.fn(async () => undefined),
      }),
    )

    expect((await screen.findByTestId("messages")).textContent).toContain("saved")
    const source = FakeEventSource.instances[0]
    if (!source) throw new Error("SSE connection was not created")

    act(() => source.emit("ready", ""))
    await waitFor(() => {
      expect(screen.getByTestId("messages").textContent).toContain("reloaded")
    })

    act(() => {
      source.emit(
        "agent_event",
        JSON.stringify(
          agentEvent(
            {
              type: "message_started",
              messageId: "message-1",
              message: assistantMessage("streaming"),
            },
            1,
          ),
        ),
      )
      source.emit(
        "agent_event",
        JSON.stringify(
          agentEvent(
            {
              type: "text_delta",
              messageId: "message-1",
              contentIndex: 0,
              delta: " answer",
            },
            2,
          ),
        ),
      )
      for (const callback of frames.splice(0)) callback(0)
    })

    expect(screen.getByTestId("messages").textContent).toContain("streaming answer")
    expect(screen.getByTestId("phase").textContent).toBe("responding")
    expect(screen.getByTestId("connection").textContent).toBe("connected")
  })

  it("忽略损坏帧，暴露重连状态，并发送去除首尾空格的消息", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      if (init?.method === "POST") return jsonResponse({})
      return jsonResponse({ messages: [] })
    })
    vi.stubGlobal("fetch", fetchMock)
    const onChanged = vi.fn(async () => undefined)

    render(
      createElement(ConversationProbe, {
        hasConversation: false,
        onChanged,
      }),
    )
    const source = FakeEventSource.instances[0]
    if (!source) throw new Error("SSE connection was not created")

    act(() => source.emit("agent_event", "not-json"))
    expect(screen.getByTestId("messages").textContent).toBe("")
    act(() => source.fail())
    expect(screen.getByTestId("connection").textContent).toBe("reconnecting")

    fireEvent.change(screen.getByRole("textbox", { name: "消息" }), {
      target: { value: "  检查认证边界  " },
    })
    fireEvent.click(screen.getByRole("button", { name: "发送" }))

    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce())
    expect(fetchMock).toHaveBeenCalledWith(
      "/send",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ message: "检查认证边界" }),
      }),
    )
    expect((screen.getByRole("textbox", { name: "消息" }) as HTMLInputElement).value).toBe("")
  })

  it("卸载时关闭 SSE 并取消尚未刷新的帧", () => {
    const cancelAnimationFrame = vi.fn()
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    })
    vi.stubGlobal("cancelAnimationFrame", cancelAnimationFrame)
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => jsonResponse({ messages: [] })),
    )

    const { unmount } = render(
      createElement(ConversationProbe, {
        hasConversation: false,
        onChanged: vi.fn(async () => undefined),
      }),
    )
    const source = FakeEventSource.instances[0]
    if (!source) throw new Error("SSE connection was not created")

    act(() =>
      source.emit(
        "agent_event",
        JSON.stringify(
          agentEvent({
            type: "message_started",
            messageId: "message-1",
            message: assistantMessage("pending"),
          }),
        ),
      ),
    )
    unmount()

    expect(source.close).toHaveBeenCalledOnce()
    expect(cancelAnimationFrame).toHaveBeenCalledOnce()
  })
})

function ConversationProbe({
  hasConversation,
  onChanged,
}: {
  hasConversation: boolean
  onChanged: () => Promise<void>
}): React.ReactElement {
  const source: ConversationSource = {
    conversationUrl: "/conversation",
    sendUrl: "/send",
    streamUrl: "/events",
    hasConversation,
  }
  const state = useConversation(source, onChanged)
  return createElement(
    "div",
    null,
    createElement(
      "output",
      { "data-testid": "messages" },
      state.conversation ? JSON.stringify(state.conversation) : "",
    ),
    createElement("output", { "data-testid": "phase" }, state.activity.phase),
    createElement("output", { "data-testid": "connection" }, state.activity.connection),
    createElement("output", { "data-testid": "loading" }, String(state.loading)),
    createElement("p", { role: "alert" }, state.error),
    createElement("input", {
      "aria-label": "消息",
      value: state.message,
      onChange: (event: ChangeEvent<HTMLInputElement>) => state.setMessage(event.target.value),
    }),
    createElement(
      "button",
      { type: "button", onClick: () => void state.send(state.message) },
      "发送",
    ),
  )
}

function conversation(text: string) {
  return {
    messages: [
      {
        entryId: `persisted:${text}`,
        timestamp: createdAt,
        message: assistantMessage(text),
      },
    ],
  }
}

function assistantMessage(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
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
    timestamp: Date.parse(createdAt),
  }
}

function agentEvent(payload: AgentStreamPayload, seq = 1): AgentStreamEvent {
  return {
    ...payload,
    runId: "run-1",
    seq,
    createdAt,
  } as AgentStreamEvent
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    headers: { "content-type": "application/json" },
  })
}
