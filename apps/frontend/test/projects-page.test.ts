// @vitest-environment jsdom

import { render, screen } from "@testing-library/react"
import { createElement } from "react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, describe, expect, it, vi } from "vite-plus/test"
import { AppProvider } from "../src/app/AppProvider.tsx"
import { ProjectsPage } from "../src/pages/ProjectsPage.tsx"

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("ProjectsPage", () => {
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
