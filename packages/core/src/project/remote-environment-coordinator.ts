import {
  isRetryablePlatformError,
  type ChallengeCapability,
  type ChallengeInfo,
  type FlagSubmission,
  type PlatformProject,
  type RemoteEnvironment,
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
  /** Retry delays for platform failures explicitly marked retryable. */
  startRetryDelaysMs?: readonly number[]
}

/** Scheduler phase hook; waiting keeps the Run's hard Sandbox slot. */
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
  deliveredAt?: number
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
  promise: Promise<RemoteEnvironment>
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

export interface RemoteEnvironmentCapacitySnapshot {
  maximum: number
  occupied: number
  available: number
}

export interface RemoteEnvironmentLeaseSnapshot {
  runId: string
  challengeId: string
  environmentId?: string
  priority: RemoteEnvironmentPriority
  phase: "waiting" | "starting" | "ready" | "releasing"
  requestedAt?: string
  startedAt?: string
  acquiredAt?: string
  deliveredAt?: string
  status?: RemoteEnvironment["status"]
  endpoint?: string
  expiresAt?: string
  readyAt?: string
}

export interface RemoteEnvironmentCoordinatorSnapshot {
  capacity: RemoteEnvironmentCapacitySnapshot
  leases: RemoteEnvironmentLeaseSnapshot[]
}

const DEFAULT_START_TIMEOUT_MS = 4 * 60_000
const DEFAULT_OPERATION_TIMEOUT_MS = 30_000
const DEFAULT_START_RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000] as const

/** Project 级远程环境配额。Solver 只能通过题目绑定后的 capability 申请自己的租约。 */
export class RemoteEnvironmentCoordinator {
  private readonly active = new Map<string, ActiveLease>()
  private readonly pending: PendingRequest[] = []
  private readonly starting = new Map<string, StartingRequest>()
  private readonly startTasks = new Map<string, Promise<void>>()
  private readonly releaseTasks = new Map<string, Promise<void>>()
  private readonly expiryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly closeController = new AbortController()
  private readonly startTimeoutMs: number
  private readonly operationTimeoutMs: number
  private readonly startRetryDelaysMs: readonly number[]
  private readonly capacityListeners = new Set<
    (snapshot: RemoteEnvironmentCapacitySnapshot) => void
  >()
  private observedPlatformEnvironmentIds = new Set<string>()
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
    this.startRetryDelaysMs = (options.startRetryDelaysMs ?? DEFAULT_START_RETRY_DELAYS_MS).map(
      (delay) => nonNegativeDuration(delay, "远程环境启动重试延迟"),
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
            const current = await this.status(options.runId, instance)
            environment =
              current ??
              (await this.acquire({
                runId: options.runId,
                challengeId: options.challenge.id,
                priority,
                capability: instance,
                onRevoked: options.onRevoked,
                onEvent: options.onEvent,
                signal,
              }))
          } finally {
            await options.executionGate?.resume(signal)
          }

          if (!options.executionGate) {
            await this.markDelivered(options.runId)
            return environment
          }

