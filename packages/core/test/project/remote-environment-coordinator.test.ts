import type {
  ChallengeCapability,
  ChallengeInfo,
  PlatformProject,
  RemoteEnvironment,
} from "@ctf-agent/platform"
import { describe, expect, it, vi } from "vitest"
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
  it("无附件请求会抢占附件题验证租约", async () => {
    const log: string[] = []
    const revoked = vi.fn()
    const coordinator = new RemoteEnvironmentCoordinator(
      1,
      new MemoryLeaseStore(),
    )
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

    expect(log).toEqual([
      "start:with-file",
      "destroy:with-file",
      "start:without-file",
    ])
    expect(revoked).toHaveBeenCalledOnce()
    await coordinator.close()
  })

  it("附件题完成本地分析后进入 FIFO 等待并在租约释放后继续", async () => {
    const log: string[] = []
    const coordinator = new RemoteEnvironmentCoordinator(
      1,
      new MemoryLeaseStore(),
    )
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
    const coordinator = new RemoteEnvironmentCoordinator(
      1,
      new MemoryLeaseStore(),
    )
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
