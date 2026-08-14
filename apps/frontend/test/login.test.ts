// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react"
import { userEvent } from "@testing-library/user-event"
import { createElement } from "react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, describe, expect, it, vi } from "vite-plus/test"
import { AppProvider, useApp } from "../src/app/AppProvider.tsx"
import { LoginPage } from "../src/pages/LoginPage.tsx"

function BootstrapProbe() {
  const { bootstrapError, loading, retryBootstrap } = useApp()
  return createElement(
    "div",
    null,
    createElement("p", { role: "alert" }, bootstrapError),
    createElement(
      "button",
      { type: "button", disabled: loading, onClick: () => void retryBootstrap() },
      "重试",
    ),
  )
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    headers: { "content-type": "application/json" },
  })
}

describe("登录流程", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("启动请求失败时显示可恢复的错误并支持重试", async () => {
    let attempts = 0
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      if (url !== "/api/auth") throw new Error(`未处理的请求：${url}`)
      attempts += 1
      if (attempts === 1) {
        return new Response(
          JSON.stringify({ error: "backend_unavailable", message: "后端暂时不可用" }),
          {
            status: 503,
            headers: { "content-type": "application/json" },
          },
        )
      }
      return jsonResponse({ enabled: false, authenticated: false, username: null })
    })
    vi.stubGlobal("fetch", fetchMock)

    render(createElement(AppProvider, null, createElement(BootstrapProbe)))

    expect(await screen.findByText("后端暂时不可用")).toBeTruthy()
    await userEvent.setup().click(screen.getByRole("button", { name: "重试" }))
    await waitFor(() => expect(screen.queryByText("后端暂时不可用")).toBeNull())
    expect(attempts).toBe(2)
  })

  it("登录后先刷新比赛列表再进入首页", async () => {
    let authenticated = false
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      if (url === "/api/auth/login" && init?.method === "POST") {
        authenticated = true
        return jsonResponse({ authenticated: true })
      }
      if (url === "/api/auth") {
        return jsonResponse({
          enabled: true,
          authenticated,
          username: authenticated ? "operator" : null,
        })
      }
      if (url === "/api/projects") {
        return jsonResponse({ projects: [], selectedProjectId: null })
      }
      throw new Error(`未处理的请求：${url}`)
    })
    vi.stubGlobal("fetch", fetchMock)

    render(
      createElement(
        MemoryRouter,
        { initialEntries: ["/login"] },
        createElement(
          AppProvider,
          null,
          createElement(
            Routes,
            null,
            createElement(Route, {
              path: "/login",
              element: createElement(LoginPage),
            }),
            createElement(Route, {
              path: "/",
              element: createElement("p", null, "比赛首页"),
            }),
          ),
        ),
      ),
    )

    const user = userEvent.setup()
    await user.type(await screen.findByLabelText("用户名"), "operator")
    await user.type(screen.getByLabelText("密码"), "secret")
    await user.click(screen.getByRole("button", { name: "进入" }))

    expect(await screen.findByText("比赛首页")).toBeTruthy()
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => url === "/api/projects")).toBe(true),
    )
  })
})
