// @vitest-environment jsdom

import type { SchedulerQueueEntry, SchedulerQueueStage } from "@ctf-agent/core"
import type { DashboardSnapshot } from "../src/types.ts"
import { cleanup, render, screen, waitFor, within } from "@testing-library/react"
import { userEvent } from "@testing-library/user-event"
import { createElement } from "react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, describe, expect, it, vi } from "vite-plus/test"
import { ProjectPage } from "../src/pages/ProjectPage.tsx"

// Iconify 通过定时器异步更新图标状态；该页面测试不关心图标内容，
// 使用静态桩避免 jsdom 环境销毁后仍触发 React state update。
vi.mock("@iconify/react", () => ({ Icon: () => null }))

class FakeEventSource {
  readonly close = vi.fn()

  constructor(readonly url: string) {}

  addEventListener(): void {}
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("ProjectPage", () => {
  it("为未开始比赛提供手动开始按钮，并提供项目范围的 Writeup 导出", async () => {
    let started = false
    const pending = {
      ...snapshot(),
      scheduler: null,
      controlPlane: {
        phase: "disconnected",
        activation: { state: "pending", scheduledStartAt: null },
      },
    } as unknown as DashboardSnapshot
    const ready = {
      ...pending,
      controlPlane: {
        phase: "ready",
        activation: { state: "started", scheduledStartAt: null },
      },
    } as unknown as DashboardSnapshot
    vi.stubGlobal("EventSource", FakeEventSource)
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url
        if (url === "/api/projects/demo/start" && init?.method === "POST") {
          started = true
          return jsonResponse({ snapshot: ready })
        }
        return jsonResponse(pending)
      }),
    )

    const user = userEvent.setup()
    render(
      createElement(
        MemoryRouter,
        { initialEntries: ["/projects/demo"] },
        createElement(
          Routes,
          null,
          createElement(Route, {
            path: "/projects/:projectId",
            element: createElement(ProjectPage),
          }),
        ),
      ),
    )

    const exportLink = await screen.findByRole("link", { name: /导出全部 WP/ })
    expect(exportLink.getAttribute("href")).toBe("/api/projects/demo/writeups/export")
    const schedulerHeading = screen.getByRole("heading", { name: "调度队列" })
    expect(schedulerHeading.previousElementSibling?.textContent).toBe("调度计划")
    const recentEmpty = screen.getByText("暂无运行记录。")
    expect(recentEmpty.parentElement?.parentElement?.getAttribute("data-slot")).toBe(
      "compact-empty",
    )
    expect(recentEmpty.parentElement?.parentElement?.className).toContain("min-h-40")
    const pendingCard = screen
      .getByText("点击“开始比赛”后才会连接平台并同步题目。")
      .closest('[data-slot="card"]')
    expect(pendingCard?.className).toContain("p-4")
    await user.click(await screen.findByRole("button", { name: "开始比赛" }))
    await waitFor(() => expect(started).toBe(true))
  })

  it("近期 Solver 永久展开，并与执行队列使用可滚动分割列表和 badge", async () => {
    const data = snapshot()
    if (!data.scheduler) throw new Error("测试快照缺少调度器")
    data.scheduler.queued = [
      {
        challengeId: "web/1",
        source: "manual",
        stage: "execution",
        lane: "normal",
        manualOverride: true,
        enqueuedAt: "2026-08-12T07:59:00.000Z",
        position: 1,
        version: 1,
      },
    ]
    data.solverLogs = [
      {
        id: 1,
        runId: "run-web-1",
        challengeId: "web/1",
        challengeTitle: "认证绕过",
        type: "run_started",
        summary: "Solver 开始运行",
        createdAt: "2026-08-12T07:59:00.000Z",
        tone: "neutral",
      },
    ]
    vi.stubGlobal("EventSource", FakeEventSource)
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => jsonResponse(data)),
    )

    render(
      createElement(
        MemoryRouter,
        { initialEntries: ["/projects/demo"] },
        createElement(
          Routes,
          null,
          createElement(Route, {
            path: "/projects/:projectId",
            element: createElement(ProjectPage),
          }),
        ),
      ),
    )

    const recentHeading = await screen.findByRole("heading", { name: "近期 Solver" })
    const recentCard = recentHeading.closest('[data-slot="card"]') as HTMLElement | null
    if (!recentCard) throw new Error("近期 Solver 卡片不存在")
    expect(recentHeading.closest("details")).toBeNull()
    expect(within(recentCard).getByText("1 条")).toBeTruthy()
    expect(within(recentCard).getByRole("link", { name: /Solver 开始运行/ })).toBeTruthy()
    expect(
      within(recentCard).getByRole("link", { name: /Solver 开始运行/ }).parentElement?.className,
    ).toContain("divide-y")
    expect(
      within(recentCard).getByRole("link", { name: /Solver 开始运行/ }).parentElement?.className,
    ).toContain("overflow-y-auto")

    expect(screen.getByRole("heading", { name: "调度队列" })).toBeTruthy()
    expect(screen.getByText("调度计划")).toBeTruthy()
    const stageAllButton = screen.getByRole("button", {
      name: "加入全部 1 道可调度题",
    })
    expect(stageAllButton.closest('[data-slot="compact-empty"]')).toBeNull()
    expect(
      within(screen.getByRole("region", { name: "空闲队列" })).queryByRole("button", {
        name: "加入全部 1 道可调度题",
      }),
    ).toBeNull()
    expect(screen.queryByText("启动前可拖动排序")).toBeNull()
    expect(screen.getAllByRole("img", { name: "可拖动或使用键盘排序" })).toHaveLength(2)

    const executionQueue = screen.getByRole("region", { name: "执行队列" })
    const queueHandle = within(executionQueue).getByRole("button", {
      name: "拖动排序：认证绕过",
    })
    const queueList = queueHandle.parentElement?.parentElement
    expect(queueList?.className).toContain("divide-y")
    expect(queueList?.className).toContain("overflow-y-auto")
  })

  it("可从题目表格批量加入和移出空闲队列，并立即同步计划", async () => {
    const initial = snapshot()
    const afterStage = structuredClone(initial)
    if (!afterStage.scheduler) throw new Error("测试快照缺少调度器")
    const stagedChallenge = afterStage.challenges[0]
    if (!stagedChallenge) throw new Error("测试快照缺少题目")
    stagedChallenge.status = "idle"
    stagedChallenge.progress = "空闲队列第 1 位"
    afterStage.scheduler.idleVersion = 2
    afterStage.scheduler.idle = [queueEntry("idle")]
    let stagedIds: string[] = []
    let unstagedIds: string[] = []

    vi.stubGlobal("EventSource", FakeEventSource)
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url
        if (url === "/api/projects/demo/scheduler/idle" && init?.method === "POST") {
          if (typeof init.body !== "string") throw new Error("批量入队请求缺少 JSON body")
          stagedIds = (JSON.parse(init.body) as { challengeIds: string[] }).challengeIds
          return jsonResponse(afterStage)
        }
        if (url === "/api/projects/demo/scheduler/idle" && init?.method === "DELETE") {
          if (typeof init.body !== "string") throw new Error("批量移出请求缺少 JSON body")
          unstagedIds = (JSON.parse(init.body) as { challengeIds: string[] }).challengeIds
          return jsonResponse(initial)
        }
        return jsonResponse(initial)
      }),
    )

    const user = userEvent.setup()
    render(
      createElement(
        MemoryRouter,
        { initialEntries: ["/projects/demo"] },
        createElement(
          Routes,
          null,
          createElement(Route, {
            path: "/projects/:projectId",
            element: createElement(ProjectPage),
          }),
        ),
      ),
    )

    await user.click(await screen.findByRole("checkbox", { name: "选择加入空闲队列：认证绕过" }))
    expect(screen.getByText(/已选/).textContent).toContain("1")
    await user.click(screen.getByRole("button", { name: "加入空闲队列" }))

    await waitFor(() => expect(stagedIds).toEqual(["web/1"]))
    const idleQueue = screen.getByRole("region", { name: "空闲队列" })
    expect(within(idleQueue).getByText("认证绕过")).toBeTruthy()
    expect(
      within(idleQueue)
        .getByRole("button", { name: "拖动排序：认证绕过" })
        .hasAttribute("disabled"),
    ).toBe(false)
    expect(within(idleQueue).getByRole("button", { name: "从空闲队列移除：认证绕过" })).toBeTruthy()

    await user.click(screen.getByRole("checkbox", { name: "选择移出空闲队列：认证绕过" }))
    await user.click(screen.getByRole("button", { name: "移出空闲队列" }))
    await waitFor(() => expect(unstagedIds).toEqual(["web/1"]))
    expect(within(idleQueue).getByText("暂无题目")).toBeTruthy()
  })

  it("键盘排序遇到版本冲突时恢复服务端顺序并给出反馈", async () => {
    const initial = snapshot()
    if (!initial.scheduler) throw new Error("测试快照缺少调度器")
    const firstChallenge = initial.challenges[0]
    if (!firstChallenge) throw new Error("测试快照缺少题目")
    firstChallenge.status = "idle"
    const secondChallenge = {
      ...firstChallenge,
      id: "crypto/2",
      title: "椭圆曲线",
      category: "crypto",
      score: 200,
    }
    initial.challenges.push(secondChallenge)
    initial.overview.challenges = 2
    initial.stats.total = 2
    initial.stats.pending = 0
    initial.stats.queued = 2
    initial.scheduler.idleVersion = 3
    initial.scheduler.idle = [queueEntry("idle", "web/1", 1), queueEntry("idle", "crypto/2", 2)]

    const latest = structuredClone(initial)
    if (!latest.scheduler) throw new Error("测试快照缺少调度器")
    latest.scheduler.idleVersion = 4
    latest.scheduler.idle = [queueEntry("idle", "crypto/2", 1), queueEntry("idle", "web/1", 2)]
    let reorderRequests = 0
    let snapshotRequests = 0

    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        const y = this.dataset.queueId === "crypto/2" ? 48 : 0
        return new DOMRect(0, y, 240, 40)
      },
    )
    vi.stubGlobal("EventSource", FakeEventSource)
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url
        if (url === "/api/projects/demo/scheduler/idle/order" && init?.method === "PUT") {
          reorderRequests += 1
          return new Response(
            JSON.stringify({
              error: "queue_version_conflict",
              message: "Scheduler queue version conflict",
              snapshot: latest,
            }),
            { status: 409, headers: { "content-type": "application/json" } },
          )
        }
        snapshotRequests += 1
        return jsonResponse(snapshotRequests === 1 ? initial : latest)
      }),
    )

    const user = userEvent.setup()
    render(
      createElement(
        MemoryRouter,
        { initialEntries: ["/projects/demo"] },
        createElement(
          Routes,
          null,
          createElement(Route, {
            path: "/projects/:projectId",
            element: createElement(ProjectPage),
          }),
        ),
      ),
    )

    const idleQueue = await screen.findByRole("region", { name: "空闲队列" })
    const firstHandle = within(idleQueue).getByRole("button", { name: "拖动排序：认证绕过" })
    firstHandle.focus()
    await user.keyboard("[Space][ArrowDown][Space]")

    await waitFor(() => expect(reorderRequests).toBe(1))
    expect(snapshotRequests).toBe(1)
    expect(await screen.findByText("队列已在其他页面更新，当前顺序已恢复为最新版本。")).toBeTruthy()
    expect(
      within(idleQueue)
        .getAllByRole("button", { name: /拖动排序/ })
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual(["拖动排序：椭圆曲线", "拖动排序：认证绕过"])
  })

  it("启动手动调度时调用专用入口，并把空闲队列迁入执行队列", async () => {
    const initial = snapshot()
    if (!initial.scheduler) throw new Error("测试快照缺少调度器")
    const initialChallenge = initial.challenges[0]
    if (!initialChallenge) throw new Error("测试快照缺少题目")
    initialChallenge.status = "idle"
    initialChallenge.progress = "空闲队列第 1 位"
    initial.scheduler.idleVersion = 2
    initial.scheduler.idle = [queueEntry("idle")]

    const running = structuredClone(initial)
    if (!running.scheduler) throw new Error("测试快照缺少调度器")
    const runningChallenge = running.challenges[0]
    if (!runningChallenge) throw new Error("测试快照缺少题目")
    runningChallenge.status = "queued"
    runningChallenge.progress = "执行队列第 1 位"
    running.scheduler.autoEnabled = true
    running.scheduler.state = "running"
    running.scheduler.mode = "manual"
    running.scheduler.idle = []
    running.scheduler.queued = [queueEntry("execution")]
    let startRequests = 0

    vi.stubGlobal("EventSource", FakeEventSource)
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url
        if (url === "/api/projects/demo/scheduler/start" && init?.method === "POST") {
          startRequests += 1
          return jsonResponse(running)
        }
        return jsonResponse(initial)
      }),
    )

    const user = userEvent.setup()
    render(
      createElement(
        MemoryRouter,
        { initialEntries: ["/projects/demo"] },
        createElement(
          Routes,
          null,
          createElement(Route, {
            path: "/projects/:projectId",
            element: createElement(ProjectPage),
          }),
        ),
      ),
    )

    await user.click(await screen.findByRole("button", { name: /启动调度/ }))
    await waitFor(() => expect(startRequests).toBe(1))
    expect(
      within(screen.getByRole("region", { name: "空闲队列" })).queryByText("认证绕过"),
    ).toBeNull()
    expect(
      within(screen.getByRole("region", { name: "执行队列" })).getByText("认证绕过"),
    ).toBeTruthy()
    expect(screen.queryByText("运行中")).toBeNull()
    expect(screen.getByRole("button", { name: "暂停调度" })).toBeTruthy()
  })

  it("调度暂停且仍有活跃任务时可确认停止全部 Solver", async () => {
    let stopped = false
    const paused = snapshot()
    if (!paused.scheduler) throw new Error("测试快照缺少调度器")
    paused.scheduler.active = [
      {
        challengeId: "web/1",
        runId: "run-web-1",
        attempt: 1,
        source: "auto",
        phase: "running",
        startedAt: "2026-08-12T07:58:00.000Z",
      },
    ]
    const afterStop = structuredClone(paused)
    if (!afterStop.scheduler) throw new Error("测试快照缺少调度器")
    afterStop.scheduler.active = []

    vi.stubGlobal("EventSource", FakeEventSource)
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url
        if (url === "/api/projects/demo/scheduler/active/stop" && init?.method === "POST") {
          stopped = true
          return jsonResponse(afterStop)
        }
        return jsonResponse(paused)
      }),
    )

    const user = userEvent.setup()
    render(
      createElement(
        MemoryRouter,
        { initialEntries: ["/projects/demo"] },
        createElement(
          Routes,
          null,
          createElement(Route, {
            path: "/projects/:projectId",
            element: createElement(ProjectPage),
          }),
        ),
      ),
    )

    await user.click(await screen.findByRole("button", { name: /停止全部 Solver/ }))
    const dialog = await screen.findByRole("alertdialog", {
      name: "停止全部正在执行的 Solver？",
    })
    expect(within(dialog).getByText(/回收其 SubAgent、远程环境和 Docker Sandbox/)).toBeTruthy()
    await user.click(within(dialog).getByRole("button", { name: "停止全部 Solver" }))

    await waitFor(() => expect(stopped).toBe(true))
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /停止全部 Solver/ })).toBeNull(),
    )
  })

  it("展示平台成绩、排名和外部比赛入口", async () => {
    const data = snapshot()
    data.overview.participant = { score: 1234, rank: 7 }
    data.overview.links = {
      contest: "https://ctf.example/game/1",
      leaderboard: "https://ctf.example/game/1/scoreboard",
    }
    vi.stubGlobal("EventSource", FakeEventSource)
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => jsonResponse(data)),
    )

    render(
      createElement(
        MemoryRouter,
        { initialEntries: ["/projects/demo"] },
        createElement(
          Routes,
          null,
          createElement(Route, {
            path: "/projects/:projectId",
            element: createElement(ProjectPage),
          }),
        ),
      ),
    )

    expect(await screen.findByRole("heading", { name: "训练赛" })).toBeTruthy()
    expect(screen.getByRole("heading", { name: "当前成绩" })).toBeTruthy()
    expect(screen.getByText("1,234 分")).toBeTruthy()
    expect(screen.getByText("#7")).toBeTruthy()
    const contestLink = screen.getByRole("link", { name: "比赛平台" })
    expect(contestLink.getAttribute("href")).toBe("https://ctf.example/game/1")
    expect(contestLink.getAttribute("target")).toBe("_blank")
    expect(screen.getByRole("link", { name: "排行榜" }).getAttribute("href")).toBe(
      "https://ctf.example/game/1/scoreboard",
    )
    expect(screen.getByRole("textbox", { name: "搜索题目" })).toBeTruthy()
    expect(screen.getByRole("columnheader", { name: "题目" }).getAttribute("scope")).toBe("col")

    const challengeLink = screen.getByRole("link", { name: /认证绕过/ })
    expect(challengeLink.getAttribute("href")).toBe("/projects/demo/challenges/web%2F1")
  })
})

