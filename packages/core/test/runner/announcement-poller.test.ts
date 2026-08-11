import { afterEach, describe, expect, it, vi } from "vite-plus/test"
import { AnnouncementPoller } from "../../src/orchestration/announcement-poller.ts"

afterEach(() => {
  vi.useRealTimers()
})

describe("AnnouncementPoller", () => {
  it("never overlaps polls and stops future timers", async () => {
    vi.useFakeTimers()
    let release: (() => void) | undefined
    const poll = vi.fn(
      async () =>
        await new Promise<void>((resolve) => {
          release = resolve
        }),
    )
    const poller = new AnnouncementPoller({ intervalMs: 1_000, poll })
    poller.start()

    await vi.advanceTimersByTimeAsync(1_000)
    expect(poll).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(poll).toHaveBeenCalledTimes(1)
    release?.()
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(poll).toHaveBeenCalledTimes(2)

    poller.stop()
    release?.()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(poll).toHaveBeenCalledTimes(2)
  })

  it("backs off after failure and returns to the normal interval", async () => {
    vi.useFakeTimers()
    const poll = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValue(undefined)
    const onError = vi.fn()
    const poller = new AnnouncementPoller({
      intervalMs: 1_000,
      maximumBackoffMs: 8_000,
      poll,
      onError,
    })
    poller.start()

    await vi.advanceTimersByTimeAsync(1_000)
    expect(onError).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1_999)
    expect(poll).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(poll).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(poll).toHaveBeenCalledTimes(3)
    poller.stop()
  })
})
