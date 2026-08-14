// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { createElement } from "react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, describe, expect, it, vi } from "vite-plus/test"
import { TooltipProvider } from "../src/components/index.ts"
import { AppShell } from "../src/layouts/AppShell.tsx"

const appState = vi.hoisted(() => ({ tokenUsageEnabled: true }))

vi.mock("../src/app/AppProvider.tsx", () => ({
  isPluginEnabled: (plugins: Array<{ id: string; enabled: boolean }>, pluginId: string) =>
    plugins.find((plugin) => plugin.id === pluginId)?.enabled ?? true,
  useApp: () => ({
    auth: { enabled: false, authenticated: true, username: null },
    projects: [],
    auditProjects: [],
    plugins: [
      {
        id: "token-usage",
        enabled: appState.tokenUsageEnabled,
        defaultEnabled: true,
        name: "Token 消耗",
        description: "",
      },
    ],
    logout: vi.fn(async () => undefined),
  }),
}))

afterEach(() => {
  cleanup()
  window.localStorage.clear()
  appState.tokenUsageEnabled = true
})

describe("AppShell navigation", () => {
  it("can open and close the mobile navigation drawer", async () => {
    render(
      createElement(
        MemoryRouter,
        { initialEntries: ["/"] },
        createElement(
          TooltipProvider,
          null,
          createElement(
            Routes,
            null,
            createElement(
              Route,
              { element: createElement(AppShell) },
              createElement(Route, {
                index: true,
                element: createElement("main", null, "content"),
              }),
            ),
          ),
        ),
      ),
    )

    fireEvent.click(screen.getByRole("button", { name: "菜单" }))

    const dialog = screen.getByRole("dialog")
    expect(dialog).toBeTruthy()
    expect(within(dialog).getByRole("link", { name: "全局配置" })).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "关闭导航" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  })

  it("在比赛设置下方显示项目级 Token 消耗入口", () => {
    render(
      createElement(
        MemoryRouter,
        { initialEntries: ["/projects/demo"] },
        createElement(
          TooltipProvider,
          null,
          createElement(
            Routes,
            null,
            createElement(
              Route,
              { path: "/projects/:projectId", element: createElement(AppShell) },
              createElement(Route, {
                index: true,
                element: createElement("main", null, "content"),
              }),
            ),
          ),
        ),
      ),
    )

    const settings = screen.getByRole("link", { name: "比赛设置" })
    const usage = screen.getByRole("link", { name: "Token 消耗" })
    expect(settings.compareDocumentPosition(usage) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.queryByRole("link", { name: "代码审计" })).toBeNull()
    expect(usage.getAttribute("href")).toBe("/projects/demo/token-usage")
  })

  it("插件关闭时隐藏项目级 Token 消耗入口", () => {
    appState.tokenUsageEnabled = false
    render(
      createElement(
        MemoryRouter,
        { initialEntries: ["/projects/demo"] },
        createElement(
          TooltipProvider,
          null,
          createElement(
            Routes,
            null,
            createElement(
              Route,
              { path: "/projects/:projectId", element: createElement(AppShell) },
              createElement(Route, {
                index: true,
                element: createElement("main", null, "content"),
              }),
            ),
          ),
        ),
      ),
    )

    expect(screen.queryByRole("link", { name: "Token 消耗" })).toBeNull()
  })
})
