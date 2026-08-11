// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react"
import { userEvent } from "@testing-library/user-event"
import { createElement } from "react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, describe, expect, it, vi } from "vite-plus/test"
import { AppProvider } from "../src/app/AppProvider.tsx"
import { LoginPage } from "../src/pages/LoginPage.tsx"

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
