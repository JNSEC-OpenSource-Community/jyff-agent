// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useConversation } from "../src/hooks/useConversation.ts"
import type { DashboardConversation } from "../src/types.ts"

const conversation: DashboardConversation = {
  messages: [
    {
      entryId: "e1",
      timestamp: "2024-06-01T00:00:00Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "你好" }],
        timestamp: "2024-06-01T00:00:00Z",
        entryId: "e1",
      } as unknown as DashboardConversation["messages"][number]["message"],
    },
  ],
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  })
}

describe("useConversation", () => {
  const fetchMock = vi.fn<typeof fetch>()

  beforeEach(() => {
    fetchMock.mockReset()
    globalThis.fetch = fetchMock as unknown as typeof fetch
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  const target = {
    conversationUrl: "/conv",
    sendUrl: "/send",
    hasConversation: true,
  }

  it("hasConversation 时加载对话", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(conversation))
    const onChanged = vi.fn()
    const { result } = renderHook(() => useConversation(target, onChanged))

    expect(result.current.loading).toBe(true)
    await waitFor(() => expect(result.current.conversation).not.toBeNull())
    expect(result.current.conversation?.messages).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledWith("/conv", undefined)
  })

  it("hasConversation=false 时不请求对话", () => {
    const { result } = renderHook(() =>
      useConversation({ ...target, hasConversation: false }, vi.fn()),
    )
    expect(result.current.conversation).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("发送消息后清空输入并重新加载对话", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(conversation)) // 初始加载
      .mockResolvedValueOnce(jsonResponse({ runId: "r1" })) // POST send
      .mockResolvedValueOnce(jsonResponse(conversation)) // 重新加载
    const onChanged = vi.fn().mockResolvedValue(undefined)
    const { result } = renderHook(() => useConversation(target, onChanged))

    await waitFor(() => expect(result.current.conversation).not.toBeNull())

    await act(async () => {
      await result.current.send("  补充指令  ")
    })

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/send",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ message: "补充指令" }),
      }),
    )
    expect(result.current.message).toBe("")
    expect(onChanged).toHaveBeenCalledOnce()
    expect(result.current.sending).toBe(false)
  })

  it("空白消息不发送", async () => {
    const { result } = renderHook(() => useConversation(target, vi.fn()))
    await act(async () => {
      await result.current.send("   ")
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("发送失败记录错误信息", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(conversation))
      .mockResolvedValueOnce(
        jsonResponse(
          { error: "no_active_run", message: "该题当前没有运行中的 Agent" },
          409,
        ),
      )
    const { result } = renderHook(() => useConversation(target, vi.fn()))
    await waitFor(() => expect(result.current.conversation).not.toBeNull())

    await act(async () => {
      await result.current.send("再试一次")
    })
    expect(result.current.error).toContain("没有运行中的 Agent")
    expect(result.current.message).toBe("再试一次")
  })

  it("对话加载失败时暴露错误", async () => {
    fetchMock.mockRejectedValueOnce(new Error("网络错误"))
    const { result } = renderHook(() => useConversation(target, vi.fn()))
    await waitFor(() => expect(result.current.error).toBe("网络错误"))
    expect(result.current.loading).toBe(false)
  })
})