          // Re-check after an asynchronous scheduler gate so an expired endpoint is never delivered.
          const current = await this.status(options.runId, instance)
          if (!current) throw environmentRevokedError()
          await this.markDelivered(options.runId)
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
    await this.withLock(async () => {
      this.maxConcurrent = maxConcurrent
    })
    // 下调不抢占正在解题的租约；现有占用自然释放前不再发新槽。
    this.notifyCapacityChanged()
    this.kickPump()
  }

  capacity(): RemoteEnvironmentCapacitySnapshot {
    const occupied = this.occupiedSlots()
    return {
      maximum: this.maxConcurrent,
      occupied,
      available: Math.max(0, this.maxConcurrent - occupied),
    }
  }

  snapshot(): RemoteEnvironmentCoordinatorSnapshot {
    const leases: RemoteEnvironmentLeaseSnapshot[] = [
      ...this.pending.map((request) => ({
        runId: request.runId,
        challengeId: request.challengeId,
        priority: request.priority,
        phase: "waiting" as const,
        requestedAt: request.requestedAt,
      })),
      ...[...this.starting.values()].map(({ request, startedAt }) => ({
        runId: request.runId,
        challengeId: request.challengeId,
        priority: request.priority,
        phase: "starting" as const,
        requestedAt: request.requestedAt,
        startedAt: new Date(startedAt).toISOString(),
      })),
      ...[...this.active.values()].map((lease) => ({
        runId: lease.runId,
        challengeId: lease.challengeId,
        environmentId: lease.environmentId,
        priority: lease.priority,
        phase: this.releaseTasks.has(lease.runId) ? ("releasing" as const) : ("ready" as const),
        acquiredAt: lease.acquiredAt,
        ...(lease.deliveredAt === undefined
          ? {}
          : { deliveredAt: new Date(lease.deliveredAt).toISOString() }),
        status: lease.environment.status,
        endpoint: lease.environment.endpoint,
        expiresAt: lease.environment.expiresAt,
        readyAt: lease.environment.readyAt,
      })),
    ]
    leases.sort((left, right) =>
      (left.requestedAt ?? left.startedAt ?? left.acquiredAt ?? "").localeCompare(
        right.requestedAt ?? right.startedAt ?? right.acquiredAt ?? "",
      ),
    )
    return { capacity: this.capacity(), leases }
  }

  subscribeCapacity(listener: (snapshot: RemoteEnvironmentCapacitySnapshot) => void): () => void {
    this.capacityListeners.add(listener)
    return () => this.capacityListeners.delete(listener)
  }

  observePlatformEnvironments(environments: readonly RemoteEnvironment[]): void {
    const next = new Set(
      environments
        .filter((environment) => environment.status !== "stopped")
        .map((environment) => environment.id),
    )
    const changed =
      next.size !== this.observedPlatformEnvironmentIds.size ||
      [...next].some((id) => !this.observedPlatformEnvironmentIds.has(id))
    if (!changed) return
    this.observedPlatformEnvironmentIds = next
    this.notifyCapacityChanged()
    this.kickPump()
  }

  isWaiting(runId: string): boolean {
    return this.starting.has(runId) || this.pending.some((request) => request.runId === runId)
  }

  environmentForRun(runId: string): RemoteEnvironment | undefined {
    const environment = this.active.get(runId)?.environment
    return environment ? { ...environment } : undefined
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
    for (const timer of this.expiryTimers.values()) clearTimeout(timer)
    this.expiryTimers.clear()
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
    input: Omit<PendingRequest, "requestedAt" | "promise" | "resolve" | "reject">,
  ): Promise<RemoteEnvironment> {
    if (input.signal?.aborted) throw abortError("远程环境申请已取消")
    const deferred = createDeferred<RemoteEnvironment>()
    const request: PendingRequest = {
      ...input,
      requestedAt: new Date().toISOString(),
      promise: deferred.promise,
      resolve: (environment) => deferred.resolve(environment),
      reject: (error) => deferred.reject(error),
    }
    let existing: RemoteEnvironment | undefined
    let joined: PendingRequest | undefined
    let releasing: Promise<void> | undefined

    await this.withLock(async () => {
      if (this.closed) throw abortError("远程环境协调器已关闭")
      releasing = this.releaseTasks.get(input.runId)
      if (releasing) return
      existing = this.active.get(input.runId)?.environment
      if (existing) return
      joined =
        this.starting.get(input.runId)?.request ??
        this.pending.find((item) => item.runId === input.runId)
      if (joined) return

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
    if (releasing) {
      await waitForCaller(releasing, input.signal)
      return await this.acquire(input)
    }
    if (existing) return existing
    if (joined) return await waitForCaller(joined.promise, input.signal)

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
    const lease = this.active.get(runId)
    if (!lease) return null
    if (isExpired(lease.environment)) {
      await this.forgetExpiredLease(lease)
      return null
    }
    const environment = await withTimeout(
      capability.status(),
      this.operationTimeoutMs,
      "读取远程环境状态",
    )
    if (!environment || environment.status === "stopped" || isExpired(environment)) {
      await this.forgetExpiredLease(lease)
      return null
    }

    const changed =
      lease.environment.id !== environment.id ||
      lease.environment.endpoint !== environment.endpoint ||
      lease.environment.expiresAt !== environment.expiresAt ||
      lease.environment.status !== environment.status
    if (changed) {
      await this.withLock(async () => {
        if (this.active.get(runId) !== lease) return
        lease.environment = environment
        lease.environmentId = environment.id
        this.store.saveEnvironmentLease(lease)
      })
      this.scheduleLeaseExpiry(lease)
      lease.onEvent?.("environment_updated", {
        environmentId: environment.id,
        endpoint: environment.endpoint,
        expiresAt: environment.expiresAt,
        status: environment.status,
      })
      void Promise.resolve(
        lease.onRevoked?.(
          `远程环境状态已更新：${environment.status}${environment.expiresAt ? `，到期时间 ${environment.expiresAt}` : ""}。后续操作必须使用最新的 ctf_instance_status 结果。`,
        ),
      ).catch(() => undefined)
    }
    return environment
  }

  private async forgetExpiredLease(lease: ActiveLease): Promise<void> {
    let removed = false
    await this.withLock(async () => {
      if (this.active.get(lease.runId) !== lease) return
      this.active.delete(lease.runId)
      this.observedPlatformEnvironmentIds.delete(lease.environmentId)
      this.clearLeaseExpiry(lease.runId)
      this.store.deleteEnvironmentLease(lease.runId)
      this.notifyCapacityChanged()
      removed = true
    })
    if (!removed) return
    lease.onEvent?.("environment_expired", {
      environmentId: lease.environmentId,
      expiredAt: lease.environment.expiresAt,
    })
    void Promise.resolve(
      lease.onRevoked?.(
        "远程环境已过期或平台已停止该实例。旧 endpoint 立即失效；Solver 或 SubAgent 可以调用 ctf_instance_start 原子地重新开启，所有并发调用会共享同一次平台请求。",
      ),
    ).catch(() => undefined)
    this.kickPump()
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
  }

  private async markDelivered(runId: string): Promise<void> {
    let lease: ActiveLease | undefined
    await this.withLock(async () => {
      lease = this.active.get(runId)
      if (!lease || lease.deliveredAt !== undefined) return
      lease.deliveredAt = Date.now()
    })
    if (!lease || lease.deliveredAt === undefined) return
    lease.onEvent?.("environment_delivered", {
      environmentId: lease.environmentId,
      deliveredAt: new Date(lease.deliveredAt).toISOString(),
      deliveryWaitMs: lease.deliveredAt - new Date(lease.acquiredAt).getTime(),
    })
    this.kickPump()
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
        this.notifyCapacityChanged()
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
    let attempt = 0
    let finalError: unknown
    let finalOperation: Promise<RemoteEnvironment> | undefined

    while (!signal.aborted) {
      const operation = Promise.resolve().then(async () => await request.capability.start(signal))
      finalOperation = operation
      try {
        const started = await raceWithSignal(operation, signal)
        const environment = request.capability.waitUntilReady
          ? await raceWithSignal(request.capability.waitUntilReady(started, signal), signal)
          : await waitForPlatformReportedReady(request.capability, started, signal)
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
          this.notifyCapacityChanged()
        })
        this.scheduleLeaseExpiry(lease)
        request.onEvent?.("environment_acquired", {
          environmentId: environment.id,
          priority: request.priority,
          waited: startedAt - new Date(request.requestedAt).getTime() > 0,
          durationMs: Date.now() - startedAt,
          attempts: attempt + 1,
          endpoint: environment.endpoint,
          expiresAt: environment.expiresAt,
          readyAt: environment.readyAt,
        })
        void Promise.resolve(
          request.onRevoked?.(
            `远程环境已就绪${environment.expiresAt ? `，预计于 ${environment.expiresAt} 到期` : ""}。Solver 与所有 SubAgent 必须使用这次更新后的 endpoint；若 status 返回 null，可调用 ctf_instance_start 原子地重新开启。`,
          ),
        ).catch(() => undefined)
        request.resolve(environment)
        this.kickPump()
        return
      } catch (cause) {
        const error = normalizedStartError(cause, signal, timeoutSignal, this.startTimeoutMs)
        const fallbackDelay = this.startRetryDelaysMs[attempt]
        const delayMs = retryDelay(error, fallbackDelay)
        if (
          !signal.aborted &&
          isRetryablePlatformError(error) &&
          fallbackDelay !== undefined &&
          delayMs !== undefined
        ) {
          const cleaned = await this.cleanupCapability(request.capability, request.onEvent)
          if (!cleaned) {
            finalError = error
            break
          }
          if (signal.aborted) {
            finalError = normalizedStartError(
              signal.reason,
              signal,
              timeoutSignal,
              this.startTimeoutMs,
            )
            break
          }
          request.onEvent?.("environment_retry_scheduled", {
            priority: request.priority,
            attempt: attempt + 1,
            nextAttempt: attempt + 2,
            delayMs,
            error: errorText(error),
          })
          attempt++
          try {
            await waitForDelay(delayMs, signal)
          } catch (delayError) {
            finalError = normalizedStartError(
              delayError,
              signal,
              timeoutSignal,
              this.startTimeoutMs,
            )
            break
          }
          request.onEvent?.("environment_starting", {
            priority: request.priority,
            waited: true,
            attempt: attempt + 1,
          })
          continue
        }
        finalError = error
        break
      }
    }

    finalError ??= normalizedStartError(signal.reason, signal, timeoutSignal, this.startTimeoutMs)
    await this.withLock(async () => {
      if (this.starting.get(request.runId) === starting) {
        this.starting.delete(request.runId)
        this.notifyCapacityChanged()
      }
    })
    request.onEvent?.("environment_start_failed", {
      priority: request.priority,
      durationMs: Date.now() - startedAt,
      attempts: attempt + 1,
      error: errorText(finalError),
    })
    request.reject(finalError)

    // POST 可能已到达平台但响应丢失。立即清理一次；若不遵守 abort 的插件
    // 之后才返回成功，再补一次幂等清理，避免产生无人持有的实例。
    void this.cleanupCapability(request.capability, request.onEvent)
    void finalOperation?.then(
      async () => await this.cleanupCapability(request.capability, request.onEvent),
      () => undefined,
    )
    this.kickPump()
  }

  private async cleanupCapability(
    capability: NonNullable<ChallengeCapability["instance"]>,
    onEvent?: ManagedCapabilityOptions["onEvent"],
  ): Promise<boolean> {
    try {
      await withTimeout(capability.destroy(), this.operationTimeoutMs, "清理启动失败的远程环境")
      return true
    } catch (error) {
      onEvent?.("environment_cleanup_failed", { error: errorText(error) })
      return false
    }
  }

  private async releaseLease(lease: ActiveLease): Promise<void> {
    const existing = this.releaseTasks.get(lease.runId)
    if (existing) return await existing
    const task = this.performRelease(lease).finally(() => {
      if (this.releaseTasks.get(lease.runId) === task) this.releaseTasks.delete(lease.runId)
    })
    this.releaseTasks.set(lease.runId, task)
    return await task
  }

  private async performRelease(lease: ActiveLease): Promise<void> {
    let failure: unknown
    try {
      await withTimeout(lease.capability.destroy(), this.operationTimeoutMs, "销毁远程环境")
    } catch (error) {
      failure = error
    }

    if (failure) {
      lease.onEvent?.("environment_release_failed", {
        environmentId: lease.environmentId,
        error: errorText(failure),
      })
      throw failure
    }

    await this.withLock(async () => {
      if (this.active.get(lease.runId) === lease) this.active.delete(lease.runId)
      this.observedPlatformEnvironmentIds.delete(lease.environmentId)
      this.clearLeaseExpiry(lease.runId)
      this.store.deleteEnvironmentLease(lease.runId)
      this.notifyCapacityChanged()
    })
    lease.onEvent?.("environment_released", { environmentId: lease.environmentId })
    void Promise.resolve(lease.onRevoked?.("远程环境已释放，旧 endpoint 不再有效。")).catch(
      () => undefined,
    )
    this.kickPump()
  }

  private occupiedSlots(): number {
    const environmentIds = new Set(this.observedPlatformEnvironmentIds)
    for (const lease of this.active.values()) environmentIds.add(lease.environmentId)
    return environmentIds.size + this.starting.size
  }

  private scheduleLeaseExpiry(lease: ActiveLease): void {
    this.clearLeaseExpiry(lease.runId)
    if (!lease.environment.expiresAt) return
    const expiresAt = Date.parse(lease.environment.expiresAt)
    if (!Number.isFinite(expiresAt)) return
    const timer = setTimeout(
      () => {
        if (this.expiryTimers.get(lease.runId) === timer) {
          this.expiryTimers.delete(lease.runId)
        }
        void this.status(lease.runId, lease.capability).catch((error) => {
          lease.onEvent?.("environment_status_failed", { error: errorText(error) })
        })
      },
      Math.max(0, expiresAt - Date.now()),
    )
    timer.unref?.()
    this.expiryTimers.set(lease.runId, timer)
  }

  private clearLeaseExpiry(runId: string): void {
    const timer = this.expiryTimers.get(runId)
    if (timer) clearTimeout(timer)
    this.expiryTimers.delete(runId)
  }

  private notifyCapacityChanged(): void {
    const snapshot = this.capacity()
    for (const listener of this.capacityListeners) listener(snapshot)
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

async function waitForPlatformReportedReady(
  capability: NonNullable<ChallengeCapability["instance"]>,
  initial: RemoteEnvironment,
  signal: AbortSignal,
): Promise<RemoteEnvironment> {
  let environment: RemoteEnvironment | null = initial
  while (!signal.aborted) {
    if (
      environment.status === "running" &&
      Boolean(environment.endpoint) &&
      !isExpired(environment)
    ) {
      return { ...environment, readyAt: environment.readyAt ?? new Date().toISOString() }
    }
    await waitForDelay(1_000, signal)
    environment = await capability.status()
    if (!environment || environment.status === "stopped" || isExpired(environment)) {
      throw Object.assign(new Error("远程环境在就绪前已停止或过期"), {
        name: "RemoteEnvironmentUnavailableError",
        code: "REMOTE_ENVIRONMENT_UNAVAILABLE",
        retryable: true,
      })
    }
  }
  throw signal.reason
}

function isExpired(environment: RemoteEnvironment): boolean {
  if (!environment.expiresAt) return false
  const expiresAt = Date.parse(environment.expiresAt)
  return Number.isFinite(expiresAt) && expiresAt <= Date.now()
}

async function waitForCaller<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return await operation
  return await raceWithSignal(operation, signal)
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

async function waitForDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason
  if (delayMs === 0) return
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(finish, delayMs)
    const onAbort = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
      reject(signal.reason)
    }
    function finish() {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

function normalizedStartError(
  cause: unknown,
  signal: AbortSignal,
  timeoutSignal: AbortSignal,
  timeoutMs: number,
): unknown {
  if (timeoutSignal.aborted) return startTimeoutError(timeoutMs)
  if (isAbortLike(cause) || signal.aborted) return abortError("远程环境申请已取消")
  return cause
}

function retryDelay(error: unknown, fallback: number | undefined): number | undefined {
  if (error && typeof error === "object") {
    const value = (error as { retryAfterMs?: unknown }).retryAfterMs
    if (Number.isInteger(value) && Number(value) >= 0) return Number(value)
  }
  return fallback
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

function nonNegativeDuration(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label}必须是非负整数`)
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
