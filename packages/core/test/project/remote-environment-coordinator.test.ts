import type {
  ChallengeCapability,
  ChallengeInfo,
  PlatformProject,
  RemoteEnvironment,
} from "@ctf-agent/platform"
import { describe, expect, it, vi } from "vite-plus/test"
import {
  RemoteEnvironmentCoordinator,
  type RemoteEnvironmentLeaseRecord,
  type RemoteEnvironmentLeaseStore,
} from "../../src/project/remote-environment-coordinator.ts"

class MemoryLeaseStore implements RemoteEnvironmentLeaseStore {
  readonly leases = new Map<string, RemoteEnvironmentLeaseRecord>()

  listEnvironmentLeases(): RemoteEnvironmentLeaseRecord[] {
    return [...this.leases.values()]
  }

  saveEnvironmentLease(record: RemoteEnvironmentLeaseRecord): void {
    this.leases.set(record.runId, { ...record })
  }

  deleteEnvironmentLease(runId: string): void {
    this.leases.delete(runId)
  }
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function challenge(id: string, attachments: number): ChallengeInfo {
  return {
    id,
    title: id,
    category: "test",
    score: 100,
    description: "test",
    needsEnv: true,
    attachments: Array.from({ length: attachments }, (_, index) => ({
      id: `attachment-${index}`,
      name: `attachment-${index}.txt`,
    })),
  }
}

function capability(id: string, log: string[]): ChallengeCapability {
  let environment: RemoteEnvironment | null = null
  return {
    getInfo: async () => challenge(id, 0),
    downloadAttachment: async () => {
      throw new Error("unused")
    },
    submitFlag: async () => ({ status: "accepted", message: "accepted" }),
    instance: {
      start: async () => {
        log.push(`start:${id}`)
        environment = {
          id: `environment-${id}`,
          challengeId: id,
          status: "running",
          endpoint: `test://${id}`,
        }
        return environment
      },
      status: async () => environment,
      destroy: async () => {
        log.push(`destroy:${id}`)
        environment = null
      },
    },
  }
}

describe("RemoteEnvironmentCoordinator", () => {
  it("包装实例型 capability 时保留原型上的附件下载方法", async () => {
    const coordinator = new RemoteEnvironmentCoordinator(1, new MemoryLeaseStore())
    class PrototypeCapability implements ChallengeCapability {
      readonly instance = capability("prototype", []).instance

      async getInfo(): Promise<ChallengeInfo> {
        return challenge("prototype", 1)
      }

      async downloadAttachment() {
        return {
          attachment: { id: "attachment-0", name: "attachment-0.txt" },
          content: new Uint8Array([1]),
        }
      }

      async submitFlag() {
        return { status: "accepted" as const, message: "accepted" }
      }
    }

    const managed = coordinator.manage({
      runId: "run-prototype",
      challenge: challenge("prototype", 1),
      capability: new PrototypeCapability(),
    })

    await expect(managed.getInfo()).resolves.toMatchObject({ id: "prototype" })
    await expect(managed.downloadAttachment("attachment-0")).resolves.toEqual({
      attachment: { id: "attachment-0", name: "attachment-0.txt" },
      content: new Uint8Array([1]),
    })
    await coordinator.close()
  })

  it("平台列表中的外部实例也占配额，确认消失后才发放名额", async () => {
    const log: string[] = []
    const coordinator = new RemoteEnvironmentCoordinator(1, new MemoryLeaseStore())
    coordinator.observePlatformEnvironments([
      {
        id: "external-environment",
        challengeId: "external",
        status: "running",
        endpoint: "test://external",
      },
    ])
    const managed = coordinator.manage({
      runId: "run-after-external",
      challenge: challenge("after-external", 0),
      capability: capability("after-external", log),
    })

    let resolved = false
    const start = managed.instance?.start().then((environment) => {
      resolved = true
      return environment
    })
    await vi.waitFor(() => expect(coordinator.snapshot().leases[0]?.phase).toBe("waiting"))
    expect(coordinator.capacity()).toEqual({ maximum: 1, occupied: 1, available: 0 })
    expect(resolved).toBe(false)
    expect(log).toEqual([])

    coordinator.observePlatformEnvironments([])
    await expect(start).resolves.toMatchObject({ id: "environment-after-external" })
    await coordinator.close()
  })

  it("已交付租约保持到持有者主动释放，不因高优先级请求被抢占", async () => {
    const log: string[] = []
    const coordinator = new RemoteEnvironmentCoordinator(1, new MemoryLeaseStore())
    const verification = coordinator.manage({
      runId: "run-verification",
      challenge: challenge("with-file", 1),
      capability: capability("with-file", log),
    })
    const required = coordinator.manage({
      runId: "run-required",
      challenge: challenge("without-file", 0),
      capability: capability("without-file", log),
    })

    await verification.instance?.start()
    let requiredResolved = false
    const requiredStart = required.instance?.start().then((environment) => {
      requiredResolved = true
      return environment
    })
    await vi.waitFor(() => expect(coordinator.capacity().occupied).toBe(1))

    expect(requiredResolved).toBe(false)
    expect(log).toEqual(["start:with-file"])

    await verification.instance?.destroy()
    await expect(requiredStart).resolves.toMatchObject({ id: "environment-without-file" })
    expect(log).toEqual(["start:with-file", "destroy:with-file", "start:without-file"])
    await coordinator.close()
  })

  it("降低配额不撤销现有租约，全部自然释放后才发放新槽", async () => {
    const log: string[] = []
    const coordinator = new RemoteEnvironmentCoordinator(2, new MemoryLeaseStore())
    const first = coordinator.manage({
      runId: "run-first",
      challenge: challenge("first", 0),
      capability: capability("first", log),
    })
    const second = coordinator.manage({
      runId: "run-second",
      challenge: challenge("second", 0),
      capability: capability("second", log),
    })
    const waiting = coordinator.manage({
      runId: "run-waiting",
      challenge: challenge("waiting", 0),
      capability: capability("waiting", log),
    })

    await Promise.all([first.instance?.start(), second.instance?.start()])
    await coordinator.setMaxConcurrent(1)
    let waitingResolved = false
    const waitingStart = waiting.instance?.start().then((environment) => {
      waitingResolved = true
      return environment
    })

    await first.instance?.destroy()
    expect(waitingResolved).toBe(false)
    await second.instance?.destroy()
    await expect(waitingStart).resolves.toMatchObject({ id: "environment-waiting" })
    expect(log).toEqual([
      "start:first",
      "start:second",
      "destroy:first",
      "destroy:second",
      "start:waiting",
    ])
    await coordinator.close()
  })

  it("可重试启动错误在同一次工具调用内退避并恢复，不返回 Agent", async () => {
    const events: Array<{ type: string; data?: unknown }> = []
    const log: string[] = []
    const retrying = capability("retrying", log)
    if (!retrying.instance) throw new Error("fixture 缺少实例能力")
    let attempts = 0
    retrying.instance.start = async () => {
      attempts++
      if (attempts < 3) {
        throw Object.assign(new Error("remote build is still preparing"), {
          retryable: true,
          retryAfterMs: 0,
        })
      }
      return {
        id: "environment-retrying",
        challengeId: "retrying",
        status: "running",
        endpoint: "test://retrying",
      }
    }
    const coordinator = new RemoteEnvironmentCoordinator(1, new MemoryLeaseStore(), {
      startRetryDelaysMs: [0, 0],
    })
    const managed = coordinator.manage({
      runId: "run-retrying",
      challenge: challenge("retrying", 0),
      capability: retrying,
      onEvent: (type, data) => events.push({ type, data }),
    })

    await expect(managed.instance?.start()).resolves.toMatchObject({
      id: "environment-retrying",
    })
    expect(attempts).toBe(3)
    expect(events.filter(({ type }) => type === "environment_retry_scheduled")).toHaveLength(2)
    expect(events.some(({ type }) => type === "environment_start_failed")).toBe(false)
    await coordinator.close()
  })

  it("可重试启动错误耗尽预算后只向 Agent 返回最后一次失败", async () => {
    const events: string[] = []
    const retrying = capability("exhausted", [])
    if (!retrying.instance) throw new Error("fixture 缺少实例能力")
    let attempts = 0
    retrying.instance.start = async () => {
      attempts++
      throw Object.assign(new Error(`temporary failure ${attempts}`), { retryable: true })
    }
    const coordinator = new RemoteEnvironmentCoordinator(1, new MemoryLeaseStore(), {
      startRetryDelaysMs: [0, 0],
    })
    const managed = coordinator.manage({
      runId: "run-exhausted",
      challenge: challenge("exhausted", 0),
      capability: retrying,
      onEvent: (type) => events.push(type),
    })

    await expect(managed.instance?.start()).rejects.toThrow("temporary failure 3")
    expect(attempts).toBe(3)
    expect(events.filter((type) => type === "environment_retry_scheduled")).toHaveLength(2)
    expect(events.filter((type) => type === "environment_start_failed")).toHaveLength(1)
    await coordinator.close()
  })

  it("补偿清理失败时停止启动重试，避免重复创建非幂等实例", async () => {
    const events: string[] = []
    const retrying = capability("cleanup-failed", [])
    if (!retrying.instance) throw new Error("fixture 缺少实例能力")
    let attempts = 0
    retrying.instance.start = async () => {
      attempts++
      throw Object.assign(new Error("temporary start failure"), { retryable: true })
    }
    retrying.instance.destroy = async () => {
      throw new Error("cleanup unavailable")
    }
    const coordinator = new RemoteEnvironmentCoordinator(1, new MemoryLeaseStore(), {
      operationTimeoutMs: 50,
      startRetryDelaysMs: [0, 0],
    })
    const managed = coordinator.manage({
      runId: "run-cleanup-failed",
      challenge: challenge("cleanup-failed", 0),
      capability: retrying,
      onEvent: (type) => events.push(type),
    })

    await expect(managed.instance?.start()).rejects.toThrow("temporary start failure")
    expect(attempts).toBe(1)
    expect(events).toContain("environment_cleanup_failed")
    expect(events).not.toContain("environment_retry_scheduled")
    await coordinator.close()
  })

  it("未标记为可重试的启动错误立即返回且不会消耗重试预算", async () => {
    const failing = capability("terminal-start", [])
    if (!failing.instance) throw new Error("fixture 缺少实例能力")
    const start = vi.fn(async () => {
      throw new Error("invalid environment configuration")
    })
    failing.instance.start = start
    const coordinator = new RemoteEnvironmentCoordinator(1, new MemoryLeaseStore(), {
      startRetryDelaysMs: [0, 0],
    })
    const managed = coordinator.manage({
      runId: "run-terminal-start",
      challenge: challenge("terminal-start", 0),
      capability: failing,
    })

    await expect(managed.instance?.start()).rejects.toThrow("invalid environment configuration")
    expect(start).toHaveBeenCalledOnce()
    await coordinator.close()
  })

  it("取消退避中的环境申请后不再启动下一次平台调用", async () => {
    const retrying = capability("cancel-retry", [])
    if (!retrying.instance) throw new Error("fixture 缺少实例能力")
    let attempts = 0
    retrying.instance.start = async () => {
      attempts++
      throw Object.assign(new Error("temporary failure"), { retryable: true })
    }
    const coordinator = new RemoteEnvironmentCoordinator(1, new MemoryLeaseStore(), {
      startRetryDelaysMs: [1_000],
    })
    const managed = coordinator.manage({
      runId: "run-cancel-retry",
      challenge: challenge("cancel-retry", 0),
      capability: retrying,
    })
    const controller = new AbortController()
    const request = managed.instance?.start(controller.signal)
    await vi.waitFor(() => expect(attempts).toBe(1))

    controller.abort()

    await expect(request).rejects.toMatchObject({ name: "AbortError" })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(attempts).toBe(1)
    await coordinator.close()
  })

  it("补偿清理期间取消申请时不发布重试计划", async () => {
    const events: string[] = []
    const cleanup = deferred<void>()
    const retrying = capability("cancel-cleanup", [])
    if (!retrying.instance) throw new Error("fixture 缺少实例能力")
    const start = vi.fn(async () => {
      throw Object.assign(new Error("temporary failure"), { retryable: true })
    })
    const destroy = vi.fn(async () => await cleanup.promise)
    retrying.instance.start = start
    retrying.instance.destroy = destroy
    const coordinator = new RemoteEnvironmentCoordinator(1, new MemoryLeaseStore(), {
      startRetryDelaysMs: [0],
    })
    const managed = coordinator.manage({
      runId: "run-cancel-cleanup",
      challenge: challenge("cancel-cleanup", 0),
      capability: retrying,
      onEvent: (type) => events.push(type),
    })
    const controller = new AbortController()
    const request = managed.instance?.start(controller.signal)
    const rejected = expect(request).rejects.toMatchObject({ name: "AbortError" })
    await vi.waitFor(() => expect(destroy).toHaveBeenCalledOnce())

    controller.abort()
    cleanup.resolve(undefined)

    await rejected
    expect(start).toHaveBeenCalledOnce()
    expect(events).not.toContain("environment_retry_scheduled")
    await coordinator.close()
  })

  it("新请求不会抢占尚未完成的启动，必须等待原持有者释放", async () => {
    const log: string[] = []
    let observedSignal: AbortSignal | undefined
    const allowStart = deferred<void>()
    const coordinator = new RemoteEnvironmentCoordinator(1, new MemoryLeaseStore(), {
      startTimeoutMs: 1_000,
      operationTimeoutMs: 100,
    })
    const verificationCapability = capability("starting-verification", log)
    if (!verificationCapability.instance) throw new Error("fixture 缺少实例能力")
    verificationCapability.instance.start = async (signal) => {
      if (!signal) throw new Error("缺少启动 signal")
      observedSignal = signal
      await allowStart.promise
      return {
        id: "environment-starting-verification",
        challengeId: "starting-verification",
        status: "running",
        endpoint: "test://starting-verification",
      }
    }
    const verification = coordinator.manage({
      runId: "run-starting-verification",
      challenge: challenge("starting-verification", 1),
      capability: verificationCapability,
    })
    const verificationStart = verification.instance?.start()
    await vi.waitFor(() => expect(observedSignal).toBeDefined())

    const required = coordinator.manage({
      runId: "run-required-after-starting",
      challenge: challenge("required-after-starting", 0),
      capability: capability("required-after-starting", log),
    })
    let requiredResolved = false
    const requiredStart = required.instance?.start().then((environment) => {
      requiredResolved = true
      return environment
    })

    expect(requiredResolved).toBe(false)
    expect(observedSignal?.aborted).toBe(false)
    allowStart.resolve(undefined)
    await expect(verificationStart).resolves.toMatchObject({
      id: "environment-starting-verification",
    })
    expect(requiredResolved).toBe(false)

    await verification.instance?.destroy()
    await expect(requiredStart).resolves.toMatchObject({
      id: "environment-required-after-starting",
    })
    await coordinator.close()
  })

  it("同一 Run 的并发启动调用共享一次平台请求", async () => {
    const log: string[] = []
    const coordinator = new RemoteEnvironmentCoordinator(1, new MemoryLeaseStore())
    const managed = coordinator.manage({
      runId: "run-singleflight",
      challenge: challenge("singleflight", 0),
      capability: capability("singleflight", log),
    })

    const [first, second] = await Promise.all([
      managed.instance?.start(),
      managed.instance?.start(),
    ])

    expect(first).toEqual(second)
    expect(log).toEqual(["start:singleflight"])
    await coordinator.close()
  })

  it("只在适配器完成协议就绪检查后交付 endpoint", async () => {
    const ready = deferred<void>()
    const events: string[] = []
    const raw = capability("readiness", [])
    if (!raw.instance) throw new Error("fixture 缺少实例能力")
    raw.instance.waitUntilReady = async (environment) => {
      await ready.promise
      return { ...environment, readyAt: "2026-01-01T00:00:00.000Z" }
    }
    const coordinator = new RemoteEnvironmentCoordinator(1, new MemoryLeaseStore())
    const managed = coordinator.manage({
      runId: "run-readiness",
      challenge: challenge("readiness", 0),
      capability: raw,
      onEvent: (type) => events.push(type),
    })

    let delivered = false
    const start = managed.instance?.start().then((environment) => {
      delivered = true
      return environment
    })
    await vi.waitFor(() => expect(events).toContain("environment_starting"))
    expect(delivered).toBe(false)

    ready.resolve(undefined)
    await expect(start).resolves.toMatchObject({ readyAt: "2026-01-01T00:00:00.000Z" })
    await coordinator.close()
  })

  it("检测到租约过期后通知所有参与者，并允许原子重开", async () => {
    const updates: string[] = []
    const events: string[] = []
    let current: RemoteEnvironment | null = null
    let starts = 0
    const raw = capability("expiring", [])
    if (!raw.instance) throw new Error("fixture 缺少实例能力")
    raw.instance.start = async () => {
      starts++
      current = {
        id: `environment-expiring-${starts}`,
        challengeId: "expiring",
        status: "running",
        endpoint: "test://expiring",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }
      return current
    }
    raw.instance.status = async () => current
    const coordinator = new RemoteEnvironmentCoordinator(1, new MemoryLeaseStore())
    const managed = coordinator.manage({
      runId: "run-expiring",
      challenge: challenge("expiring", 0),
      capability: raw,
      onRevoked: (message) => {
        updates.push(message)
      },
      onEvent: (type) => events.push(type),
    })

    await managed.instance?.start()
    const active = current as RemoteEnvironment | null
    if (!active) throw new Error("fixture 未创建环境")
    current = { ...active, expiresAt: new Date(Date.now() - 1_000).toISOString() }
    await expect(managed.instance?.status()).resolves.toBeNull()
    expect(events).toContain("environment_expired")
    expect(updates.some((message) => message.includes("原子地重新开启"))).toBe(true)

    const [first, second] = await Promise.all([
      managed.instance?.start(),
      managed.instance?.start(),
    ])
    expect(first).toEqual(second)
    expect(starts).toBe(2)
    await coordinator.close()
  })

  it("附件题完成本地分析后进入 FIFO 等待并在租约释放后继续", async () => {
    const log: string[] = []
    const coordinator = new RemoteEnvironmentCoordinator(1, new MemoryLeaseStore())
    const first = coordinator.manage({
      runId: "run-first",
      challenge: challenge("first", 1),
      capability: capability("first", log),
    })
    const second = coordinator.manage({
      runId: "run-second",
      challenge: challenge("second", 1),
      capability: capability("second", log),
    })

    await first.instance?.start()
    let resolved = false
    const waiting = second.instance?.start().then(() => {
      resolved = true
    })
    await Promise.resolve()
    expect(resolved).toBe(false)

    await first.instance?.destroy()
    await waiting
    expect(log).toEqual(["start:first", "destroy:first", "start:second"])
    await coordinator.close()
  })

  it("销毁失败时保留租约和配额，重试成功后才启动下一题", async () => {
    const log: string[] = []
    const events: string[] = []
    const store = new MemoryLeaseStore()
    const coordinator = new RemoteEnvironmentCoordinator(1, store)
    const firstCapability = capability("first", log)
    const firstInstance = firstCapability.instance
    if (!firstInstance) throw new Error("fixture 缺少实例能力")
    const originalDestroy = firstInstance.destroy.bind(firstInstance)
    let destroyFails = true
    firstInstance.destroy = async () => {
      if (destroyFails) {
        log.push("destroy:first:failed")
        throw new Error("platform still rebuilding")
      }
      await originalDestroy()
    }
    const first = coordinator.manage({
      runId: "run-first",
      challenge: challenge("first", 1),
      capability: firstCapability,
      onEvent: (type) => events.push(type),
    })
    const second = coordinator.manage({
      runId: "run-second",
      challenge: challenge("second", 1),
      capability: capability("second", log),
    })

    await first.instance?.start()
    let secondStarted = false
    const waiting = second.instance?.start().then(() => {
      secondStarted = true
    })

    await expect(first.instance?.destroy()).rejects.toThrow("platform still rebuilding")
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(secondStarted).toBe(false)
    expect(store.leases.has("run-first")).toBe(true)
    expect(events).toContain("environment_release_failed")

    destroyFails = false
    await first.instance?.destroy()
    await waiting
    expect(log).toEqual(["start:first", "destroy:first:failed", "destroy:first", "start:second"])
    expect(store.leases.has("run-first")).toBe(false)
    await coordinator.close()
  })

  it("Flag accepted 后立即释放租约", async () => {
    const log: string[] = []
    const store = new MemoryLeaseStore()
    const coordinator = new RemoteEnvironmentCoordinator(1, store)
    const managed = coordinator.manage({
      runId: "run",
      challenge: challenge("terminal", 1),
      capability: capability("terminal", log),
    })

    await managed.instance?.start()
    expect(store.leases.size).toBe(1)
    await managed.submitFlag("flag")

    expect(log).toEqual(["start:terminal", "destroy:terminal"])
    expect(store.leases.size).toBe(0)
    await coordinator.close()
  })

  it("等待中的工具调用可取消且不会占用后续配额", async () => {
    const log: string[] = []
    const coordinator = new RemoteEnvironmentCoordinator(1, new MemoryLeaseStore())
    const first = coordinator.manage({
      runId: "run-first",
      challenge: challenge("first", 0),
      capability: capability("first", log),
    })
    const waiting = coordinator.manage({
      runId: "run-waiting",
      challenge: challenge("waiting", 0),
      capability: capability("waiting", log),
    })
    await first.instance?.start()
    const controller = new AbortController()
    const request = waiting.instance?.start(controller.signal)
    controller.abort()

    await expect(request).rejects.toMatchObject({ name: "AbortError" })
    await first.instance?.destroy()
    expect(log).toEqual(["start:first", "destroy:first"])
    await coordinator.close()
  })

  it("启动中的工具调用可取消并把 signal 传给平台", async () => {
    const observedSignals: AbortSignal[] = []
    const coordinator = new RemoteEnvironmentCoordinator(1, new MemoryLeaseStore(), {
      startTimeoutMs: 1_000,
      operationTimeoutMs: 100,
    })
    const blocking = capability("blocking", [])
    if (!blocking.instance) throw new Error("fixture 缺少实例能力")
    blocking.instance.start = async (signal) => {
      if (!signal) throw new Error("缺少启动 signal")
      observedSignals.push(signal)
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true })
      })
      throw new Error("unreachable")
    }
    const managed = coordinator.manage({
      runId: "run-blocking",
      challenge: challenge("blocking", 0),
      capability: blocking,
    })
    const controller = new AbortController()
    const request = managed.instance?.start(controller.signal)
    await vi.waitFor(() => expect(observedSignals).toHaveLength(1))

