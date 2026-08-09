import type {
  ChallengeCapability,
  ChallengeInfo,
  FlagSubmission,
  PlatformProject,
  RemoteEnvironment,
} from "@ctf-agent/platform"

export type RemoteEnvironmentPriority = "required" | "verification"

export interface RemoteEnvironmentLeaseRecord {
  runId: string
  challengeId: string
  environmentId: string
  priority: RemoteEnvironmentPriority
  acquiredAt: string
}

export interface RemoteEnvironmentLeaseStore {
  listEnvironmentLeases(): RemoteEnvironmentLeaseRecord[]
  saveEnvironmentLease(record: RemoteEnvironmentLeaseRecord): void
  deleteEnvironmentLease(runId: string): void
}

interface ManagedCapabilityOptions {
  runId: string
  challenge: ChallengeInfo
  capability: ChallengeCapability
  onRevoked?: (message: string) => Promise<void> | void
  onEvent?: (type: string, data?: unknown) => void
}

interface ActiveLease extends RemoteEnvironmentLeaseRecord {
  capability: NonNullable<ChallengeCapability["instance"]>
  environment: RemoteEnvironment
  onRevoked?: ManagedCapabilityOptions["onRevoked"]
  onEvent?: ManagedCapabilityOptions["onEvent"]
}

interface PendingRequest {
  runId: string
  challengeId: string
  priority: RemoteEnvironmentPriority
  capability: NonNullable<ChallengeCapability["instance"]>
  requestedAt: string
  onRevoked?: ManagedCapabilityOptions["onRevoked"]
  onEvent?: ManagedCapabilityOptions["onEvent"]
  resolve(environment: RemoteEnvironment): void
  reject(error: unknown): void
}

/** Project 级远程环境配额。Solver 只能通过题目绑定后的 capability 申请自己的租约。 */
export class RemoteEnvironmentCoordinator {
  private readonly active = new Map<string, ActiveLease>()
  private readonly pending: PendingRequest[] = []
  private lock: Promise<void> = Promise.resolve()
  private closed = false

  constructor(
    private maxConcurrent: number,
    private readonly store: RemoteEnvironmentLeaseStore,
  ) {
    validateMaximum(maxConcurrent)
  }

  manage(options: ManagedCapabilityOptions): ChallengeCapability {
    const { capability } = options
    const instance = capability.instance
    if (!instance) return capability
    const priority: RemoteEnvironmentPriority =
      options.challenge.attachments.length === 0 ? "required" : "verification"
    return {
      ...capability,
      submitFlag: async (flag): Promise<FlagSubmission> => {
        const submission = await capability.submitFlag(flag)
        if (
          submission.status === "accepted" ||
          submission.status === "already_solved"
        ) {
          try {
            await this.release(options.runId)
          } catch (error) {
            options.onEvent?.("environment_release_failed", {
              reason: "terminal_submission",
              error: errorText(error),
            })
          }
        }
        return submission
      },
      instance: {
        start: async (signal) =>
          await this.acquire({
            runId: options.runId,
            challengeId: options.challenge.id,
            priority,
            capability: instance,
            onRevoked: options.onRevoked,
            onEvent: options.onEvent,
            signal,
          }),
        status: async () => await this.status(options.runId, instance),
        destroy: async () => await this.release(options.runId),
      },
    }
  }

  async reconcile(platform: PlatformProject): Promise<string[]> {
    const failures: string[] = []
    for (const lease of this.store.listEnvironmentLeases()) {
      try {
        const capability = await platform.bindChallenge(lease.challengeId)
        await capability.instance?.destroy()
        this.store.deleteEnvironmentLease(lease.runId)
      } catch (error) {
        failures.push(
          `遗留远程环境 ${lease.challengeId}/${lease.environmentId} 回收失败: ${errorText(error)}`,
        )
      }
    }
    return failures
  }

  async setMaxConcurrent(maxConcurrent: number): Promise<void> {
    validateMaximum(maxConcurrent)
    await this.withLock(async () => {
      this.maxConcurrent = maxConcurrent
      while (this.active.size > this.maxConcurrent) {
        const victim = this.oldestVerificationLease()
        if (!victim) break
        await this.revoke(victim, "Project 远程环境配额已降低")
      }
      await this.pump()
    })
  }

  isWaiting(runId: string): boolean {
    return this.pending.some((request) => request.runId === runId)
  }

  async destroyEnvironment(environmentId: string): Promise<boolean> {
    return await this.withLock(async () => {
      const lease = [...this.active.values()].find(
        (candidate) => candidate.environmentId === environmentId,
      )
      if (!lease) return false
      await this.destroyLease(lease)
      await this.pump()
      return true
    })
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const error = abortError("远程环境协调器已关闭")
    for (const request of this.pending.splice(0)) request.reject(error)
    const failures: unknown[] = []
    await this.withLock(async () => {
      for (const lease of [...this.active.values()]) {
        try {
          await this.destroyLease(lease)
        } catch (cause) {
          failures.push(cause)
        }
      }
    })
    if (failures.length > 0)
      throw new AggregateError(failures, "远程环境回收不完整")
  }

