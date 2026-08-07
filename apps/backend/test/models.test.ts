import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createFileModelAuthentication } from "../src/domain/model-auth.ts"
import { createWebUiApp } from "../src/server.ts"
import { FakeDashboardProject, FakeModelConfiguration } from "./fake-project.ts"
import { jsonOf, jsonRequest } from "./helpers.ts"

describe("模型配置与模型鉴权路由", () => {
  const roots: string[] = []

  afterEach(async () => {
    vi.restoreAllMocks()
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    )
  })

  async function appWithAuth() {
    const root = await mkdtemp(join(tmpdir(), "ctf-model-auth-"))
    roots.push(root)
    const authentication = await createFileModelAuthentication({
      storagePath: join(root, "auth.json"),
      importPath: join(root, "mounted-auth.json"),
    })
    const project = new FakeDashboardProject()
    const { app } = createWebUiApp({
      project,
      modelAuthentication: authentication,
      modelConfiguration: new FakeModelConfiguration(),
      frontendDist: "/nonexistent",
    })
    return { app, authentication }
  }

  it("模型配置保存时不会把 API key 回传到快照", async () => {
    const project = new FakeDashboardProject()
    const modelConfiguration = new FakeModelConfiguration()
    const { app } = createWebUiApp({
      project,
      modelConfiguration,
      frontendDist: "/nonexistent",
    })

    const saved = await jsonRequest(app, "/api/model-config", "POST", {
      solverModelId: "solver",
      tldrModelId: "solver",
      subagentModels: { helper: "helper" },
      models: [
        {
          id: "solver",
          provider: "openai",
          modelId: "gpt-4o",
          baseUrl: "https://api.openai.com/v1",
          contextWindow: 128_000,
          thinkingEnabled: false,
          reasoningEffort: "off",
          passthroughThinking: false,
          apiKey: "sk-secret-1",
        },
        {
          id: "helper",
          provider: "openai",
          modelId: "gpt-4o-mini",
          baseUrl: "https://api.openai.com/v1",
          contextWindow: 128_000,
          thinkingEnabled: false,
          reasoningEffort: "off",
          passthroughThinking: false,
          apiKey: "sk-secret-2",
        },
      ],
    })
    expect(saved.status).toBe(200)
    expect(modelConfiguration.lastApiKey).toBe("sk-secret-1")
    const body = await jsonOf(saved)
    expect(JSON.stringify(body)).not.toContain("sk-secret")
    expect(body).toMatchObject({
      configuration: {
        solverModelId: "solver",
        tldrModelId: "solver",
      },
    })
  })

  it("模型配置校验：空 apiKey 或未绑定 id 时 400", async () => {
    const project = new FakeDashboardProject()
    const { app } = createWebUiApp({
      project,
      modelConfiguration: new FakeModelConfiguration(),
      frontendDist: "/nonexistent",
    })
    const base = {
      provider: "openai",
      modelId: "gpt-4o",
      baseUrl: "https://api.openai.com/v1",
      contextWindow: 128_000,
      thinkingEnabled: false,
      reasoningEffort: "off",
      passthroughThinking: false,
    }

    expect(
      (
        await jsonRequest(app, "/api/model-config", "POST", {
          models: [{ id: "solver", ...base, apiKey: "  " }],
        })
      ).status,
    ).toBe(400)

    expect(
      (
        await jsonRequest(app, "/api/model-config", "POST", {
          solverModelId: "missing",
          models: [],
        })
      ).status,
    ).toBe(400)
  })

  it("模型凭据导入、列出与移除且不泄露原文", async () => {
    const { app, authentication } = await appWithAuth()

    const imported = await jsonRequest(app, "/api/model-auth/import", "POST", {
      json: JSON.stringify({ OPENAI_API_KEY: "server-test-secret" }),
    })
    expect(imported.status).toBe(200)
    const importedBody = await imported.text()
    expect(importedBody).toContain('"provider":"openai"')
    expect(importedBody).not.toContain("server-test-secret")

    const listed = await app.request("/api/model-auth")
    const listedBody = await listed.text()
    expect(listedBody).toContain('"credentialType":"api_key"')
    expect(listedBody).not.toContain("server-test-secret")

    const removed = await jsonRequest(
      app,
      "/api/model-auth/providers/openai/logout",
      "POST",
      {},
    )
    expect(removed.status).toBe(200)
    expect(await authentication.hasCredential("openai")).toBe(false)
  })

  it("允许无需预输入凭据的浏览器和 Device Code 登录", async () => {
    const { app, authentication } = await appWithAuth()
    const startLogin = vi
      .spyOn(authentication, "startLogin")
      .mockImplementation(async ({ provider, method }) => ({
        id: `${provider}-${method}`,
        provider: "openai-codex",
        method: method === "oauth_device" ? "oauth_device" : "oauth_browser",
        status: "running",
        updatedAt: "2026-08-04T00:00:00.000Z",
      }))

    for (const method of ["oauth_browser", "oauth_device"]) {
      const response = await jsonRequest(app, "/api/model-auth/login", "POST", {
        provider: "openai-codex",
        method,
      })
      expect(response.status).toBe(202)
    }
    expect(startLogin).toHaveBeenNthCalledWith(1, {
      provider: "openai-codex",
      method: "oauth_browser",
    })
    expect(startLogin).toHaveBeenNthCalledWith(2, {
      provider: "openai-codex",
      method: "oauth_device",
    })
  })

  it("登录会话轮询、提交 prompt 与取消", async () => {
    const { app, authentication } = await appWithAuth()

    vi.spyOn(authentication, "startLogin").mockImplementation(async () => ({
      id: "session-1",
      provider: "openai-codex",
      method: "oauth_browser",
      status: "awaiting_input",
      prompt: { type: "secret", message: "输入 code" },
      updatedAt: "2026-08-04T00:00:00.000Z",
    }))
    const loginSession = vi
      .spyOn(authentication, "loginSession")
      .mockReturnValue({
        id: "session-1",
        provider: "openai-codex",
        method: "oauth_browser",
        status: "running",
        updatedAt: "2026-08-04T00:00:00.000Z",
      })
    const submitPrompt = vi
      .spyOn(authentication, "submitPrompt")
      .mockReturnValue({
        id: "session-1",
        provider: "openai-codex",
        method: "oauth_browser",
        status: "running",
        updatedAt: "2026-08-04T00:00:00.000Z",
      })
    const cancelLogin = vi
      .spyOn(authentication, "cancelLogin")
      .mockReturnValue({
        id: "session-1",
        provider: "openai-codex",
        method: "oauth_browser",
        status: "cancelled",
        updatedAt: "2026-08-04T00:00:00.000Z",
      })

    const login = await jsonRequest(app, "/api/model-auth/login", "POST", {
      provider: "openai-codex",
      method: "oauth_browser",
    })
    expect(login.status).toBe(202)
    expect(await jsonOf(login)).toMatchObject({ id: "session-1" })

    const polled = await app.request("/api/model-auth/login/session-1")
    expect(polled.status).toBe(200)
    expect(await jsonOf(polled)).toMatchObject({ status: "running" })

    const prompt = await jsonRequest(
      app,
      "/api/model-auth/login/session-1/prompt",
      "POST",
      { value: "1234" },
    )
    expect(prompt.status).toBe(200)
    expect(submitPrompt).toHaveBeenCalledWith("session-1", "1234")

    const cancelled = await jsonRequest(
      app,
      "/api/model-auth/login/session-1/cancel",
      "POST",
      {},
    )
    expect(cancelled.status).toBe(200)
    expect(await jsonOf(cancelled)).toMatchObject({ status: "cancelled" })
    expect(cancelLogin).toHaveBeenCalledWith("session-1")
    expect(loginSession).toHaveBeenCalled()
  })

  it("模型鉴权错误统一映射为 400 invalid_model_authentication", async () => {
    const { app, authentication } = await appWithAuth()
    vi.spyOn(authentication, "loginSession").mockImplementation(() => {
      throw new Error("session not found")
    })

    const response = await app.request("/api/model-auth/login/nope")
    expect(response.status).toBe(400)
    expect(await jsonOf(response)).toMatchObject({
      error: "invalid_model_authentication",
    })
  })

  it("scoped 模型配置保存到项目并回传快照", async () => {
    const project = new FakeDashboardProject()
    const modelConfiguration = new FakeModelConfiguration()
    const { app } = createWebUiApp({
      project,
      modelConfiguration,
      frontendDist: "/nonexistent",
    })

    const saved = await jsonRequest(
      app,
      "/api/projects/alpha/model-config",
      "POST",
      {
        solverModelId: "solver",
        tldrModelId: "solver",
        subagentModels: {},
        models: [
          {
            id: "solver",
            provider: "openai",
            modelId: "gpt-4o",
            baseUrl: "https://api.openai.com/v1",
            contextWindow: 128_000,
            thinkingEnabled: false,
            reasoningEffort: "off",
            passthroughThinking: false,
            apiKey: "sk-secret-1",
          },
        ],
      },
    )
    expect(saved.status).toBe(200)
    expect(await jsonOf(saved)).toMatchObject({
      configuration: { solverModelId: "solver" },
    })
  })
})
