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

export interface RemoteEnvironmentCoordinatorOptions {
  /** Core-side wall-clock limit, including plugin polling and network requests. */
  startTimeoutMs?: number
  /** Bound status, destroy, reconciliation, and best-effort cleanup calls. */
  operationTimeoutMs?: number
}

/** Scheduler-owned permit used to park an Agent while its instance tool awaits external capacity. */
export interface RemoteEnvironmentExecutionGate {
  suspend(): void
  resume(signal?: AbortSignal): Promise<void>
}

interface ManagedCapabilityOptions {
  runId: string
  challenge: ChallengeInfo
  capability: ChallengeCapability
  onRevoked?: (message: string) => Promise<void> | void
  onEvent?: (type: string, data?: unknown) => void
  executionGate?: RemoteEnvironmentExecutionGate
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
  signal?: AbortSignal
  onRevoked?: ManagedCapabilityOptions["onRevoked"]
  onEvent?: ManagedCapabilityOptions["onEvent"]
  resolve(environment: RemoteEnvironment): void
  reject(error: unknown): void
}

interface StartingRequest {
  request: PendingRequest
  controller: AbortController
  startedAt: number
}

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

interface ReleaseOptions {
  revokedMessage?: string
}

const DEFAULT_START_TIMEOUT_MS = 4 * 60_000
const DEFAULT_OPERATION_TIMEOUT_MS = 30_000

/** Project 级远程环境配额。Solver 只能通过题目绑定后的 capability 申请自己的租约。 */
export class RemoteEnvironmentCoordinator {
  private readonly active = new Map<string, ActiveLease>()
  private readonly pending: PendingRequest[] = []
  private readonly starting = new Map<string, StartingRequest>()
  private readonly startTasks = new Map<string, Promise<void>>()
  private readonly releaseTasks = new Map<string, Promise<void>>()
  private readonly closeController = new AbortController()
  private readonly startTimeoutMs: number
  private readonly operationTimeoutMs: number
  private lock: Promise<void> = Promise.resolve()
  private closed = false

  constructor(
    private maxConcurrent: number,
    private readonly store: RemoteEnvironmentLeaseStore,
    options: RemoteEnvironmentCoordinatorOptions = {},
  ) {
    validateMaximum(maxConcurrent)
    this.startTimeoutMs = positiveDuration(
      options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS,
      "远程环境启动超时",
    )
    this.operationTimeoutMs = positiveDuration(
      options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS,
      "远程环境操作超时",
    )
  }

