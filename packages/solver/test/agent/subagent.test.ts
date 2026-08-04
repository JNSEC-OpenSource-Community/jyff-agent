import type { AgentOptions } from "@earendil-works/pi-agent-core"
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux"
import { describe, expect, it } from "vitest"
import type { ChallengeCapability, ChallengeInfo } from "../../src/platform/types.js"
import type { CommandResult, Sandbox, SandboxExecOptions } from "../../src/sandbox/docker-sandbox.js"
import {
  createSubagentManagerTools,
  SubagentManager,
  type CreateSubagentAgentContext,
} from "../../src/agent/subagent.js"

const challenge: ChallengeInfo = {
  id: "subagent-test",
  title: "SubAgent Test",
  category: "reverse",
  score: 200,
  description: "Inspect multiple independent paths",
  attachments: [],
}

const capability: ChallengeCapability = {
  getInfo: async () => challenge,
  downloadAttachment: async () => { throw new Error("没有附件") },
  submitFlag: async () => ({ status: "rejected", message: "worker 不应提交" }),
}

class FakeSandbox implements Sandbox {
  readonly id = "subagent-sandbox"
  readonly calls: Array<{ args: string[]; options?: SandboxExecOptions }> = []
  async exec(args: string[], options?: SandboxExecOptions): Promise<CommandResult> {
    this.calls.push({ args, options })
    if (args[0] === "rtk" && args[1] === "--version") throw new Error("rtk unavailable")
    if (args[0] === "bash") return { code: 0, stdout: "analysis output", stderr: "" }
    return { code: 0, stdout: "", stderr: "" }
  }
  async close(): Promise<void> {}
}

function reportingAgent(
  context: CreateSubagentAgentContext,
  hooks: { started?: () => void; finished?: () => void; delayMs?: number } = {},
): AgentOptions {
  const faux = createFauxCore({ provider: `subagent-${context.id}` })
  faux.setResponses([
    async () => {
      hooks.started?.()
      if (hooks.delayMs) await new Promise((resolve) => setTimeout(resolve, hooks.delayMs))
      hooks.finished?.()
      return fauxAssistantMessage(fauxToolCall("ctf_subagent_report", {
        status: "found",
        summary: `finished ${context.task}`,
        findings: [context.task],
        artifacts: [],
        commands: [],
        nextSteps: ["main verifies"],
        confidence: 0.8,
      }), { stopReason: "toolUse" })
    },
  ])
  return {
    streamFn: faux.streamSimple as AgentOptions["streamFn"],
    initialState: { model: faux.getModel(), thinkingLevel: "off" },
  }
}