function queueEntry(
  stage: SchedulerQueueStage,
  challengeId = "web/1",
  position = 1,
): SchedulerQueueEntry {
  return {
    challengeId,
    source: "manual",
    stage,
    lane: "normal",
    manualOverride: true,
    enqueuedAt: "2026-08-12T07:59:00.000Z",
    position,
    version: 1,
  }
}

function snapshot(): DashboardSnapshot {
  return {
    generatedAt: "2026-08-12T08:00:00.000Z",
    overview: {
      id: "demo",
      name: "训练赛",
      challenges: 1,
    },
    stats: { total: 1, solved: 0, active: 0, failed: 0, pending: 1, attempts: 0, queued: 0 },
    challenges: [
      {
        id: "web/1",
        title: "认证绕过",
        category: "web",
        score: 100,
        status: "pending",
        platformSolved: false,
        attempts: 0,
        latestRunId: null,
        latestRunStatus: null,
        lastActivityAt: null,
        progress: "等待派发",
        queuePosition: null,
        dispatchSource: null,
        schedulerAttempts: 0,
        sessionInterruptions: 0,
        evidence: 0,
        openOpportunities: 0,
        concludedOpportunities: 0,
      },
    ],
    categories: ["web"],
    announcements: [],
    announcementCandidates: [],
    environments: [],
    remoteEnvironment: {
      leases: [],
      capacity: { occupied: 0, maximum: 2 },
    },
    solverLogs: [],
    scheduler: {
      available: true,
      autoEnabled: false,
      state: "stopped",
      mode: "stopped",
      idleVersion: 1,
      executionVersion: 1,
      maxConcurrent: 2,
      maxAttempts: 2,
      maxSessionInterruptions: 3,
      idle: [],
      queued: [],
      active: [],
    },
    controlPlane: { phase: "ready" },
  } as unknown as DashboardSnapshot
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    headers: { "content-type": "application/json" },
  })
}
