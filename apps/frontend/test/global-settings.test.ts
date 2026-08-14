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

describe("全局供应商设置", () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("先显示三种添加入口，再按选择展开配置表单", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      if (url === "/api/auth") {
        return jsonResponse({
          enabled: false,
          authenticated: true,
          username: null,
        })
      }
      if (url === "/api/projects") {
        return jsonResponse({ projects: [], selectedProjectId: null })
      }
      if (url === "/api/global-config") {
        return jsonResponse({
          authentication: { enabled: false, username: null },
          modelConfiguration: {
            models: [],
            customProviders: [
              {
                id: "custom-gateway",
                name: "Internal Gateway",
                api: "openai-responses",
                baseUrl: "https://models.example.test/v1",
                apiKeyConfigured: true,
              },
            ],
            solverModelId: "",
            tldrModelId: "",
            subagentModels: {},
            supportedThinkingLevels: [],
            configured: false,
          },
          modelAuthentication: {
            importPath: "/auth.json",
            importFileAvailable: false,
            providers: [
              {
                id: "openai",
                name: "OpenAI",
                description: "OpenAI API",
                configured: true,
                credentialType: "api_key",
                methods: [
                  {
                    id: "api_key",
                    label: "API Key",
                    description: "输入新的 API Key",
                    requiresSecret: true,
                  },
                ],
                models: [],
              },
              {
                id: "openai-codex",
                name: "OpenAI Codex",
                description: "Codex Subscription",
                configured: false,
                methods: [
                  {
                    id: "oauth_browser",
                    label: "浏览器登录",
                    description: "使用浏览器完成登录",
                  },
                ],
                models: [],
              },
            ],
          },
        })
      }
      throw new Error(`未处理的请求：${url}`)
    })
    vi.stubGlobal("fetch", fetchMock)

    render(createElement(AppProvider, null, createElement(GlobalSettingsPage)))

    const user = userEvent.setup()
    expect(await screen.findByText("Internal Gateway")).toBeTruthy()
    expect(screen.getByRole("button", { name: /Subscription 登录/ })).toBeTruthy()
    expect(screen.getByRole("button", { name: /配置 API Key/ })).toBeTruthy()
    expect(screen.getByRole("button", { name: /添加自定义 Provider/ })).toBeTruthy()
    expect(screen.queryByLabelText("Base URL")).toBeNull()

    await user.click(screen.getByRole("button", { name: /添加自定义 Provider/ }))
    expect(screen.getByLabelText("供应商名称")).toBeTruthy()
    expect(screen.getByLabelText("Base URL")).toBeTruthy()

    const [editProvider] = screen.getAllByRole("button", { name: /编辑/ })
    if (!editProvider) throw new Error("未找到已有供应商编辑入口")
    await user.click(editProvider)
    expect(screen.getByPlaceholderText("输入新的 API Key")).toBeTruthy()
  })

  it("在插件页默认开启 Token 消耗插件并可全局关闭", async () => {
    let enabled = true
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      if (url === "/api/auth") {
        return jsonResponse({ enabled: false, authenticated: true, username: null })
      }
      if (url === "/api/projects") {
        return jsonResponse({
          projects: [],
          selectedProjectId: null,
          plugins: {
            plugins: [
              {
                id: "token-usage",
                name: "Token 消耗",
                description: "按比赛和模型汇总 Token 用量。",
                enabled,
                defaultEnabled: true,
              },
            ],
          },
        })
      }
      if (url === "/api/global-config") {
        return jsonResponse({
          authentication: { enabled: false, username: null },
          modelConfiguration: null,
          modelAuthentication: null,
          plugins: {
            plugins: [
              {
                id: "token-usage",
                name: "Token 消耗",
                description: "按比赛和模型汇总 Token 用量。",
                enabled,
                defaultEnabled: true,
              },
            ],
          },
          webAccess: null,
        })
      }
      if (url === "/api/global-config/plugins/token-usage" && init?.method === "POST") {
        if (typeof init.body !== "string") throw new Error("插件开关请求缺少 JSON body")
        enabled = (JSON.parse(init.body) as { enabled: boolean }).enabled
        return jsonResponse({
          plugins: [
            {
              id: "token-usage",
              name: "Token 消耗",
              description: "按比赛和模型汇总 Token 用量。",
              enabled,
              defaultEnabled: true,
            },
          ],
        })
      }
      throw new Error(`未处理的请求：${url}`)
    })
    vi.stubGlobal("fetch", fetchMock)

    render(createElement(AppProvider, null, createElement(GlobalSettingsPage)))
    const user = userEvent.setup()
    await screen.findByText("全局配置")
    await user.click(screen.getByRole("tab", { name: "插件" }))

    const toggle = screen.getByRole("switch", { name: "启用 Token 消耗插件" })
    expect(toggle.getAttribute("aria-checked")).toBe("true")
    await user.click(toggle)
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"))
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/global-config/plugins/token-usage",
      expect.objectContaining({ method: "POST" }),
    )
  })
})