describe("SubagentManager", () => {
  it("按并发上限执行多个 Worker，并回收结构化报告", async () => {
    let active = 0
    let maximum = 0
    const manager = new SubagentManager({
      runId: "run-concurrent",
      challenge,
      capability,
      sandbox: new FakeSandbox(),
      parentAgent: reportingAgent({ id: "parent", runId: "run-concurrent", challenge, task: "parent", workdir: "/workspace" }),
      feature: {
        maxConcurrent: 2,
        maxTotal: 4,
        timeoutMs: 1_000,
        createAgentOptions: (context) => reportingAgent(context, {
          started: () => { active++; maximum = Math.max(maximum, active) },
          finished: () => { active-- },
          delayMs: 30,
        }),
      },
    })

    const spawned = manager.spawn([{ task: "path-a" }, { task: "path-b" }, { task: "path-c" }])
    const waited = await manager.wait(spawned.map((item) => item.id), "all")

    expect(waited.timedOut).toBe(false)
    expect(maximum).toBe(2)
    expect(waited.subagents.map((item) => item.status)).toEqual(["completed", "completed", "completed"])
    expect(waited.subagents.map((item) => item.report?.summary)).toEqual([
      "finished path-a",
      "finished path-b",
      "finished path-c",
    ])
    await manager.close()
  })

  it("Worker bash 使用独立工作目录，且管理工具不包含递归 spawn 能力", async () => {
    const sandbox = new FakeSandbox()
    const manager = new SubagentManager({
      runId: "run-workdir",
      challenge,
      capability,
      sandbox,
      parentAgent: reportingAgent({ id: "parent", runId: "run-workdir", challenge, task: "parent", workdir: "/workspace" }),
      feature: {
        createAgentOptions: (context) => {
          const faux = createFauxCore({ provider: `workdir-${context.id}` })
          faux.setResponses([
            fauxAssistantMessage(fauxToolCall("bash", { command: "pwd" }), { stopReason: "toolUse" }),
            fauxAssistantMessage(fauxToolCall("ctf_subagent_report", {
              status: "found", summary: "done", confidence: 1,
            }), { stopReason: "toolUse" }),
          ])
          return { streamFn: faux.streamSimple as AgentOptions["streamFn"], initialState: { model: faux.getModel() } }
        },
      },
    })

    const [worker] = manager.spawn([{ task: "check cwd" }])
    await manager.wait([worker!.id])
    const bash = sandbox.calls.find((call) => call.args[0] === "bash")
    expect(bash?.options?.workdir).toBe(worker!.workdir)
    expect(createSubagentManagerTools(manager).map((tool) => tool.name)).toEqual([
      "ctf_subagent_spawn",
      "ctf_subagent_list",
      "ctf_subagent_wait",
      "ctf_subagent_cancel",
    ])
    await manager.close()
  })

  it("支持等待超时、显式取消和每 Run 总数上限", async () => {
    const manager = new SubagentManager({
      runId: "run-cancel",
      challenge,
      capability,
      sandbox: new FakeSandbox(),
      parentAgent: reportingAgent({ id: "parent", runId: "run-cancel", challenge, task: "parent", workdir: "/workspace" }),
      feature: {
        maxConcurrent: 1,
        maxTotal: 2,
        abortGraceMs: 0,
        createAgentOptions: (context) => reportingAgent(context, { delayMs: 500 }),
      },
    })
    const spawned = manager.spawn([{ task: "slow-a" }, { task: "slow-b" }])
    expect((await manager.wait([spawned[0]!.id], "all", 5)).timedOut).toBe(true)
    manager.cancel(spawned.map((item) => item.id))
    const finished = await manager.wait(undefined, "all")
    expect(finished.subagents.map((item) => item.status)).toEqual(["cancelled", "cancelled"])
    expect(() => manager.spawn([{ task: "too-many" }])).toThrow("总数超过上限")
    await manager.close()
  })

  it("硬超时会结束 Worker，但不会关闭共享 Sandbox", async () => {
    const sandbox = new FakeSandbox()
    const manager = new SubagentManager({
      runId: "run-timeout",
      challenge,
      capability,
      sandbox,
      parentAgent: reportingAgent({ id: "parent", runId: "run-timeout", challenge, task: "parent", workdir: "/workspace" }),
      feature: {
        timeoutMs: 10,
        abortGraceMs: 0,
        createAgentOptions: (context) => reportingAgent(context, { delayMs: 500 }),
      },
    })
    const [spawned] = manager.spawn([{ task: "times out" }])
    const [finished] = (await manager.wait([spawned!.id])).subagents
    expect(finished).toMatchObject({ status: "timed_out", error: "SubAgent 超过时限 10ms" })
    await manager.close()
  })

  it("创建批次校验失败时不留下半批任务，且超时覆盖 Agent 配置阶段", async () => {
    const manager = new SubagentManager({
      runId: "run-prepare-timeout",
      challenge,
      capability,
      sandbox: new FakeSandbox(),
      parentAgent: reportingAgent({ id: "parent", runId: "run-prepare-timeout", challenge, task: "parent", workdir: "/workspace" }),
      feature: {
        maxTotal: 3,
        timeoutMs: 10,
        abortGraceMs: 0,
        createAgentOptions: async (context) => {
          await new Promise((resolve) => setTimeout(resolve, 100))
          return reportingAgent(context)
        },
      },
    })

    expect(() => manager.spawn([{ task: "valid" }, { task: "   " }])).toThrow("task 不能为空")
    expect(manager.list()).toEqual([])
    const [spawned] = manager.spawn([{ task: "slow configuration" }])
    const [finished] = (await manager.wait([spawned!.id])).subagents
    expect(finished?.status).toBe("timed_out")
    await Promise.all([manager.close(), manager.close()])
  })

  it("wait(any) 在选中任务已有终态时立即返回", async () => {
    const manager = new SubagentManager({
      runId: "run-wait-any",
      challenge,
      capability,
      sandbox: new FakeSandbox(),
      parentAgent: reportingAgent({ id: "parent", runId: "run-wait-any", challenge, task: "parent", workdir: "/workspace" }),
      feature: {
        maxConcurrent: 1,
        createAgentOptions: (context) => reportingAgent(context, { delayMs: context.task === "first" ? 1 : 500 }),
      },
    })
    const spawned = manager.spawn([{ task: "first" }, { task: "second" }])
    await manager.wait([spawned[0]!.id])
    const result = await manager.wait(spawned.map((item) => item.id), "any", 0)
    expect(result).toMatchObject({ timedOut: false, aborted: false })
    await manager.close()
  })
})
