// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { userEvent } from "@testing-library/user-event"
import { createElement } from "react"
import { afterEach, describe, expect, it, vi } from "vite-plus/test"
import { AppProvider } from "../src/app/AppProvider.tsx"
import { GlobalSettingsPage } from "../src/pages/settings/GlobalSettingsPage.tsx"

vi.mock("@iconify/react", () => ({ Icon: () => null }))

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    headers: { "content-type": "application/json" },
  })
}

function sourceUpdater() {
  return {
    id: "github-source-updater" as const,
    configuration: {
      enabled: false,
      repository: "acme/agent",
      channel: { kind: "branch" as const, ref: "main" },
      automaticCheck: true,
      intervalMinutes: 360,
      automaticApply: false,
      applyPolicy: "when-idle" as const,
      githubTokenConfigured: false,
    },
    current: {
      version: "0.1.0",
      revision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      repository: "acme/agent",
      builtAt: null,
      dirty: false,
      source: "git" as const,
    },
    candidate: null,
    executor: {
      connected: false,
      protocolVersion: null,
      canPrepare: false,
      canApply: false,
      reason: "未配置 Update Worker；当前只能检查 GitHub 版本",
    },
    operation: null,
    lastCheckedAt: null,
    nextCheckAt: null,
    error: null,
  }
}

describe("GitHub 源码更新设置", () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("在插件页显示版本状态，并保存更新策略", async () => {
    const updater = sourceUpdater()
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      if (url === "/api/auth") {
        return jsonResponse({ enabled: false, authenticated: true, username: null })
      }
      if (url === "/api/projects") return jsonResponse({ projects: [], selectedProjectId: null })
      if (url === "/api/global-config") {
        return jsonResponse({
          authentication: { enabled: false, username: null },
          modelConfiguration: null,
          modelAuthentication: null,
          plugins: { plugins: [] },
          webAccess: null,
          shellpoop: null,
          sourceUpdater: updater,
        })
      }
      if (url === "/api/global-config/source-updater" && init?.method === "POST") {
        if (typeof init.body !== "string") throw new Error("请求体不是字符串")
        const body = JSON.parse(init.body) as { enabled: boolean; automaticCheck: boolean }
        updater.configuration.enabled = body.enabled
        updater.configuration.automaticCheck = body.automaticCheck
        return jsonResponse(updater)
      }
      throw new Error(`未处理的请求：${url}`)
    })
    vi.stubGlobal("fetch", fetchMock)

    render(createElement(AppProvider, null, createElement(GlobalSettingsPage)))
    const user = userEvent.setup()
    await screen.findByText("全局配置")
    await user.click(screen.getByRole("tab", { name: "插件" }))

    expect(screen.getByText("GitHub 源码更新")).toBeTruthy()
    const toggle = screen.getByRole("switch", { name: "启用 GitHub 源码更新插件" })
    await user.click(toggle)
    expect(screen.getByDisplayValue("acme/agent")).toBeTruthy()
    expect(screen.getByRole("button", { name: "保存更新策略" })).toBeTruthy()

    await user.click(screen.getByRole("button", { name: "保存更新策略" }))
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/global-config/source-updater",
        expect.objectContaining({ method: "POST" }),
      )
    })
  })
})
