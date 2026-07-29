import type { AgentOptions } from "@earendil-works/pi-agent-core"
import { describe, expect, it } from "vitest"
import type { ChallengeCapability } from "../../src/platform/types.js"
import type { CommandResult, Sandbox } from "../../src/sandbox/docker-sandbox.js"
import { CtfSolverAgent, type SolverCloseDetails } from "../../src/agent/solver-agent.js"

const agent = {
  streamFn: (() => { throw new Error("本测试不调用模型") }) as AgentOptions["streamFn"],
} satisfies AgentOptions

function challengeCapability(log: string[], destroyError?: Error): ChallengeCapability {
  return {
    getInfo: async () => ({
      id: "remote",
      title: "Remote",
      category: "pwn",
      score: 100,
      description: "test",
      attachments: [],
    }),
    downloadAttachment: async () => { throw new Error("没有附件") },
    submitFlag: async () => ({ status: "rejected", message: "wrong" }),
    instance: {
      start: async () => ({ id: "instance", challengeId: "remote", status: "running" }),
      status: async () => ({ id: "instance", challengeId: "remote", status: "running" }),
      destroy: async () => {
        log.push("instance")
        if (destroyError) throw destroyError
      },
    },
  }
}

class OrderedSandbox implements Sandbox {
  readonly id = "sandbox"
  constructor(private readonly log: string[]) {}
  async exec(): Promise<CommandResult> { return { code: 0, stdout: "", stderr: "" } }
  async close(): Promise<void> { this.log.push("sandbox") }
}

describe("CtfSolverAgent 强制清理", () => {
  it("失败关闭时先销毁远程实例，再关闭 Sandbox，最后持久化状态", async () => {
    const log: string[] = []
    let details: SolverCloseDetails | undefined
    const solver = await CtfSolverAgent.create({
      identity: {
        projectId: "project",
        runId: "run",
        workspace: "workspace",
        challenge: await challengeCapability(log).getInfo(),
      },
      capability: challengeCapability(log),
      sandbox: new OrderedSandbox(log),
      agent,
      onClosed: (value) => {
        log.push("persist")
        details = value
      },
    })

    await solver.close("failed", "模型故障")
    expect(log).toEqual(["instance", "sandbox", "persist"])
    expect(details).toEqual({ reason: "failed", error: "模型故障", cleanupErrors: [] })
  })

  it("远程实例销毁失败也会继续关闭 Sandbox 并报告清理错误", async () => {
    const log: string[] = []
    let details: SolverCloseDetails | undefined
    const capability = challengeCapability(log, new Error("API unavailable"))
    const solver = await CtfSolverAgent.create({
      identity: {
        projectId: "project",
        runId: "run",
        workspace: "workspace",
        challenge: await capability.getInfo(),
      },
      capability,
      sandbox: new OrderedSandbox(log),
      agent,
      onClosed: (value) => {
        log.push("persist")
        details = value
      },
    })

    await expect(solver.close("cancelled")).rejects.toThrow("关闭时发生错误")
    expect(log).toEqual(["instance", "sandbox", "persist"])
    expect(details?.cleanupErrors).toEqual(["远程实例销毁失败: API unavailable"])
  })
})
