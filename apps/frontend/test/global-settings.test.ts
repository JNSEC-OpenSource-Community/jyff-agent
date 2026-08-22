// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react"
import { userEvent } from "@testing-library/user-event"
import { createElement } from "react"
import { afterEach, describe, expect, it, vi } from "vite-plus/test"
import { AppProvider } from "../src/app/AppProvider.tsx"
import { GlobalSettingsPage } from "../src/pages/settings/GlobalSettingsPage.tsx"
import { ShellPoopEditor } from "../src/pages/settings/ShellPoopEditor.tsx"
import { WebAccessEditor } from "../src/pages/settings/WebAccessEditor.tsx"

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

  it("Web Access 关闭时隐藏保存按钮，并按 baseUrl 显示 Nekozuki 已配置", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => jsonResponse({})),
    )

    render(
      createElement(WebAccessEditor, {
        config: {
          enabled: false,
          providers: [{ id: "nekozuki", enabled: false, configured: false }],
          workflow: "none",
          ssrf: { allowRanges: [], trustEnvProxy: false },
        },
        modelConfiguration: null,
        onSaved: vi.fn(),
      }),
    )

    expect(screen.queryByRole("button", { name: "保存" })).toBeNull()
    const user = userEvent.setup()
    await user.click(screen.getByRole("switch", { name: "启用 web-access 插件" }))
    expect(screen.getByRole("button", { name: "保存" })).toBeTruthy()

    cleanup()
    render(
      createElement(WebAccessEditor, {
        config: {
          enabled: true,
          providers: [{ id: "nekozuki", enabled: true, configured: false }],
          workflow: "none",
          ssrf: { allowRanges: [], trustEnvProxy: false },
          providerConfig: { nekozuki: { baseUrl: "http://localhost:8000" } },
        },
        modelConfiguration: null,
        onSaved: vi.fn(),
      }),
    )
    const nekozukiRow = screen.getByText("Nekozuki").closest("li")
    if (!nekozukiRow) throw new Error("未找到 Nekozuki 配置行")
    expect(within(nekozukiRow).getByText("已配置")).toBeTruthy()
    expect(within(nekozukiRow).queryByText("未配置")).toBeNull()
  })

  it("ShellPoop 关闭时隐藏保存按钮，切换开启后才显示", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => jsonResponse({})),
    )

    render(
      createElement(ShellPoopEditor, {
        config: {
          enabled: false,
          baseUrl: "http://127.0.0.1:8000",
          timeoutMs: 15_000,
          apiKeyConfigured: false,
        },
        onSaved: vi.fn(),
      }),
    )

    expect(screen.queryByRole("button", { name: "保存" })).toBeNull()
    await userEvent.setup().click(screen.getByRole("switch", { name: "启用 shellpoop 插件" }))
    expect(screen.getByRole("button", { name: "保存" })).toBeTruthy()
  })

  it("WebUI 登录关闭时隐藏保存按钮，开启后才显示", async () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    )
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      if (url === "/api/auth") {
        return jsonResponse({ enabled: false, authenticated: true, username: null })
      }
      if (url === "/api/projects") {
        return jsonResponse({ projects: [], selectedProjectId: null })
      }
      if (url === "/api/global-config") {
        return jsonResponse({
          authentication: { enabled: false, username: null },
          modelConfiguration: null,
          modelAuthentication: null,
          plugins: { plugins: [] },
          webAccess: null,
          shellpoop: null,
        })
      }
      throw new Error(`未处理的请求：${url}`)
    })
    vi.stubGlobal("fetch", fetchMock)

    render(createElement(AppProvider, null, createElement(GlobalSettingsPage)))
    const user = userEvent.setup()
    await screen.findByText("全局配置")
    await user.click(screen.getByRole("tab", { name: "登录" }))

    expect(screen.queryByRole("button", { name: "保存" })).toBeNull()
    await user.click(screen.getByRole("switch", { name: "启用 WebUI 登录" }))
    expect(screen.getByRole("button", { name: "保存" })).toBeTruthy()
  })
})