  manage(options: ManagedCapabilityOptions): ChallengeCapability {
    const { capability } = options
    const instance = capability.instance
    if (!instance) return capability
    const priority: RemoteEnvironmentPriority =
      options.challenge.attachments.length === 0 ? "required" : "verification"
    return {
      // capability 通常是适配器实例，方法位于原型而非可枚举自有属性。
      // 不能使用对象展开，否则会在容器题中丢失 downloadAttachment/getInfo。
      getInfo: async () => await capability.getInfo(),
      downloadAttachment: async (attachmentId) => await capability.downloadAttachment(attachmentId),
      submitFlag: async (flag): Promise<FlagSubmission> => {
        const submission = await capability.submitFlag(flag)
        if (submission.status === "accepted" || submission.status === "already_solved") {
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
        start: async (signal) => {
          options.executionGate?.suspend()
          let environment: RemoteEnvironment
          try {
            environment = await this.acquire({
              runId: options.runId,
              challengeId: options.challenge.id,
              priority,
              capability: instance,
              onRevoked: options.onRevoked,
              onEvent: options.onEvent,
              signal,
            })
          } finally {
            await options.executionGate?.resume(signal)
          }

          if (!options.executionGate) return environment

          // A required request may revoke a verification lease while its Solver is waiting to
          // reacquire execution capacity. Never return an endpoint that is already invalid.
          const current = await this.status(options.runId, instance)
          if (!current) throw environmentRevokedError()
          return current
        },
        status: async () => await this.status(options.runId, instance),
        destroy: async () => await this.release(options.runId),
      },
    }
  }

  async reconcile(platform: PlatformProject): Promise<string[]> {
    const failures: string[] = []
    for (const lease of this.store.listEnvironmentLeases()) {
      try {
        const capability = await withTimeout(
          platform.bindChallenge(lease.challengeId),
          this.operationTimeoutMs,
          "绑定遗留远程环境题目",
        )
        if (capability.instance) {
          await withTimeout(
            capability.instance.destroy(),
            this.operationTimeoutMs,
            "回收遗留远程环境",
          )
        }
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
    const victims = await this.withLock(async () => {
      this.maxConcurrent = maxConcurrent
      let excess = Math.max(0, this.occupiedSlots() - maxConcurrent)
      const startingVictims = [...this.starting.values()]
        .filter(({ request }) => request.priority === "verification")
        .sort((left, right) => left.startedAt - right.startedAt)
        .slice(0, excess)
      for (const starting of startingVictims) {
        starting.controller.abort(abortError("Project 远程环境配额已降低"))
      }
      excess -= startingVictims.length
      return this.verificationLeases().slice(0, excess)
    })
    await Promise.all(
      victims.map(async (victim) => {
        await this.releaseLease(victim, { revokedMessage: "Project 远程环境配额已降低" })
      }),
    )
    this.kickPump()
  }

  isWaiting(runId: string): boolean {
    return this.starting.has(runId) || this.pending.some((request) => request.runId === runId)
  }

  async destroyEnvironment(environmentId: string): Promise<boolean> {
    const lease = await this.withLock(async () =>
      [...this.active.values()].find((candidate) => candidate.environmentId === environmentId),
    )
    if (!lease) return false
    await this.releaseLease(lease)
    return true
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const error = abortError("远程环境协调器已关闭")
    this.closeController.abort(error)

    const active = await this.withLock(async () => {
      for (const request of this.pending.splice(0)) request.reject(error)
      for (const starting of this.starting.values()) starting.controller.abort(error)
      return [...this.active.values()]
    })

    const releases = active.map(async (lease) => await this.releaseLease(lease))
    const settled = await Promise.allSettled([...this.startTasks.values(), ...releases])
    const failures = settled
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason)
    if (failures.length > 0) throw new AggregateError(failures, "远程环境回收不完整")
  }

  private async acquire(
    input: Omit<PendingRequest, "requestedAt" | "resolve" | "reject">,
  ): Promise<RemoteEnvironment> {
    if (input.signal?.aborted) throw abortError("远程环境申请已取消")
    const deferred = createDeferred<RemoteEnvironment>()
    const request: PendingRequest = {
      ...input,
      requestedAt: new Date().toISOString(),
      resolve: (environment) => deferred.resolve(environment),
      reject: (error) => deferred.reject(error),
    }
    let existing: RemoteEnvironment | undefined

    await this.withLock(async () => {
      if (this.closed) throw abortError("远程环境协调器已关闭")
      existing = this.active.get(input.runId)?.environment
      if (existing) return
      if (
        this.starting.has(input.runId) ||
        this.pending.some((item) => item.runId === input.runId)
      ) {
        throw new Error(`Run ${input.runId} 已在等待远程环境`)
      }

      this.pending.push(request)
      this.sortPending()
      const queued = this.occupiedSlots() >= this.maxConcurrent
      if (queued) {
        input.onEvent?.("environment_waiting", {
          priority: input.priority,
          position: this.pending.indexOf(request) + 1,
        })
      }
    })
    if (existing) return existing

    const onAbort = () => {
      void this.cancelRequest(request, abortError("远程环境申请已取消"))
    }
    input.signal?.addEventListener("abort", onAbort, { once: true })
    if (input.signal?.aborted) onAbort()

    this.kickPump()

    try {
      return await deferred.promise
    } finally {
      input.signal?.removeEventListener("abort", onAbort)
    }
  }

  private async cancelRequest(request: PendingRequest, error: Error): Promise<void> {
    let rejectPending = false
    await this.withLock(async () => {
      const index = this.pending.indexOf(request)
      if (index >= 0) {
        this.pending.splice(index, 1)
        rejectPending = true
        return
      }
      const starting = this.starting.get(request.runId)
      if (starting?.request === request) starting.controller.abort(error)
    })
    if (rejectPending) request.reject(error)
  }

  private async release(runId: string): Promise<void> {
    let pending: PendingRequest | undefined
    let starting: StartingRequest | undefined
    let lease: ActiveLease | undefined
    await this.withLock(async () => {
      const pendingIndex = this.pending.findIndex((request) => request.runId === runId)
      if (pendingIndex >= 0) [pending] = this.pending.splice(pendingIndex, 1)
      starting = this.starting.get(runId)
      lease = this.active.get(runId)
    })
    pending?.reject(abortError("远程环境申请已释放"))
    starting?.controller.abort(abortError("远程环境申请已释放"))
    if (lease) await this.releaseLease(lease)
  }

  private async status(
    runId: string,
    capability: NonNullable<ChallengeCapability["instance"]>,
  ): Promise<RemoteEnvironment | null> {
    if (!this.active.has(runId)) return null
    const environment = await withTimeout(
      capability.status(),
      this.operationTimeoutMs,
      "读取远程环境状态",
    )
    if (!environment || environment.status === "stopped") await this.release(runId)
    return environment
  }

  private kickPump(): void {
    void this.reserveAvailableRequests()
      .then((requests) => {
        for (const starting of requests) {
          const runId = starting.request.runId
          const task = this.runStart(starting).finally(() => {
            if (this.startTasks.get(runId) === task) this.startTasks.delete(runId)
          })
          this.startTasks.set(runId, task)
        }
      })
      .catch(() => undefined)
    void this.preemptForRequiredRequest()
  }

  private async preemptForRequiredRequest(): Promise<void> {
    let activeVictim: ActiveLease | undefined
    await this.withLock(async () => {
      if (
        this.closed ||
        this.occupiedSlots() < this.maxConcurrent ||
        !this.pending.some((request) => request.priority === "required")
      ) {
        return
      }
      activeVictim = this.oldestVerificationLease()
      if (activeVictim) return
      const startingVictim = [...this.starting.values()]
        .filter(({ request }) => request.priority === "verification")
        .sort((left, right) => left.startedAt - right.startedAt)[0]
      startingVictim?.controller.abort(abortError("远程环境启动已让位给无附件且无法本地推进的题目"))
    })
    if (activeVictim) {
      await this.releaseLease(activeVictim, {
        revokedMessage:
          "远程环境已让位给无附件且无法本地推进的题目；旧 endpoint 已失效，需要时可重新申请验证环境。",
      }).catch(() => undefined)
    }
  }

  private async reserveAvailableRequests(): Promise<StartingRequest[]> {
    return await this.withLock(async () => {
      const selected: StartingRequest[] = []
      while (!this.closed && this.occupiedSlots() < this.maxConcurrent) {
        const request = this.pending.shift()
        if (!request) break
        if (request.signal?.aborted) {
          request.reject(abortError("远程环境申请已取消"))
          continue
        }
        const starting: StartingRequest = {
          request,
          controller: new AbortController(),
          startedAt: Date.now(),
        }
        this.starting.set(request.runId, starting)
        request.onEvent?.("environment_starting", {
          priority: request.priority,
          waited: Date.now() - new Date(request.requestedAt).getTime() > 0,
        })
        selected.push(starting)
      }
      return selected
    })
  }

  private async runStart(starting: StartingRequest): Promise<void> {
    const { request, controller, startedAt } = starting
    const timeoutSignal = AbortSignal.timeout(this.startTimeoutMs)
    const signals = [controller.signal, this.closeController.signal, timeoutSignal]
    if (request.signal) signals.push(request.signal)
    const signal = AbortSignal.any(signals)
    const operation = Promise.resolve().then(async () => await request.capability.start(signal))

    try {
      const environment = await raceWithSignal(operation, signal)
      if (signal.aborted) throw signal.reason
      const lease: ActiveLease = {
        runId: request.runId,
        challengeId: request.challengeId,
        environmentId: environment.id,
        priority: request.priority,
        acquiredAt: new Date().toISOString(),
        capability: request.capability,
        environment,
        onRevoked: request.onRevoked,
        onEvent: request.onEvent,
      }
      await this.withLock(async () => {
        if (this.starting.get(request.runId) !== starting || signal.aborted || this.closed) {
          throw signal.reason ?? abortError("远程环境申请已取消")
        }
        this.store.saveEnvironmentLease(lease)
        this.starting.delete(request.runId)
        this.active.set(request.runId, lease)
      })
      request.onEvent?.("environment_acquired", {
        environmentId: environment.id,
        priority: request.priority,
        waited: startedAt - new Date(request.requestedAt).getTime() > 0,
        durationMs: Date.now() - startedAt,
      })
      request.resolve(environment)
    } catch (cause) {
      const error = timeoutSignal.aborted
        ? startTimeoutError(this.startTimeoutMs)
        : isAbortLike(cause) || signal.aborted
          ? abortError("远程环境申请已取消")
          : cause
      await this.withLock(async () => {
        if (this.starting.get(request.runId) === starting) this.starting.delete(request.runId)
      })
      request.onEvent?.("environment_start_failed", {
        priority: request.priority,
        durationMs: Date.now() - startedAt,
        error: errorText(error),
      })
      request.reject(error)

      // POST 可能已到达平台但响应丢失。立即清理一次；若不遵守 abort 的插件
      // 之后才返回成功，再补一次幂等清理，避免产生无人持有的实例。
      void this.cleanupCapability(request.capability, request.onEvent)
      void operation.then(
        async () => await this.cleanupCapability(request.capability, request.onEvent),
        () => undefined,
      )
    } finally {
      this.kickPump()
    }
  }

  private async cleanupCapability(
    capability: NonNullable<ChallengeCapability["instance"]>,
    onEvent?: ManagedCapabilityOptions["onEvent"],
  ): Promise<void> {
    try {
      await withTimeout(capability.destroy(), this.operationTimeoutMs, "清理启动失败的远程环境")
    } catch (error) {
      onEvent?.("environment_cleanup_failed", { error: errorText(error) })
    }
  }

  private async releaseLease(lease: ActiveLease, options: ReleaseOptions = {}): Promise<void> {
    const existing = this.releaseTasks.get(lease.runId)
    if (existing) return await existing
    const task = this.performRelease(lease, options).finally(() => {
      if (this.releaseTasks.get(lease.runId) === task) this.releaseTasks.delete(lease.runId)
    })
    this.releaseTasks.set(lease.runId, task)
    return await task
  }

  private async performRelease(lease: ActiveLease, options: ReleaseOptions): Promise<void> {
    let failure: unknown
    try {
      await withTimeout(lease.capability.destroy(), this.operationTimeoutMs, "销毁远程环境")
    } catch (error) {
      failure = error
    }

    await this.withLock(async () => {
      if (this.active.get(lease.runId) === lease) this.active.delete(lease.runId)
      if (!failure) this.store.deleteEnvironmentLease(lease.runId)
    })
    if (failure) {
      lease.onEvent?.("environment_release_failed", {
        environmentId: lease.environmentId,
        error: errorText(failure),
      })
    } else {
      lease.onEvent?.("environment_released", { environmentId: lease.environmentId })
    }
    if (options.revokedMessage) {
      lease.onEvent?.("environment_revoked", {
        environmentId: lease.environmentId,
        reason: options.revokedMessage,
      })
      void Promise.resolve(lease.onRevoked?.(options.revokedMessage)).catch(() => undefined)
    }
    this.kickPump()
    if (failure) throw failure
  }

  private occupiedSlots(): number {
    return this.active.size + this.starting.size
  }

  private verificationLeases(): ActiveLease[] {
    return [...this.active.values()]
      .filter((lease) => lease.priority === "verification")
      .sort((left, right) => left.acquiredAt.localeCompare(right.acquiredAt))
  }

  private oldestVerificationLease(): ActiveLease | undefined {
    return this.verificationLeases().find((lease) => !this.releaseTasks.has(lease.runId))
  }

  private sortPending(): void {
    this.pending.sort((left, right) => {
      const priority = priorityRank(left.priority) - priorityRank(right.priority)
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

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok
    reject = fail
  })
  return { promise, resolve, reject }
}

async function raceWithSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener("abort", onAbort, { once: true })
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort))
  })
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  const signal = AbortSignal.timeout(timeoutMs)
  try {
    return await raceWithSignal(operation, signal)
  } catch (error) {
    if (!signal.aborted) throw error
    throw operationTimeoutError(label, timeoutMs)
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

function positiveDuration(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${label}必须是正整数`)
  return value
}

function abortError(message: string): Error {
  return Object.assign(new Error(message), { name: "AbortError" })
}

function startTimeoutError(timeoutMs: number): Error {
  return Object.assign(new Error(`远程环境启动超过 ${timeoutMs}ms`), {
    name: "RemoteEnvironmentStartTimeoutError",
    code: "ETIMEDOUT",
    retryable: true,
  })
}

function environmentRevokedError(): Error {
  return Object.assign(new Error("远程环境在 Solver 恢复执行前已被撤销，请重新申请"), {
    name: "RemoteEnvironmentRevokedError",
    code: "REMOTE_ENVIRONMENT_REVOKED",
    retryable: true,
  })
}

function operationTimeoutError(label: string, timeoutMs: number): Error {
  return Object.assign(new Error(`${label}超过 ${timeoutMs}ms`), {
    name: "RemoteEnvironmentOperationTimeoutError",
    code: "ETIMEDOUT",
    retryable: true,
  })
}

function isAbortLike(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
