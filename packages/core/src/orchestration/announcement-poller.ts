export interface AnnouncementPollerOptions {
  intervalMs?: number
  maximumBackoffMs?: number
  poll: () => Promise<void>
  onError?: (error: unknown) => void
}

/** Non-overlapping recursive timer with bounded exponential failure backoff. */
export class AnnouncementPoller {
  private timer?: ReturnType<typeof setTimeout>
  private stopped = true
  private failureCount = 0

  constructor(private readonly options: AnnouncementPollerOptions) {
    const interval = options.intervalMs ?? 30_000
    if (!Number.isInteger(interval) || interval < 1_000) {
      throw new Error("announcement poll interval must be at least 1000ms")
    }
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.schedule(this.options.intervalMs ?? 30_000)
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }

  private schedule(delay: number): void {
    if (this.stopped) return
    this.timer = setTimeout(() => void this.run(), delay)
    this.timer.unref?.()
  }

  private async run(): Promise<void> {
    if (this.stopped) return
    const interval = this.options.intervalMs ?? 30_000
    try {
      await this.options.poll()
      this.failureCount = 0
      this.schedule(interval)
    } catch (error) {
      this.failureCount += 1
      this.options.onError?.(error)
      const maximum = this.options.maximumBackoffMs ?? interval * 16
      this.schedule(Math.min(maximum, interval * 2 ** Math.min(this.failureCount, 8)))
    }
  }
}
