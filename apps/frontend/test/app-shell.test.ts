// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { createElement } from "react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, describe, expect, it, vi } from "vite-plus/test"
import { TooltipProvider } from "../src/components/index.ts"
import { AppShell } from "../src/layouts/AppShell.tsx"

vi.mock("../src/app/AppProvider.tsx", () => ({
  useApp: () => ({
    auth: { enabled: false, authenticated: true, username: null },
    projects: [],
    logout: vi.fn(async () => undefined),
  }),
}))

afterEach(() => {
  cleanup()
  window.localStorage.clear()
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
})