    controller.abort()

    await expect(request).rejects.toMatchObject({ name: "AbortError" })
    expect(observedSignals[0]?.aborted).toBe(true)
    await coordinator.close()
  })

  it("插件忽略取消时由 Core 硬超时解开工具调用和后续配额", async () => {
    const events: string[] = []
    const coordinator = new RemoteEnvironmentCoordinator(1, new MemoryLeaseStore(), {
      startTimeoutMs: 20,
      operationTimeoutMs: 20,
    })
    const stuck = capability("stuck", [])
    if (!stuck.instance) throw new Error("fixture 缺少实例能力")
    stuck.instance.start = async () => await new Promise<RemoteEnvironment>(() => undefined)
    const first = coordinator.manage({
      runId: "run-stuck",
      challenge: challenge("stuck", 0),
      capability: stuck,
      onEvent: (type) => events.push(type),
    })

    await expect(first.instance?.start()).rejects.toMatchObject({
      name: "RemoteEnvironmentStartTimeoutError",
      code: "ETIMEDOUT",
      retryable: true,
    })

    const next = coordinator.manage({
      runId: "run-next",
      challenge: challenge("next", 0),
      capability: capability("next", []),
    })
    await expect(next.instance?.start()).resolves.toMatchObject({ id: "environment-next" })
    expect(events).toContain("environment_start_failed")
    await coordinator.close()
  })

  it("一个启动卡住时不持有 Project 环境锁", async () => {
    const log: string[] = []
    const coordinator = new RemoteEnvironmentCoordinator(2, new MemoryLeaseStore(), {
      startTimeoutMs: 40,
      operationTimeoutMs: 20,
    })
    const active = coordinator.manage({
      runId: "run-active",
      challenge: challenge("active", 0),
      capability: capability("active", log),
    })
    await active.instance?.start()

    const stuck = capability("stuck-lock", log)
    if (!stuck.instance) throw new Error("fixture 缺少实例能力")
    stuck.instance.start = async () => await new Promise<RemoteEnvironment>(() => undefined)
    const starting = coordinator
      .manage({
        runId: "run-stuck-lock",
        challenge: challenge("stuck-lock", 0),
        capability: stuck,
      })
      .instance?.start()

    await active.instance?.destroy()
    expect(log).toContain("destroy:active")
    await expect(starting).rejects.toMatchObject({ name: "RemoteEnvironmentStartTimeoutError" })
    await coordinator.close()
  })

  it("启动时只清理已持久化的本系统租约", async () => {
    const store = new MemoryLeaseStore()
    store.saveEnvironmentLease({
      runId: "old-run",
      challengeId: "old-challenge",
      environmentId: "old-environment",
      priority: "verification",
      acquiredAt: new Date(0).toISOString(),
    })
    const destroy = vi.fn(async () => undefined)
    const platform = {
      bindChallenge: vi.fn(async () => ({ instance: { destroy } })),
    } as unknown as PlatformProject
    const coordinator = new RemoteEnvironmentCoordinator(1, store)

    expect(await coordinator.reconcile(platform)).toEqual([])
    expect(destroy).toHaveBeenCalledOnce()
    expect(store.leases.size).toBe(0)
    await coordinator.close()
  })
})
