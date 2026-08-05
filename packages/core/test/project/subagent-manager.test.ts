import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type ChallengeCapability,
  type ChallengeInfo,
  discoverSubagentRoles,
  type Sandbox,
} from "@ctf-agent/agents"
import type { CommandResult, SandboxExecOptions } from "@ctf-agent/sandbox"
import type { AgentOptions } from "@earendil-works/pi-agent-core"
import {
  createFauxCore,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai/providers/faux"
import { afterEach, describe, expect, it } from "vitest"
import {
  CtfSubagentManager,
  createSubagentManagerTools,
  type SubagentLifecycleEvent,
} from "../../src/collaboration/subagent-manager.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

class MemorySandbox implements Sandbox {
  readonly id = "shared-container"
  readonly createdDirectories: string[] = []

  async exec(
    args: string[],
    options?: SandboxExecOptions,
  ): Promise<CommandResult> {
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

const capability: ChallengeCapability = {
  getInfo: async () => challenge,
  downloadAttachment: async () => {
    throw new Error("no attachment")
  },
  submitFlag: async () => ({ status: "rejected", message: "test" }),
}

describe("CtfSubagentManager", () => {
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
      capability,
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
      role: "pwn",
      prompt: "verify the leak",
      description: "leak check",
      background: false,
    })
    const result = await manager.wait(created.id)

    expect(result).toMatchObject({
      id: created.id,
      runId: "run-1",
      role: "pwn",
      status: "completed",
      result: "verified heap leak at offset 0x20",
      background: false,
    })
    expect(result.containerCwd).toBe(`/workspace/subagents/${created.id}`)
    expect(sandbox.createdDirectories).toContain(result.containerCwd)
    expect(events).toEqual(
      expect.arrayContaining(["created", "started", "completed"]),
    )
    expect(manager.list()).toHaveLength(1)

    const resumed = await manager.resume(
      created.id,
      "verify the follow-up",
      false,
    )
    expect(resumed).toMatchObject({
      id: created.id,
      status: "completed",
      result: "follow-up confirmed libc offset",
    })
    expect(manager.list()).toHaveLength(1)
    await manager.close()
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
      capability,
      sandbox: new MemorySandbox(),
      agent: {
        streamFn: faux.streamSimple as AgentOptions["streamFn"],
        initialState: { model: faux.getModel(), thinkingLevel: "off" },
      },
      roles: discovered.roles,
    })

    expect(
      createSubagentManagerTools(manager).map((tool) => tool.name),
    ).toEqual([
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
        await new Promise((resolve) => setTimeout(resolve, 15))
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
      capability,
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
    const results = await Promise.all(
      records.map((record) => manager.wait(record.id)),
    )
    expect(results.map((record) => record.status)).toEqual([
      "completed",
      "completed",
      "completed",
    ])
    expect(maximum).toBe(1)
    await manager.close()
  })
})
