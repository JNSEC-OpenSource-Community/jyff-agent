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

  it("无附件请求会抢占附件题验证租约", async () => {
    const log: string[] = []
    const revoked = vi.fn()
    const coordinator = new RemoteEnvironmentCoordinator(1, new MemoryLeaseStore())
    const verification = coordinator.manage({
      runId: "run-verification",
      challenge: challenge("with-file", 1),
      capability: capability("with-file", log),
      onRevoked: revoked,
    })
    const required = coordinator.manage({
      runId: "run-required",
      challenge: challenge("without-file", 0),
      capability: capability("without-file", log),
    })

    await verification.instance?.start()
    await required.instance?.start()

    expect(log).toEqual(["start:with-file", "destroy:with-file", "start:without-file"])
    expect(revoked).toHaveBeenCalledOnce()
    await coordinator.close()
  })

  it("无附件请求会取消尚未完成的附件题启动预留", async () => {
    const log: string[] = []
    let observedSignal: AbortSignal | undefined
    const coordinator = new RemoteEnvironmentCoordinator(1, new MemoryLeaseStore(), {
      startTimeoutMs: 1_000,
      operationTimeoutMs: 100,
    })
    const verificationCapability = capability("starting-verification", log)
    if (!verificationCapability.instance) throw new Error("fixture 缺少实例能力")
    verificationCapability.instance.start = async (signal) => {
      if (!signal) throw new Error("缺少启动 signal")
      observedSignal = signal
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true })
      })
      throw new Error("unreachable")
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
    const requiredStart = required.instance?.start()

    await expect(verificationStart).rejects.toMatchObject({ name: "AbortError" })
    await expect(requiredStart).resolves.toMatchObject({
      id: "environment-required-after-starting",
    })
    expect(observedSignal?.aborted).toBe(true)
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
