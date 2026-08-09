import { describe, expect, it } from "vitest"
import {
  agentCacheStats,
  buildChallengeDetails,
  buildDashboardSnapshot,
} from "../src/domain/view.ts"
import { FakeDashboardProject, FakeDashboardScheduler } from "./fake-project.ts"

describe("WebUI dashboard model", () => {
  it("按 cacheRead / (input + cacheRead) 聚合 Run 缓存率", () => {
    const cache = agentCacheStats([
      {
        id: 1,
        runId: "run-1",
        type: "agent_usage",
        data: { input: 200, cacheRead: 800, cacheWrite: 50 },
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: 2,
        runId: "run-1",
        type: "agent_usage",
        data: { input: 100, cacheRead: 100, cacheWrite: 0 },
        createdAt: "2026-01-01T00:01:00.000Z",
      },
    ])
    expect(cache).toEqual({
      inputTokens: 300,
      cacheReadTokens: 900,
      cacheWriteTokens: 50,
      cacheRate: 0.75,
    })
    expect(agentCacheStats([]).cacheRate).toBeNull()
  })

  it("合并平台、Run 和黑板数据，生成题目状态与统计", async () => {
    const project = new FakeDashboardProject()
    const snapshot = await buildDashboardSnapshot(project)

    expect(snapshot.overview.name).toBe("Test CTF")
    expect(snapshot.categories).toEqual(["misc", "pwn", "web"])
    expect(snapshot.stats).toEqual({
      total: 3,
      solved: 1,
      active: 1,
      failed: 0,
      pending: 1,
      attempts: 1,
      queued: 0,
    })
    expect(
      snapshot.challenges.find((challenge) => challenge.id === "pwn-1"),
    ).toMatchObject({
      status: "running",
      progress: "正在执行 终端命令",
      attempts: 1,
      evidence: 1,
      openOpportunities: 1,
    })
    expect(
      snapshot.challenges.find((challenge) => challenge.id === "pwn-1"),
    ).not.toHaveProperty("needsEnv")
    expect(
      snapshot.challenges.find((challenge) => challenge.id === "web-1"),
    ).toMatchObject({ status: "solved", progress: "Flag 已确认" })
    expect(project.latestRunEventCalls).toBe(1)
    expect(project.runEventsCalls).toBe(0)
  })

  it("生成包含时间线、环境和协作黑板的单题详情", async () => {
    const project = new FakeDashboardProject()
    const details = await buildChallengeDetails(project, "pwn-1")

    expect(details?.runs).toHaveLength(1)
    expect(details?.runs[0]?.events[0]).toMatchObject({
      type: "tool_started",
      data: { toolName: "bash" },
    })
    expect(details?.runs[0]?.hasConversation).toBe(true)
    expect(details?.runs[0]?.subagents[0]?.hasConversation).toBe(true)
    expect(details?.environment?.endpoint).toBe("tcp://127.0.0.1:31337")
    expect(details?.blackboard.evidence[0]?.description).toBe("PIE enabled")
    await expect(
      buildChallengeDetails(project, "missing"),
    ).resolves.toBeUndefined()
  })

  it("未产生 Agent 消息或工具调用的 attempt 不标记为可导出", async () => {
    const project = new FakeDashboardProject()
    project.eventValues.set("run-pwn-1", [
      {
        id: 1,
        runId: "run-pwn-1",
        type: "run_created",
        createdAt: "2026-07-29T11:55:00.000Z",
      },
    ])
    const subagent = project.subagentValues.get("run-pwn-1")?.[0]
    if (!subagent) throw new Error("测试 SubAgent 缺失")
    project.subagentValues.set("run-pwn-1", [
      {
        ...subagent,
        turns: 0,
        toolUses: 0,
        totalTokens: 0,
        result: undefined,
      },
    ])

    const details = await buildChallengeDetails(project, "pwn-1")
    expect(details?.runs[0]?.hasConversation).toBe(false)
    expect(details?.runs[0]?.subagents[0]?.hasConversation).toBe(false)
  })

  it("题目详情复用当前 Dashboard 快照，不重复访问平台", async () => {
    const project = new FakeDashboardProject()
    const snapshot = await buildDashboardSnapshot(project)
    const overviewCalls = project.overviewCalls

    const details = await buildChallengeDetails(
      project,
      "pwn-1",
      undefined,
      snapshot,
    )

    expect(details?.challenge.title).toBe("Heap Garden")
    expect(project.overviewCalls).toBe(overviewCalls)
  })

  it("详情合并旧版逐片 thinking 事件，避免超大时间线", async () => {
    const project = new FakeDashboardProject()
    project.eventValues.get("run-pwn-1")?.push(
      {
        id: 2,
        runId: "run-pwn-1",
        type: "agent_thinking",
        data: { text: "先看" },
        createdAt: "2026-07-29T12:00:01.000Z",
      },
      {
        id: 3,
        runId: "run-pwn-1",
        type: "agent_thinking",
        data: { text: "保护" },
        createdAt: "2026-07-29T12:00:01.100Z",
      },
      {
        id: 4,
        runId: "run-pwn-1",
        type: "agent_thinking",
        data: { text: "机制" },
        createdAt: "2026-07-29T12:00:01.200Z",
      },
    )

    const details = await buildChallengeDetails(project, "pwn-1")
    const thinking = details?.runs[0]?.events.filter(
      (event) => event.type === "agent_thinking",
    )
    expect(thinking).toHaveLength(1)
    expect(thinking?.[0]?.data).toMatchObject({ text: "先看保护机制" })
  })

  it("把调度队列状态映射为 queued，并暴露队列位置和来源", async () => {
    const project = new FakeDashboardProject()
    const scheduler = new FakeDashboardScheduler()
    await scheduler.dispatch("misc-1")
    const snapshot = await buildDashboardSnapshot(project, scheduler)

    expect(snapshot.scheduler).toMatchObject({ autoEnabled: false })
    expect(snapshot.stats.queued).toBe(1)
    expect(
      snapshot.challenges.find((challenge) => challenge.id === "misc-1"),
    ).toMatchObject({
      status: "queued",
      progress: "已进入调度队列",
      queuePosition: 1,
      dispatchSource: "manual",
    })
  })

  it("最后事件为 human_message/agent_message/agent_usage 时映射进度文案", async () => {
    const project = new FakeDashboardProject()
    project.eventValues.get("run-pwn-1")?.push({
      id: 2,
      runId: "run-pwn-1",
      type: "human_message",
      data: { text: "先检查文件头", ts: "2026-07-29T12:01:00.000Z" },
      createdAt: "2026-07-29T12:01:00.000Z",
    })
    const human = await buildDashboardSnapshot(project)
    expect(
      human.challenges.find((challenge) => challenge.id === "pwn-1")?.progress,
    ).toBe("已发送人工消息")

    project.eventValues.get("run-pwn-1")?.push({
      id: 3,
      runId: "run-pwn-1",
      type: "agent_message",
      data: { text: "收到，开始分析", ts: "2026-07-29T12:01:10.000Z" },
      createdAt: "2026-07-29T12:01:10.000Z",
    })
    const agent = await buildDashboardSnapshot(project)
    expect(
      agent.challenges.find((challenge) => challenge.id === "pwn-1")?.progress,
    ).toBe("Agent 正在回复")

    project.eventValues.get("run-pwn-1")?.push({
      id: 4,
      runId: "run-pwn-1",
      type: "agent_usage",
      data: {
        input: 100,
        output: 50,
        totalTokens: 150,
        ts: "2026-07-29T12:01:30.000Z",
      },
      createdAt: "2026-07-29T12:01:30.000Z",
    })
    const usage = await buildDashboardSnapshot(project)
    expect(
      usage.challenges.find((challenge) => challenge.id === "pwn-1")?.progress,
    ).toBe("已记录本轮用量")

    // 详情时间线应包含全部新事件
    const details = await buildChallengeDetails(project, "pwn-1")
    expect(details?.runs[0]?.events.map((event) => event.type)).toEqual([
      "tool_started",
      "human_message",
      "agent_message",
      "agent_usage",
    ])
  })
})
