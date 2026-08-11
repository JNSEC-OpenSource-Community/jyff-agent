import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type ChallengeInfo,
  type CtfSolverAgent,
  discoverSubagentRoles,
  type Sandbox,
} from "@ctf-agent/agents"
import type { CommandResult, SandboxExecOptions } from "@ctf-agent/sandbox"
import type { AgentHarnessEvent, AgentOptions } from "@earendil-works/pi-agent-core"
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux"
import { afterEach, describe, expect, it } from "vite-plus/test"
import {
  CtfSubagentManager,
  createSubagentManagerTools,
  type SubagentLifecycleEvent,
} from "../../src/collaboration/subagent-manager.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

class MemorySandbox implements Sandbox {
  readonly id = "shared-container"
  readonly createdDirectories: string[] = []

  async exec(args: string[], options?: SandboxExecOptions): Promise<CommandResult> {
    if (args[0] === "python3") {
      const payload = JSON.parse(options?.input ?? "{}") as {
        op?: string
        path?: string
      }
      if (payload.op === "mkdir" && payload.path) {
        this.createdDirectories.push(payload.path)
      }
      return {
        code: 0,
        stdout: JSON.stringify({ ok: true, value: null }),
        stderr: "",
      }
    }
    return { code: 0, stdout: "", stderr: "" }
  }

  async close(): Promise<void> {}
}

const challenge: ChallengeInfo = {
  id: "pwn-1",
  title: "Heap Garden",
  category: "pwn",
  score: 500,
  description: "find the primitive",
  attachments: [],
}

