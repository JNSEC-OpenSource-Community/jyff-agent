import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ChallengeCapability } from "@ctf-agent/platform"
import {
  BLOCKED_FINALIZATION_PROMPT,
  CTF_COMPACTION_PROMPT,
} from "@ctf-agent/prompts"
import type { CommandResult, Sandbox } from "@ctf-agent/sandbox"
import { AgentHarness, type AgentOptions } from "@earendil-works/pi-agent-core"
import type { Model } from "@earendil-works/pi-ai"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  CtfSolverAgent,
  type SolverCloseDetails,
} from "../../../src/solver/agent/solver-agent.js"

const model: Model<"openai-completions"> = {
  id: "reasoning-model",
  name: "Reasoning model",
  api: "openai-completions",
  provider: "test",
  baseUrl: "https://invalid.test",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 64_000,
  maxTokens: 4_096,
}

const agent = {
  streamFn: (() => {
    throw new Error("本测试不调用模型")
  }) as AgentOptions["streamFn"],
  initialState: { model },
} satisfies AgentOptions

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

async function runDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "solver-agent-"))
  roots.push(root)
  return root
}

function challengeCapability(
  log: string[],
  destroyError?: Error,
): ChallengeCapability {
  return {
    getInfo: async () => ({
      id: "remote",
      title: "Remote",
      category: "pwn",
      score: 100,
      description: "test",
      attachments: [],
    }),
    downloadAttachment: async () => {
      throw new Error("没有附件")
    },
    submitFlag: async () => ({ status: "rejected", message: "wrong" }),
    instance: {
      start: async () => ({
        id: "instance",
        challengeId: "remote",
        status: "running",
      }),
      status: async () => ({
        id: "instance",
        challengeId: "remote",
        status: "running",
      }),
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
  async exec(): Promise<CommandResult> {
    return { code: 0, stdout: "", stderr: "" }
  }
  async close(): Promise<void> {
    this.log.push("sandbox")
  }
}

describe("CtfSolverAgent 强制清理", () => {
  it("将 CTF_COMPACTION_PROMPT 原样传给 Pi compact", async () => {
    const compact = vi
      .spyOn(AgentHarness.prototype, "compact")
      .mockResolvedValue({
        summary: "compacted investigation",
        tokensBefore: 1_024,
      })
    const log: string[] = []
    const capability = challengeCapability(log)
    const solver = await CtfSolverAgent.create({
      identity: {
        projectId: "project",
        runId: "run",
        runDirectory: await runDirectory(),
        workspace: "workspace",
        challenge: await capability.getInfo(),
      },
      capability,
      sandbox: new OrderedSandbox(log),
      agent,
    })

    await expect(solver.compact()).resolves.toMatchObject({
      summary: "compacted investigation",
    })
    expect(compact).toHaveBeenCalledExactlyOnceWith(CTF_COMPACTION_PROMPT)
    expect(CTF_COMPACTION_PROMPT).toContain("<challenge_context>")
    expect(CTF_COMPACTION_PROMPT).toContain("<challenge_blackboard>")
    expect(CTF_COMPACTION_PROMPT).toContain("<challenge_announcements>")
    expect(CTF_COMPACTION_PROMPT).toContain("<active_subagents>")
    expect(CTF_COMPACTION_PROMPT).not.toContain("active SubAgent tasks")
    await solver.close("manual")
  })

  it("阻塞收尾要求清理 workspace 并记录保留文件用途", () => {
    expect(BLOCKED_FINALIZATION_PROMPT).toContain("Clean the workspace")
    expect(BLOCKED_FINALIZATION_PROMPT).toContain("exact path and purpose")
  })

  it("失败关闭时先回收 SubAgent，再销毁实例、Sandbox 并持久化状态", async () => {
    const log: string[] = []
    let details: SolverCloseDetails | undefined
    const solver = await CtfSolverAgent.create({
      identity: {
        projectId: "project",
        runId: "run",
        runDirectory: await runDirectory(),
        workspace: "workspace",
        challenge: await challengeCapability(log).getInfo(),
      },
      capability: challengeCapability(log),
      sandbox: new OrderedSandbox(log),
      agent,
      onBeforeCleanup: () => {
        log.push("subagents")
      },
      onClosed: (value) => {
        log.push("persist")
        details = value
      },
    })

    await solver.close("failed", "模型故障")
    expect(log).toEqual(["subagents", "instance", "sandbox", "persist"])
    expect(details).toEqual({
      reason: "failed",
      error: "模型故障",
      cleanupErrors: [],
    })
  })

  it("远程实例销毁失败也会继续关闭 Sandbox 并报告清理错误", async () => {
    const log: string[] = []
    let details: SolverCloseDetails | undefined
    const capability = challengeCapability(log, new Error("API unavailable"))
    const solver = await CtfSolverAgent.create({
      identity: {
        projectId: "project",
        runId: "run",
        runDirectory: await runDirectory(),
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
    expect(details?.cleanupErrors).toEqual([
      "远程实例销毁失败: API unavailable",
    ])
  })

  it("writeup 模式只保留文件读写工具", async () => {
    const log: string[] = []
    const solver = await CtfSolverAgent.create({
      identity: {
        projectId: "project",
        runId: "run",
        runDirectory: await runDirectory(),
        workspace: "workspace",
        challenge: await challengeCapability(log).getInfo(),
      },
      capability: challengeCapability(log),
      sandbox: new OrderedSandbox(log),
      agent,
    })

    await solver.prepareWriteup()
    expect(solver.activeTools.map((tool) => tool.name).sort()).toEqual([
      "edit",
      "list",
      "read",
      "write",
    ])
    await solver.close("manual")
  })

  it("setThinkingLevel 更新 state.thinkingLevel(下一 turn 生效的注入源)", async () => {
    const log: string[] = []
    const solver = await CtfSolverAgent.create({
      identity: {
        projectId: "project",
        runId: "run",
        runDirectory: await runDirectory(),
        workspace: "workspace",
        challenge: await challengeCapability(log).getInfo(),
      },
      capability: challengeCapability(log),
      sandbox: new OrderedSandbox(log),
      agent: {
        ...agent,
        initialState: { ...agent.initialState, thinkingLevel: "high" },
      },
    })

    expect(solver.state.thinkingLevel).toBe("high")
    await solver.setThinkingLevel("max")
    expect(solver.state.thinkingLevel).toBe("high")
    await solver.setThinkingLevel("off")
    expect(solver.state.thinkingLevel).toBe("off")
    await solver.close("manual")
  })
})
