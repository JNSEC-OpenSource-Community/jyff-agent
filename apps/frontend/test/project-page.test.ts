// @vitest-environment jsdom

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
    await user.click(await screen.findByRole("button", { name: "开始比赛" }))
    await waitFor(() => expect(started).toBe(true))
  })

  it("近期 Solver 永久展开，并与待执行队列使用可滚动分割列表和 badge", async () => {
    const data = snapshot()
    if (!data.scheduler) throw new Error("测试快照缺少调度器")
    data.scheduler.queued = [
      {
        challengeId: "web/1",
        source: "manual",
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

    const queueHeading = screen.getByRole("heading", { name: "待执行队列" })
    const queueCard = queueHeading.closest('[data-slot="card"]') as HTMLElement | null
    if (!queueCard) throw new Error("待执行队列卡片不存在")
    const queueRow = within(queueCard).getByText("认证绕过").closest('[role="button"]')
    expect(queueRow?.parentElement?.className).toContain("divide-y")
    expect(queueRow?.parentElement?.className).toContain("overflow-y-auto")
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

  it("使用项目范围的题目链接并为筛选表格提供语义标签", async () => {
    vi.stubGlobal("EventSource", FakeEventSource)
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => jsonResponse(snapshot())),
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
    expect(screen.getByRole("textbox", { name: "搜索题目" })).toBeTruthy()
    expect(screen.getByRole("columnheader", { name: "题目" }).getAttribute("scope")).toBe("col")

    const challengeLink = screen.getByRole("link", { name: /认证绕过/ })
    expect(challengeLink.getAttribute("href")).toBe("/projects/demo/challenges/web%2F1")
  })
})

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
    scheduler: { available: true, autoEnabled: false, queued: [] },
    controlPlane: { phase: "ready" },
  } as unknown as DashboardSnapshot
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    headers: { "content-type": "application/json" },
  })
}