describe("CtfSubagentManager", () => {
  it("后台完成后立即 steer 结构化通知给主 Solver", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctf-subagent-notify-"))
    roots.push(root)
    const faux = createFauxCore({ provider: "subagent-notify" })
    faux.setResponses([fauxAssistantMessage("verified offset < 0x40")])
    const discovered = await discoverSubagentRoles(root)
    const parent = fakeParent()
    const manager = new CtfSubagentManager({
      projectId: "test",
      runId: "run-notify",
      runDirectory: root,
      challenge,
      sandbox: new MemorySandbox(),
      agent: {
        streamFn: faux.streamSimple as AgentOptions["streamFn"],
        initialState: { model: faux.getModel(), thinkingLevel: "off" },
      },
      roles: discovered.roles,
    })
    manager.attachParent(parent.agent)

    const created = manager.spawn({
      role: "general-purpose",
      prompt: "verify the offset",
      description: "offset check",
      background: true,
    })
    await manager.wait(created.id)
    await waitFor(() => parent.steered.length === 1)

    expect(parent.steered[0]).toContain("<subagent_notification>")
    expect(parent.steered[0]).toContain(`<id>${created.id}</id>`)
    expect(parent.steered[0]).toContain("verified offset &lt; 0x40")
    expect(parent.followedUp).toEqual([])
    await manager.close()
  })

  it("wait 模式在父 Solver 收到 steer 时中断但不取消 worker", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctf-subagent-wait-steer-"))
    roots.push(root)
    const faux = createFauxCore({ provider: "subagent-wait-steer" })
    let finishWorker!: () => void
    const workerGate = new Promise<void>((resolve) => {
      finishWorker = resolve
    })
    faux.setResponses([
      async () => {
        await workerGate
        return fauxAssistantMessage("worker eventually finished")
      },
    ])
    const discovered = await discoverSubagentRoles(root)
    const parent = fakeParent()
    const manager = new CtfSubagentManager({
      projectId: "test",
      runId: "run-wait-steer",
      runDirectory: root,
      challenge,
      sandbox: new MemorySandbox(),
      agent: {
        streamFn: faux.streamSimple as AgentOptions["streamFn"],
        initialState: { model: faux.getModel(), thinkingLevel: "off" },
      },
      roles: discovered.roles,
    })
    manager.attachParent(parent.agent)
    const created = manager.spawn({
      role: "general-purpose",
      prompt: "long investigation",
      description: "long worker",
      background: true,
    })
    await waitFor(() => manager.get(created.id)?.status === "running")

    const waiting = manager.waitForTool(created.id)
    let uninterruptedSettled = false
    const uninterrupted = manager.waitForTool(created.id, undefined, false).finally(() => {
      uninterruptedSettled = true
    })
    parent.queueSteer()
    await expect(waiting).resolves.toMatchObject({
      waitInterrupted: true,
      record: { id: created.id, status: "running" },
    })
    expect(manager.get(created.id)?.status).toBe("running")
    await Promise.resolve()
    expect(uninterruptedSettled).toBe(false)

    finishWorker()
    await expect(uninterrupted).resolves.toMatchObject({
      waitInterrupted: false,
      record: {
        status: "completed",
        result: "worker eventually finished",
      },
    })
    await manager.close()
  })

  it("以前台任务返回结果，并保留稳定 worker 记录和生命周期", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctf-subagent-manager-"))
    roots.push(root)
    const faux = createFauxCore({ provider: "subagent-test" })
    faux.setResponses([
      fauxAssistantMessage("verified heap leak at offset 0x20"),
      fauxAssistantMessage("follow-up confirmed libc offset"),
    ])
    const sandbox = new MemorySandbox()
    const discovered = await discoverSubagentRoles(root)
    const events: SubagentLifecycleEvent[] = []
    const manager = new CtfSubagentManager({
      projectId: "test",
      runId: "run-1",
      runDirectory: root,
      challenge,
      sandbox,
      agent: {
        streamFn: faux.streamSimple as AgentOptions["streamFn"],
        initialState: { model: faux.getModel(), thinkingLevel: "off" },
      },
      roles: discovered.roles,
      onRecord: (_record, event) => {
        events.push(event)
      },
    })

    const created = manager.spawn({
      role: "general-purpose",
      prompt: "verify the leak",
      description: "leak check",
      background: false,
    })
    const result = await manager.wait(created.id)

    expect(result).toMatchObject({
      id: created.id,
      runId: "run-1",
      role: "general-purpose",
      status: "completed",
      result: "verified heap leak at offset 0x20",
      background: false,
    })
    expect(result.containerCwd).toBe(`/workspace/subagents/${created.id}`)
    expect(sandbox.createdDirectories).toContain(result.containerCwd)
    expect(events).toEqual(expect.arrayContaining(["created", "started", "completed"]))
    expect(manager.list()).toHaveLength(1)

    const steered = await manager.steer(created.id, "verify the follow-up")
    expect(steered).toMatchObject({
      id: created.id,
      status: "queued",
      background: true,
    })
    const resumed = await manager.wait(created.id)
    expect(resumed).toMatchObject({
      id: created.id,
      status: "completed",
      result: "follow-up confirmed libc offset",
    })
    expect(manager.list()).toHaveLength(1)
    await manager.close()
  })

  it("可从重启后 interrupted 记录恢复 JSONL 会话", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctf-subagent-restore-"))
    roots.push(root)
    const discovered = await discoverSubagentRoles(root)
    const sandbox = new MemorySandbox()
    const firstCore = createFauxCore({ provider: "subagent-restore" })
    firstCore.setResponses([fauxAssistantMessage("first investigation")])
    const first = new CtfSubagentManager({
      projectId: "test",
      runId: "run-restore",
      runDirectory: root,
      challenge,
      sandbox,
      agent: {
        streamFn: firstCore.streamSimple as AgentOptions["streamFn"],
        initialState: { model: firstCore.getModel(), thinkingLevel: "off" },
      },
      roles: discovered.roles,
    })
    const created = first.spawn({
      role: "general-purpose",
      prompt: "inspect the binary",
      description: "initial inspection",
      background: false,
    })
    const completed = await first.wait(created.id)
    await first.close()

    const resumedCore = createFauxCore({ provider: "subagent-restore" })
    resumedCore.setResponses([fauxAssistantMessage("continued from JSONL")])
    const resumed = new CtfSubagentManager({
      projectId: "test",
      runId: "run-restore",
      runDirectory: root,
      challenge,
      sandbox,
      agent: {
        streamFn: resumedCore.streamSimple as AgentOptions["streamFn"],
        initialState: { model: resumedCore.getModel(), thinkingLevel: "off" },
      },
      roles: discovered.roles,
    })
    resumed.restore([completed])

    const steered = await resumed.steer(created.id, "continue the investigation")
    expect(steered).toMatchObject({
      id: created.id,
      status: "queued",
      background: true,
      sessionPath: completed.sessionPath,
    })
    const result = await resumed.wait(created.id)
    expect(result).toMatchObject({
      id: created.id,
      status: "completed",
      result: "continued from JSONL",
      sessionPath: completed.sessionPath,
    })
    await resumed.close()
  })

  it("暴露兼容工具名，并拒绝不存在的角色", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctf-subagent-tools-"))
    roots.push(root)
    const faux = createFauxCore({ provider: "subagent-tools" })
    const discovered = await discoverSubagentRoles(root)
    const manager = new CtfSubagentManager({
      projectId: "test",
      runId: "run-2",
      runDirectory: root,
      challenge,
      sandbox: new MemorySandbox(),
      agent: {
        streamFn: faux.streamSimple as AgentOptions["streamFn"],
        initialState: { model: faux.getModel(), thinkingLevel: "off" },
      },
      roles: discovered.roles,
    })

    expect(createSubagentManagerTools(manager).map((tool) => tool.name)).toEqual([
      "Agent",
      "get_subagent_result",
      "steer_subagent",
      "cancel_subagent",
      "list_subagents",
    ])
    expect(() =>
      manager.spawn({
        role: "pw",
        prompt: "invalid",
        description: "invalid",
        background: true,
      }),
    ).toThrow("未知或已禁用")
    await manager.close()
  })

  it("在异步会话初始化前预占后台槽位，严格执行并发上限", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctf-subagent-queue-"))
    roots.push(root)
    const faux = createFauxCore({ provider: "subagent-queue" })
    let active = 0
    let maximum = 0
    faux.setResponses(
      [1, 2, 3].map((index) => async () => {
        active++
        maximum = Math.max(maximum, active)
        await new Promise((resolve) => setTimeout(resolve, 0))
        active--
        return fauxAssistantMessage(`worker ${index} done`)
      }),
    )
    const discovered = await discoverSubagentRoles(root)
    const manager = new CtfSubagentManager({
      projectId: "test",
      runId: "run-queue",
      runDirectory: root,
      challenge,
      sandbox: new MemorySandbox(),
      agent: {
        streamFn: faux.streamSimple as AgentOptions["streamFn"],
        initialState: { model: faux.getModel(), thinkingLevel: "off" },
      },
      roles: discovered.roles,
      maxConcurrent: 1,
    })
    const records = [1, 2, 3].map((index) =>
      manager.spawn({
        role: "general-purpose",
        prompt: `task ${index}`,
        description: `worker ${index}`,
        background: true,
      }),
    )

    expect(manager.get(records[1]?.id ?? "")?.status).toBe("queued")
    expect(manager.get(records[2]?.id ?? "")?.status).toBe("queued")
    const results = await Promise.all(records.map((record) => manager.wait(record.id)))
    expect(results.map((record) => record.status)).toEqual(["completed", "completed", "completed"])
    expect(maximum).toBe(1)
    await manager.close()
  })

  it("blocking 收尾等待运行 worker 完成并取消尚未启动的任务", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctf-subagent-finalize-"))
    roots.push(root)
    const faux = createFauxCore({ provider: "subagent-finalize" })
    faux.setResponses([
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
        return fauxAssistantMessage("initial work")
      },
      fauxAssistantMessage("complete final report"),
    ])
    const discovered = await discoverSubagentRoles(root)
    const manager = new CtfSubagentManager({
      projectId: "test",
      runId: "run-finalize",
      runDirectory: root,
      challenge,
      sandbox: new MemorySandbox(),
      agent: {
        streamFn: faux.streamSimple as AgentOptions["streamFn"],
        initialState: { model: faux.getModel(), thinkingLevel: "off" },
      },
      roles: discovered.roles,
      maxConcurrent: 1,
    })
    const running = manager.spawn({
      role: "general-purpose",
      prompt: "investigate",
      description: "running worker",
      background: true,
    })
    await waitFor(() => manager.get(running.id)?.status === "running")
    const queued = manager.spawn({
      role: "general-purpose",
      prompt: "queued investigation",
      description: "queued worker",
      background: true,
    })

    const records = await manager.finalize("Produce the final report now.", 500)

    expect(records.find((record) => record.id === running.id)).toMatchObject({
      status: "completed",
      result: "complete final report",
    })
    expect(records.find((record) => record.id === queued.id)).toMatchObject({
      status: "cancelled",
    })
    expect(records.every((record) => record.status !== "running")).toBe(true)
    expect(() =>
      manager.spawn({
        role: "general-purpose",
        prompt: "too late",
        description: "late worker",
        background: true,
      }),
    ).toThrow("正在收尾")
    await manager.close()
  })
})

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("等待 SubAgent 状态超时")
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

function fakeParent(): {
  agent: CtfSolverAgent
  steered: string[]
  followedUp: string[]
  queueSteer(): void
} {
  const steered: string[] = []
  const followedUp: string[] = []
  const listeners = new Set<(event: AgentHarnessEvent) => void>()
  let queued = false
  const parent = {
    isClosed: false,
    hasQueuedSteerMessages: () => queued,
    subscribe(listener: (event: AgentHarnessEvent) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async steer(message: string) {
      steered.push(message)
    },
    async followUp(message: string) {
      followedUp.push(message)
    },
  }
  return {
    agent: parent as unknown as CtfSolverAgent,
    steered,
    followedUp,
    queueSteer() {
      queued = true
      for (const listener of listeners) {
        listener({
          type: "queue_update",
          steer: [{ role: "user", content: "notice", timestamp: Date.now() }],
          followUp: [],
          nextTurn: [],
        })
      }
    },
  }
}
