import { describe, expect, it, vi } from "vitest"
import { readStreamUntil } from "./helpers.ts"

describe("readStreamUntil", () => {
  it("无任何 SSE 帧时在指定时限后取消 reader", async () => {
    vi.useFakeTimers()
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true
      },
    })

    try {
      const pending = readStreamUntil(stream, "event: snapshot", 50)
      const timedOut = expect(pending).rejects.toThrow(
        "SSE 超时：未等到 event: snapshot",
      )
      await vi.advanceTimersByTimeAsync(50)
      await timedOut
      expect(cancelled).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it("在匹配事件后返回已读取内容，并保持流可供后续读取", async () => {
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("event: snapshot\n\n"))
      },
      cancel() {
        cancelled = true
      },
    })

    await expect(readStreamUntil(stream, "event: snapshot")).resolves.toContain(
      "event: snapshot",
    )
    expect(cancelled).toBe(false)
  })
})
