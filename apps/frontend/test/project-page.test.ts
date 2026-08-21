// @vitest-environment jsdom

import type { DashboardSnapshot } from "../src/types.ts"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
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
