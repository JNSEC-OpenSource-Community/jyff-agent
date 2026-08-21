import { describe, expect, it, vi } from "vite-plus/test"
import { createProcessShutdown } from "../src/process-shutdown.ts"

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe("Agent 进程关闭协调器", () => {
  it("多个关闭来源共享同一次正常回收", async () => {
    const gate = deferred()
    const close = vi.fn(async () => await gate.promise)
    const lifecycle = createProcessShutdown({
      close,
      logger: { log: vi.fn(), error: vi.fn() },
      exit: vi.fn(),
    })

    const first = lifecycle.shutdown("SIGTERM")
    const second = lifecycle.shutdown("SIGINT")
    expect(first).toBe(second)
    expect(close).toHaveBeenCalledTimes(1)

    gate.resolve()
    await first
  })

  it("致命错误等待正常回收完成后才以失败状态退出", async () => {
    const gate = deferred()
    const exit = vi.fn()
    const logger = { log: vi.fn(), error: vi.fn() }
    const lifecycle = createProcessShutdown({
      close: async () => await gate.promise,
      logger,
      exit,
    })

    lifecycle.fatal("unhandledRejection", new Error("provider crashed"))
    await Promise.resolve()
    expect(exit).not.toHaveBeenCalled()

    gate.resolve()
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1))
    expect(logger.error).toHaveBeenCalledWith(
      "进程发生致命错误（unhandledRejection）",
      expect.any(Error),
    )
  })

  it("回收发生错误时仍记录失败并退出，不重复调用 close", async () => {
    const cleanupError = new Error("sandbox remove failed")
    const close = vi.fn(async () => {
      throw cleanupError
    })
    const exit = vi.fn()
    const logger = { log: vi.fn(), error: vi.fn() }
    const lifecycle = createProcessShutdown({ close, logger, exit })

    lifecycle.fatal("uncaughtException", new Error("boom"))
    lifecycle.fatal("unhandledRejection", new Error("second"))

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1))
    expect(close).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledTimes(1)
    expect(logger.error).toHaveBeenCalledWith("Agent 进程退出前的资源回收不完整", cleanupError)
  })
})
