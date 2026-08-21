// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { userEvent } from "@testing-library/user-event"
import { createElement } from "react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, describe, expect, it, vi } from "vite-plus/test"
import { AppProvider } from "../src/app/AppProvider.tsx"
import { NewProjectPage, ProjectsPage } from "../src/pages/ProjectsPage.tsx"

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("ProjectsPage", () => {
  it("手动开始模式不探测平台，并提交延迟开始选项", async () => {
    let createdBody: Record<string, unknown> | undefined
    let probeCalled = false
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url
        if (url === "/api/auth") {
          return jsonResponse({ enabled: false, authenticated: true, username: null })
        }
        if (url === "/api/audits") return jsonResponse({ audits: [] })
        if (url === "/api/projects" && init?.method === "POST") {
          const body =
            typeof init.body === "string" ? init.body : await new Response(init.body).text()
          createdBody = JSON.parse(body) as Record<string, unknown>
          return jsonResponse({ project: { projectId: "manual-ctf" } })
        }
        if (url === "/api/projects") return jsonResponse({ selectedProjectId: null, projects: [] })
        if (url === "/api/control-plane") {
          return jsonResponse({
            state: {},
            config: null,
            platforms: [
              {
                id: "ctfd",
                setup: {
                  label: "CTFd",
                  description: "测试平台",
                  defaultConfig: {},
                  fields: [],
                  authStrategies: [],
                },
              },
            ],
            secrets: {},
          })
        }
        if (url === "/api/projects/test") {
          probeCalled = true
          return jsonResponse({})
        }
        throw new Error(`未处理的请求：${url}`)
      }),
    )

    const user = userEvent.setup()
    render(
      createElement(
        MemoryRouter,
        { initialEntries: ["/projects/new"] },
        createElement(
          AppProvider,
          null,
          createElement(
            Routes,
            null,
            createElement(Route, {
              path: "/projects/new",
              element: createElement(NewProjectPage),
            }),
          ),
        ),
      ),
    )

    await user.click(await screen.findByRole("radio", { name: /稍后手动开始/ }))
    fireEvent.change(await screen.findByLabelText("比赛名称"), {
      target: { value: "Manual CTF" },
    })
    await user.click(await screen.findByRole("button", { name: "保存比赛" }))
    await waitFor(() => expect(createdBody?.start).toEqual({ mode: "manual" }))
    expect(probeCalled).toBe(false)
  })

  it("将待手动开始比赛展示为可开始状态，并调用项目开始接口", async () => {
    let started = false
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url
        if (url === "/api/auth") {
          return jsonResponse({ enabled: false, authenticated: true, username: null })
        }
        if (url === "/api/audits") return jsonResponse({ audits: [] })
        if (url === "/api/projects/manual-start/start") {
          started = true
          return jsonResponse({})
        }
        if (url === "/api/projects") {
          return jsonResponse({
            selectedProjectId: "manual-start",
            projects: [
              {
                id: "manual-start",
                name: "手动比赛",
                platformId: "ctfd",
                phase: started ? "ready" : "disconnected",
                archived: false,
                activation: {
                  state: started ? "started" : "pending",
                  scheduledStartAt: null,
                },
                lastError: null,
                createdAt: "2026-08-11T00:00:00.000Z",
                updatedAt: "2026-08-11T00:00:00.000Z",
                solved: 0,
                total: 0,
              },
            ],
          })
        }
        throw new Error(`未处理的请求：${url}`)
      }),
    )

    const user = userEvent.setup()
    render(
      createElement(
        MemoryRouter,
        { initialEntries: ["/"] },
        createElement(
          AppProvider,
          null,
          createElement(
            Routes,
            null,
            createElement(Route, { path: "/", element: createElement(ProjectsPage) }),
          ),
        ),
      ),
    )

    await user.click(await screen.findByRole("button", { name: "开始比赛" }))
    await waitFor(() => expect(started).toBe(true))
    expect(await screen.findByText("运行正常")).toBeTruthy()
  })

  it("将归档比赛标为已归档而不是可启动调度", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url
        if (url === "/api/auth") {
          return jsonResponse({
            enabled: false,
            authenticated: true,
            username: null,
          })
        }
        if (url === "/api/projects") {
          return jsonResponse({
            selectedProjectId: null,
            projects: [
              {
                id: "archive-1",
                name: "已结束比赛",
                platformId: "ctfd",
                phase: "ready",
                archived: true,
                lastError: null,
                createdAt: "2026-08-11T00:00:00.000Z",
                solved: 3,
                total: 10,
              },
            ],
          })
        }
        throw new Error(`未处理的请求：${url}`)
      }),
    )

    render(
      createElement(
        MemoryRouter,
        { initialEntries: ["/"] },
        createElement(
          AppProvider,
          null,
          createElement(
            Routes,
            null,
            createElement(Route, {
              path: "/",
              element: createElement(ProjectsPage),
            }),
          ),
        ),
      ),
    )

    expect(await screen.findByText("已归档")).toBeTruthy()
    expect(screen.queryByText("可启动调度")).toBeNull()
  })
})

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    headers: { "content-type": "application/json" },
  })
}
