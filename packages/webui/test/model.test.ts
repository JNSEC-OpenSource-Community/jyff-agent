import { describe, expect, it } from "vitest"
import { buildChallengeDetails, buildDashboardSnapshot } from "../src/model.ts"
import { FakeDashboardProject, FakeDashboardScheduler } from "./fake-project.ts"

describe("WebUI dashboard model", () => {
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
    expect(snapshot.challenges.find((challenge) => challenge.id === "pwn-1"))
      .toMatchObject({
        status: "running",
        progress: "正在执行 终端命令",
        attempts: 1,
        evidence: 1,
        openOpportunities: 1,
      })
    expect(snapshot.challenges.find((challenge) => challenge.id === "web-1"))
      .toMatchObject({ status: "solved", progress: "Flag 已确认" })
  })

  it("生成包含时间线、环境和协作黑板的单题详情", async () => {
    const project = new FakeDashboardProject()
    const details = await buildChallengeDetails(project, "pwn-1")

    expect(details?.runs).toHaveLength(1)
    expect(details?.runs[0]?.events[0]).toMatchObject({
      type: "tool_started",
      data: { toolName: "bash" },
    })
    expect(details?.environment?.endpoint).toBe("tcp://127.0.0.1:31337")
    expect(details?.blackboard.evidence[0]?.description).toBe("PIE enabled")
    await expect(buildChallengeDetails(project, "missing")).resolves.toBeUndefined()
  })

  it("把调度队列状态映射为 queued，并暴露队列位置和来源", async () => {
    const project = new FakeDashboardProject()
    const scheduler = new FakeDashboardScheduler()
    await scheduler.dispatch("misc-1")
    const snapshot = await buildDashboardSnapshot(project, scheduler)

    expect(snapshot.scheduler).toMatchObject({ autoEnabled: false })
    expect(snapshot.stats.queued).toBe(1)
    expect(snapshot.challenges.find((challenge) => challenge.id === "misc-1"))
      .toMatchObject({
        status: "queued",
        progress: "已进入调度队列",
        queuePosition: 1,
        dispatchSource: "manual",
      })
  })
})
