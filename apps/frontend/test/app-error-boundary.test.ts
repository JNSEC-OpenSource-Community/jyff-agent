// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react"
import { createElement, type ReactElement } from "react"
import { afterEach, describe, expect, it, vi } from "vite-plus/test"
import { AppErrorBoundary } from "../src/app/AppErrorBoundary.tsx"

function BrokenPage(): ReactElement {
  throw new Error("render failed")
}

describe("AppErrorBoundary", () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it("用可恢复的错误页代替空白页面", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined)

    render(createElement(AppErrorBoundary, null, createElement(BrokenPage)))

    expect(screen.getByRole("alert")).toBeTruthy()
    expect(screen.getByRole("heading", { name: "无法显示当前页面" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "刷新页面" })).toBeTruthy()
  })
})
