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
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux"
import { Type } from "typebox"
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
  it("treats a provider error as partial output rather than a final report", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctf-subagent-partial-"))
    roots.push(root)
    const faux = createFauxCore({ provider: "subagent-partial" })
    faux.setResponses([
      fauxAssistantMessage("unfinished evidence", {
        stopReason: "error",
        errorMessage: "provider unavailable",
      }),
    ])
    const discovered = await discoverSubagentRoles(root)
    const manager = new CtfSubagentManager({
      projectId: "test",
      runId: "run-partial",
      runDirectory: root,
      challenge,
      sandbox: new MemorySandbox(),
      agent: {
        streamFn: faux.streamSimple as AgentOptions["streamFn"],
        initialState: { model: faux.getModel(), thinkingLevel: "off" },
      },
      roles: discovered.roles,
    })
    const created = manager.spawn({
      role: "general-purpose",
      prompt: "investigate",
      description: "partial",
      background: true,
    })
    expect(await manager.wait(created.id)).toMatchObject({
      status: "failed",
      resultKind: "assistant_partial",
      result: "unfinished evidence",
      error: "provider unavailable",
    })
    await manager.close()
  })

  it("does not start a worker when its execution cannot be persisted", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctf-subagent-begin-failure-"))
    roots.push(root)
    const faux = createFauxCore({ provider: "subagent-begin-failure" })
    const sandbox = new MemorySandbox()
    const discovered = await discoverSubagentRoles(root)
    const manager = new CtfSubagentManager({
      projectId: "test",
      runId: "run-begin-failure",
      runDirectory: root,
      challenge,
      sandbox,
      agent: {
        streamFn: faux.streamSimple as AgentOptions["streamFn"],
        initialState: { model: faux.getModel(), thinkingLevel: "off" },
      },
      roles: discovered.roles,
      persistExecution: () => {
        throw new Error("cannot persist execution")
      },
    })
    expect(() =>
      manager.spawn({
        role: "general-purpose",
        prompt: "investigate",
        description: "failure",
        background: true,
      }),
    ).toThrow("cannot persist execution")
    expect(manager.list()).toEqual([])
    expect(sandbox.createdDirectories).toEqual([])
    await manager.close()
  })

  it("keeps the previous report when a resumed execution cannot be persisted", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctf-subagent-resume-failure-"))
    roots.push(root)
    const faux = createFauxCore({ provider: "subagent-resume-failure" })
    faux.setResponses([fauxAssistantMessage("previous report")])
    const discovered = await discoverSubagentRoles(root)
    let begins = 0
    const manager = new CtfSubagentManager({
      projectId: "test",
      runId: "run-resume-failure",
      runDirectory: root,
      challenge,
      sandbox: new MemorySandbox(),
      agent: {
        streamFn: faux.streamSimple as AgentOptions["streamFn"],
        initialState: { model: faux.getModel(), thinkingLevel: "off" },
      },
      roles: discovered.roles,
      persistExecution: (_record, operation) => {
        if (operation.kind === "begin" && ++begins === 2) throw new Error("resume commit failed")
      },
    })
    const created = manager.spawn({
      role: "general-purpose",
      prompt: "investigate",
      description: "report",
      background: true,
    })
    const completed = await manager.wait(created.id)
    await expect(manager.resume(created.id, "continue", true)).rejects.toThrow(
      "resume commit failed",
    )
    expect(manager.get(created.id)).toMatchObject({
      status: "completed",
      result: "previous report",
      executionId: completed.executionId,
    })
    await manager.close()
  })

  it("surfaces a failed execution commit during finalization", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctf-subagent-finalize-persist-"))
    roots.push(root)
    const faux = createFauxCore({ provider: "subagent-finalize-persist" })
    let started!: () => void
    const start = new Promise<void>((resolve) => {
      started = resolve
    })
    faux.setResponses([
      async (_context, options) => {
        started()
        await new Promise<void>((resolve) => {
          if (options?.signal?.aborted) resolve()
          else options?.signal?.addEventListener("abort", () => resolve(), { once: true })
        })
        return fauxAssistantMessage("partial evidence")
      },
    ])
    const discovered = await discoverSubagentRoles(root)
    let begins = 0
    const manager = new CtfSubagentManager({
      projectId: "test",
      runId: "run-finalize-persist",
      runDirectory: root,
      challenge,
      sandbox: new MemorySandbox(),
      agent: {
        streamFn: faux.streamSimple as AgentOptions["streamFn"],
        initialState: { model: faux.getModel(), thinkingLevel: "off" },
      },
      roles: discovered.roles,
      persistExecution: (_record, operation) => {
        if (operation.kind === "begin" && ++begins === 2)
          throw new Error("finalization commit failed")
      },
    })
    manager.spawn({
      role: "general-purpose",
      prompt: "investigate",
      description: "running",
      background: true,
    })
    await start
    await expect(manager.finalize("Report now", 10)).rejects.toThrow("SubAgent finalization failed")
    await manager.close()
  }, 30_000)

  it("retains complete reports across versioned Unicode pages and invalidates a resumed execution", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctf-subagent-report-"))
    roots.push(root)
    const faux = createFauxCore({ provider: "subagent-report-pages" })
    const report = `${"a".repeat(7_985)}FLAG{prefix}😀${"\u0001".repeat(9_000)}TAIL{evidence}`
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    faux.setResponses([
      fauxAssistantMessage(report),
      async () => {
        await gate
        return fauxAssistantMessage(report)
      },
    ])
    const discovered = await discoverSubagentRoles(root)
    const manager = new CtfSubagentManager({
      projectId: "test",
      runId: "run-pages",
      runDirectory: root,
      challenge,
      sandbox: new MemorySandbox(),
      agent: {
        streamFn: faux.streamSimple as AgentOptions["streamFn"],
        initialState: { model: faux.getModel(), thinkingLevel: "off" },
      },
      roles: discovered.roles,
    })
    try {
      const created = manager.spawn({
        role: "general-purpose",
        prompt: "investigate",
        description: "report",
        background: true,
      })
      const completed = await manager.wait(created.id)
      expect(completed.result).toBe(report)
      expect(completed.resultKind).toBe("assistant_final")
      const tool = createSubagentManagerTools(manager).find(
        (entry) => entry.name === "get_subagent_result",
      )!
      const first = await tool.execute("first", { agent_id: created.id })
      expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(96 * 1024)
      const firstText = first.content[0]
      if (!firstText || firstText.type !== "text") throw new Error("missing report")
      const firstPage = JSON.parse(firstText.text) as {
        result: string
        resultVersion: string
        nextOffset: number
      }
      expect(firstPage.result).toContain("FLAG{prefix}")
      expect(JSON.stringify(first.details)).not.toContain("FLAG{prefix}")
      let combined = firstPage.result
      let offset: number | null = firstPage.nextOffset
      while (offset !== null) {
        const next = await tool.execute("next", {
          agent_id: created.id,
          offset,
          expectedResultVersion: firstPage.resultVersion,
        })
        expect(Buffer.byteLength(JSON.stringify(next))).toBeLessThanOrEqual(96 * 1024)
        const block = next.content[0]
        if (!block || block.type !== "text") throw new Error("missing report page")
        const data = JSON.parse(block.text) as { result: string; nextOffset: number | null }
        combined += data.result
        offset = data.nextOffset
      }
      expect(combined).toBe(report)
      await manager.resume(created.id, "repeat the investigation", true)
      const changed = await tool.execute("old-version", {
        agent_id: created.id,
        offset: 8_000,
        expectedResultVersion: firstPage.resultVersion,
      })
      expect(changed.details.code).toBe("result_changed")
      release()
      const repeated = await manager.wait(created.id)
      expect(repeated.result).toBe(report)
      expect(repeated.executionId).not.toBe(completed.executionId)
      const newPage = await tool.execute("new-version", { agent_id: created.id })
      expect(newPage.details.resultVersion).not.toBe(firstPage.resultVersion)
    } finally {
      release()
      await manager.close()
    }
  }, 30_000)

  it("makes critical persistence failures observable and does not publish an uncommitted report", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctf-subagent-persist-"))
    roots.push(root)
    const faux = createFauxCore({ provider: "subagent-persist" })
    faux.setResponses([fauxAssistantMessage("FLAG{uncommitted}")])
    const discovered = await discoverSubagentRoles(root)
    const parent = fakeParent()
    let visibleDuringCommit: string | undefined
    const manager = new CtfSubagentManager({
      projectId: "test",
      runId: "run-persist",
      runDirectory: root,
      challenge,
      sandbox: new MemorySandbox(),
      agent: {
        streamFn: faux.streamSimple as AgentOptions["streamFn"],
        initialState: { model: faux.getModel(), thinkingLevel: "off" },
      },
      roles: discovered.roles,
      persistExecution: (record, operation) => {
        if (operation.kind === "update") {
          visibleDuringCommit = manager.get(record.id)?.result
          throw new Error("database unavailable")
        }
      },
    })
    manager.attachParent(parent.agent)
    const created = manager.spawn({
      role: "general-purpose",
      prompt: "investigate",
      description: "failure",
      background: true,
    })
    await expect(manager.wait(created.id)).rejects.toThrow("database unavailable")
    expect(manager.get(created.id)).toMatchObject({
      status: "failed",
      error: expect.stringContaining("result_persistence_failed"),
    })
    expect(manager.get(created.id)?.result).toBeUndefined()
    expect(visibleDuringCommit).toBeUndefined()
    expect(JSON.stringify(parent.steered)).not.toContain("FLAG{uncommitted}")
    await manager.close()
  })

  it("delivers a candidate in the old first-screen range while another worker remains blocked", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctf-subagent-fast-result-"))
    roots.push(root)
    const faux = createFauxCore({ provider: "subagent-fast-result" })
    let release!: () => void
    let started!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const blockedStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    faux.setResponses([
      async () => {
        started()
        await gate
        return fauxAssistantMessage("blocked worker finished")
      },
      fauxAssistantMessage(`${"x".repeat(7_970)}FLAG{early_candidate}`),
    ])
    const discovered = await discoverSubagentRoles(root)
    const parent = fakeParent()
    const manager = new CtfSubagentManager({
      projectId: "test",
      runId: "run-fast",
      runDirectory: root,
      challenge,
      sandbox: new MemorySandbox(),
      agent: {
        streamFn: faux.streamSimple as AgentOptions["streamFn"],
        initialState: { model: faux.getModel(), thinkingLevel: "off" },
      },
      roles: discovered.roles,
      maxConcurrent: 2,
    })
    manager.attachParent(parent.agent)
    try {
      const blocked = manager.spawn({
        role: "general-purpose",
        prompt: "wait",
        description: "blocked",
        background: true,
      })
      await blockedStarted
      manager.spawn({
        role: "general-purpose",
        prompt: "find candidate",
        description: "candidate",
        background: true,
      })
      await waitFor(
        () => parent.steered.some((message) => message.includes("FLAG{early_candidate}")),
        10_000,
      )
      expect(manager.get(blocked.id)?.status).toBe("running")
    } finally {
      release()
      await manager.close()
    }
  }, 30_000)

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
    let workerStarted!: () => void
    const workerStart = new Promise<void>((resolve) => {
      workerStarted = resolve
    })
    faux.setResponses([
      async () => {
        workerStarted()
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
    await workerStart
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

  it("获胜回收保留运行 worker 的最近工具结果，取消余项且不注入取消通知", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctf-subagent-winner-cleanup-"))
    roots.push(root)
    const faux = createFauxCore({ provider: "subagent-winner-cleanup" })
    let secondTurnStarted!: () => void
    const secondTurn = new Promise<void>((resolve) => {
      secondTurnStarted = resolve
    })
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("report_candidate", {}, { id: "candidate" }), {
        stopReason: "toolUse",
      }),
      async (_context, options) => {
        secondTurnStarted()
        await new Promise<void>((resolve) => {
          if (options?.signal?.aborted) resolve()
          else options?.signal?.addEventListener("abort", () => resolve(), { once: true })
        })
        return fauxAssistantMessage("late polished report")
      },
    ])
    const discovered = await discoverSubagentRoles(root)
    const parent = fakeParent()
    const manager = new CtfSubagentManager({
      projectId: "test",
      runId: "run-winner-cleanup",
      runDirectory: root,
      challenge,
      sandbox: new MemorySandbox(),
      agent: {
        streamFn: faux.streamSimple as AgentOptions["streamFn"],
        initialState: { model: faux.getModel(), thinkingLevel: "off" },
      },
      roles: discovered.roles,
      webAccessTools: [
        {
          name: "report_candidate",
          label: "Report Candidate",
          description: "Return a deterministic candidate for the lifecycle test.",
          parameters: Type.Object({}),
          async execute() {
            return {
              content: [{ type: "text", text: "FLAG{winner}" }],
              details: { candidate: "FLAG{winner}" },
            }
          },
        },
      ],
    })
    manager.attachParent(parent.agent)
    const created = manager.spawn({
      role: "general-purpose",
      prompt: "find a candidate flag",
      description: "candidate search",
      background: true,
    })
    await secondTurn

    const firstClose = manager.close()
    const repeatedClose = manager.close()
    await Promise.all([firstClose, repeatedClose])

    expect(manager.get(created.id)).toMatchObject({
      status: "cancelled",
      result: expect.stringContaining("FLAG{winner}"),
    })
    expect(parent.steered).toEqual([])
    expect(() =>
      manager.spawn({
        role: "general-purpose",
        prompt: "too late",
        description: "late worker",
        background: true,
      }),
    ).toThrow("正在收尾或关闭")
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
    async promptOrSteer(message: string) {
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