  private async acquire(
    input: Omit<PendingRequest, "requestedAt" | "resolve" | "reject"> & {
      signal?: AbortSignal
    },
  ): Promise<RemoteEnvironment> {
    if (input.signal?.aborted) throw abortError("远程环境申请已取消")
    const result = await this.withLock(async () => {
      if (this.closed) throw abortError("远程环境协调器已关闭")
      const existing = this.active.get(input.runId)
      if (existing)
        return { kind: "ready" as const, environment: existing.environment }

      const alreadyPending = this.pending.find(
        (request) => request.runId === input.runId,
      )
      if (alreadyPending) {
        throw new Error(`Run ${input.runId} 已在等待远程环境`)
      }

      if (
        this.active.size >= this.maxConcurrent &&
        input.priority === "required"
      ) {
        const victim = this.oldestVerificationLease()
        if (victim) {
          await this.revoke(
            victim,
            "远程环境已让位给无附件且无法本地推进的题目；旧 endpoint 已失效，需要时可重新申请验证环境。",
          )
        }
      }
      if (this.active.size < this.maxConcurrent) {
        return {
          kind: "ready" as const,
          environment: await this.startLease(input, false),
        }
      }

      let resolve!: (environment: RemoteEnvironment) => void
      let reject!: (error: unknown) => void
      const promise = new Promise<RemoteEnvironment>((ok, fail) => {
        resolve = ok
        reject = fail
      })
      const request: PendingRequest = {
        ...input,
        requestedAt: new Date().toISOString(),
        resolve,
        reject,
      }
      delete (request as { signal?: AbortSignal }).signal
      this.pending.push(request)
      this.sortPending()
      input.onEvent?.("environment_waiting", {
        priority: input.priority,
        position: this.pending.indexOf(request) + 1,
      })
      return { kind: "waiting" as const, promise, request }
    })
    if (result.kind === "ready") return result.environment

    const onAbort = () => {
      void this.cancelPending(result.request, abortError("远程环境申请已取消"))
    }
    input.signal?.addEventListener("abort", onAbort, { once: true })
    if (input.signal?.aborted) onAbort()
    try {
      return await result.promise
    } finally {
      input.signal?.removeEventListener("abort", onAbort)
    }
  }

  private async cancelPending(
    request: PendingRequest,
    error: Error,
  ): Promise<void> {
    await this.withLock(async () => {
      const index = this.pending.indexOf(request)
      if (index < 0) return
      this.pending.splice(index, 1)
      request.reject(error)
    })
  }

  private async release(runId: string): Promise<void> {
    await this.withLock(async () => {
      const pendingIndex = this.pending.findIndex(
        (request) => request.runId === runId,
      )
      if (pendingIndex >= 0) {
        const [request] = this.pending.splice(pendingIndex, 1)
        request?.reject(abortError("远程环境申请已释放"))
      }
      const lease = this.active.get(runId)
      if (!lease) return
      await this.destroyLease(lease)
      await this.pump()
    })
  }

  private async status(
    runId: string,
    capability: NonNullable<ChallengeCapability["instance"]>,
  ): Promise<RemoteEnvironment | null> {
    if (!this.active.has(runId)) return null
    const environment = await capability.status()
    if (!environment || environment.status === "stopped") {
      await this.release(runId)
    }
    return environment
  }

  private async startLease(
    input: Omit<PendingRequest, "requestedAt" | "resolve" | "reject">,
    waited: boolean,
  ): Promise<RemoteEnvironment> {
    const environment = await input.capability.start()
    const lease: ActiveLease = {
      runId: input.runId,
      challengeId: input.challengeId,
      environmentId: environment.id,
      priority: input.priority,
      acquiredAt: new Date().toISOString(),
      capability: input.capability,
      environment,
      onRevoked: input.onRevoked,
      onEvent: input.onEvent,
    }
    this.active.set(input.runId, lease)
    this.store.saveEnvironmentLease(lease)
    input.onEvent?.("environment_acquired", {
      environmentId: environment.id,
      priority: input.priority,
      waited,
    })
    return environment
  }

  private async destroyLease(lease: ActiveLease): Promise<void> {
    await lease.capability.destroy()
    this.active.delete(lease.runId)
    this.store.deleteEnvironmentLease(lease.runId)
    lease.onEvent?.("environment_released", {
      environmentId: lease.environmentId,
    })
  }

  private async revoke(lease: ActiveLease, message: string): Promise<void> {
    await this.destroyLease(lease)
    lease.onEvent?.("environment_revoked", {
      environmentId: lease.environmentId,
      reason: message,
    })
    void Promise.resolve(lease.onRevoked?.(message)).catch(() => undefined)
  }

  private async pump(): Promise<void> {
    while (!this.closed && this.active.size < this.maxConcurrent) {
      const request = this.pending.shift()
      if (!request) return
      try {
        const environment = await this.startLease(request, true)
        request.resolve(environment)
      } catch (error) {
        request.reject(error)
      }
    }
  }

  private oldestVerificationLease(): ActiveLease | undefined {
    return [...this.active.values()]
      .filter((lease) => lease.priority === "verification")
      .sort((left, right) => left.acquiredAt.localeCompare(right.acquiredAt))[0]
  }

  private sortPending(): void {
    this.pending.sort((left, right) => {
      const priority =
        priorityRank(left.priority) - priorityRank(right.priority)
      return priority || left.requestedAt.localeCompare(right.requestedAt)
    })
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.lock
    let release!: () => void
    this.lock = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }
}

function priorityRank(priority: RemoteEnvironmentPriority): number {
  return priority === "required" ? 0 : 1
}

function validateMaximum(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 64) {
    throw new Error("maxRemoteEnvironments 必须是 1–64 的整数")
  }
}

function abortError(message: string): Error {
  return Object.assign(new Error(message), { name: "AbortError" })
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
