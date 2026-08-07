import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createFileWebUiAuthentication } from "../src/authentication.ts"
import { createFileModelAuthentication } from "../src/model-authentication.ts"
import { startWebUi, type WebUiServer } from "../src/server.ts"
import type { DashboardControlPlane } from "../src/types.ts"
import {
  FakeDashboardProject,
  FakeDashboardScheduler,
  FakeModelConfiguration,
} from "./fake-project.ts"

const servers: WebUiServer[] = []
const roots: string[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe("WebUI HTTP server", () => {
  it("启用可选鉴权后用 HttpOnly session cookie 保护 API", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctf-webui-server-auth-"))
    roots.push(root)
    const authentication = await createFileWebUiAuthentication(
      join(root, "global-config.json"),
    )
    await authentication.configure({
      enabled: true,
      username: "operator",
      password: "strong-password",
    })
    const server = await startWebUi({
      project: new FakeDashboardProject(),
      authentication,
      host: "127.0.0.1",
      port: 0,
      pollIntervalMs: 60_000,
    })
    servers.push(server)

    expect((await fetch(`${server.url}/api/snapshot`)).status).toBe(401)
    const rejected = await fetch(`${server.url}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "operator",
        password: "wrong-password",
      }),
    })
    expect(rejected.status).toBe(401)

    const login = await fetch(`${server.url}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "operator",
        password: "strong-password",
      }),
    })
    expect(login.status).toBe(200)
    const cookie = login.headers.get("set-cookie")
    expect(cookie).toContain("HttpOnly")
    expect(cookie).toContain("SameSite=Strict")
    expect(
      (
        await fetch(`${server.url}/api/snapshot`, {
          headers: { Cookie: cookie ?? "" },
        })
      ).status,
    ).toBe(200)

    const logout = await fetch(`${server.url}/api/auth/logout`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie ?? "",
      },
      body: "{}",
    })
    expect(logout.status).toBe(200)
    expect(
      authentication.authenticate(cookie?.split("=")[1]?.split(";")[0]),
    ).toBe(false)
  })

  it("未配置时仍可启动，并通过控制面 API 测试和应用平台配置", async () => {
    let project: FakeDashboardProject | undefined
    let phase: "unconfigured" | "ready" = "unconfigured"
    let appliedConfig: unknown
    const deletedProjects: string[] = []
    const snapshot = () => ({
      phase,
      configured: phase === "ready",
      projectId: phase === "ready" ? "demo" : null,
      projectName: phase === "ready" ? "Demo CTF" : null,
      platformId: phase === "ready" ? "ctfd" : null,
      lastError: null,
      updatedAt: "2026-08-04T00:00:00.000Z",
      selectedProjectId: phase === "ready" ? "demo" : null,
      projects:
        phase === "ready"
          ? [
              {
                id: "demo",
                name: "Demo CTF",
                platformId: "ctfd",
                phase: "ready" as const,
                lastError: null,
                createdAt: "2026-08-04T00:00:00.000Z",
                updatedAt: "2026-08-04T00:00:00.000Z",
              },
            ]
          : [],
    })
    const controlPlane: DashboardControlPlane = {
      snapshot,
      projectSnapshots: () => snapshot().projects,
      selectProject: () => snapshot(),
      setupSnapshot: () => ({
        state: snapshot(),
        config: null,
        platforms: [
          {
            id: "ctfd",
            setup: {
              label: "CTFd",
              description: "test",
              defaultConfig: { tokenSecret: "CTFD_TOKEN" },
              fields: [],
              authStrategies: [],
            },
          },
        ],
        secrets: {},
      }),
      currentProject: () => project,
      currentScheduler: () => undefined,
      testConnection: async () => ({
        ok: true,
        overview: {
          id: "demo",
          name: "Demo CTF",
          challenges: 3,
          announcements: 1,
        },
      }),
      applySetup: async ({ config }) => {
        appliedConfig = config
        project = new FakeDashboardProject()
        phase = "ready"
        return snapshot()
      },
      connect: async () => snapshot(),
      deleteProject: async (projectId) => {
        deletedProjects.push(projectId)
        project = undefined
        phase = "unconfigured"
        return snapshot()
      },
    }
    let runtimeConfiguration = {
      solverModelId: "",
      tldrModelId: "",
      subagentModels: {},
      maxConcurrent: 8,
    }
    const server = await startWebUi({
      controlPlane,
      modelConfiguration: new FakeModelConfiguration(),
      projectRuntimeConfiguration: (projectId) =>
        projectId === "demo"
          ? {
              snapshot: () => structuredClone(runtimeConfiguration),
              update: async (configuration) => {
                runtimeConfiguration = structuredClone(configuration)
                return structuredClone(runtimeConfiguration)
              },
            }
          : undefined,
      onProjectDeleted: (projectId) => {
        deletedProjects.push(`cache:${projectId}`)
      },
      host: "127.0.0.1",
      port: 0,
      pollIntervalMs: 60_000,
    })
    servers.push(server)

    const initial = await fetch(`${server.url}/api/snapshot`)
    expect(await initial.json()).toMatchObject({
      overview: { name: "尚未配置比赛", challenges: 0 },
      controlPlane: { phase: "unconfigured" },
    })
    expect((await fetch(`${server.url}/api/challenges/pwn-1`)).status).toBe(503)

    const config = {
      version: 1,
      project: { id: "demo", name: "Demo CTF" },
      platform: {
        plugin: "ctfd",
        config: {
          baseUrl: "https://demo.ctfd.io",
          tokenSecret: "CTFD_TOKEN",
        },
      },
      sandbox: {
        image: "ctf-agent-solver:latest",
        privileged: false,
        networkMode: "bridge",
      },
    }
    const tested = await fetch(`${server.url}/api/projects/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config, secrets: { CTFD_TOKEN: "secret" } }),
    })
    expect(tested.status).toBe(200)
    expect(await tested.json()).toMatchObject({ ok: true })

    const applied = await fetch(`${server.url}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config, secrets: { CTFD_TOKEN: "secret" } }),
    })
    expect(applied.status).toBe(201)
    expect(appliedConfig).toEqual(config)
    expect(await applied.json()).toMatchObject({
      project: { phase: "ready", projectId: "demo" },
      snapshot: { overview: { name: "Test CTF" } },
    })
    expect(
      await (await fetch(`${server.url}/api/projects`)).json(),
    ).toMatchObject({
      selectedProjectId: "demo",
      projects: [{ id: "demo", name: "Demo CTF", phase: "ready" }],
    })
    expect(
      await (await fetch(`${server.url}/api/projects/demo/snapshot`)).json(),
    ).toMatchObject({ overview: { name: "Test CTF" } })
    expect(
      await (
        await fetch(`${server.url}/api/projects/demo/runtime-config`)
      ).json(),
    ).toMatchObject({ runtime: { maxConcurrent: 8 } })
    const runtimeUpdated = await fetch(
      `${server.url}/api/projects/demo/runtime-config`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          solverModelId: "",
          tldrModelId: "",
          subagentModels: {},
          maxConcurrent: 3,
        }),
      },
    )
    expect(runtimeUpdated.status).toBe(200)
    expect(runtimeConfiguration.maxConcurrent).toBe(3)

    const deleted = await fetch(`${server.url}/api/projects/demo`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    })
    expect(deleted.status).toBe(200)
    expect(await deleted.json()).toMatchObject({
      controlPlane: { configured: false, projects: [] },
    })
    expect(deletedProjects).toEqual(["demo", "cache:demo"])
    expect((await fetch(`${server.url}/api/projects/demo`)).status).toBe(404)
  })

  it("提供健康检查、静态前端、快照、详情和平台刷新 API", async () => {
    const project = new FakeDashboardProject()
    const server = await startWebUi({
      project,
      host: "127.0.0.1",
      port: 0,
      pollIntervalMs: 60_000,
    })
    servers.push(server)

    const health = await fetch(`${server.url}/health`)
    expect(health.status).toBe(200)
    expect(await health.json()).toMatchObject({
      status: "ok",
      connectedClients: 0,
    })

    const home = await fetch(server.url)
    expect(home.headers.get("content-type")).toContain("text/html")
    expect(await home.text()).toContain("正在载入控制面")

    const styles = await fetch(`${server.url}/styles.css`)
    expect(styles.headers.get("content-type")).toContain("text/css")
    const compiledCss = await styles.text()
    expect(compiledCss).toContain("--color-background")
    expect(compiledCss).not.toContain('@import "tailwindcss"')

    const nestedRoute = await fetch(`${server.url}/projects/demo/settings`)
    expect(nestedRoute.status).toBe(200)
    expect(nestedRoute.headers.get("content-type")).toContain("text/html")
    expect(await nestedRoute.text()).toContain("CTF Agent · Operations")

    const snapshot = await fetch(`${server.url}/api/snapshot`)
    const snapshotBody = (await snapshot.json()) as { challenges: unknown[] }
    expect(snapshotBody.challenges).toHaveLength(3)

    const details = await fetch(`${server.url}/api/challenges/pwn-1`)
    const detailsBody = (await details.json()) as {
      challenge: { title: string }
    }
    expect(detailsBody.challenge.title).toBe("Heap Garden")
    expect((await fetch(`${server.url}/api/challenges/missing`)).status).toBe(
      404,
    )

    const refreshed = await fetch(`${server.url}/api/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    })
    expect(refreshed.status).toBe(200)
    expect(project.refreshCalls).toBe(1)
  })

  it("通过 WebUI 审核公告后才标记为可发送", async () => {
    const project = new FakeDashboardProject()
    project.announcementCandidateValues = [
      {
        key: "notice:revision",
        platformAnnouncementId: "notice",
        revisionHash: "revision",
        title: "Cookie Jar hint",
        content: "Inspect the updated attachment.",
        publishedAt: "2026-01-01T00:00:00.000Z",
        kind: "hint",
        classificationReason: "critical_keyword",
        ignored: false,
        firstSeenAt: "2026-01-01T00:00:01.000Z",
        lastSeenAt: "2026-01-01T00:00:01.000Z",
        challengeId: "web-1",
        matchType: "title",
        matchedValue: "Cookie Jar",
        matchedKeywords: ["hint", "update", "attachment"],
        approvalStatus: "pending",
        reviewedAt: null,
        linkedAt: "2026-01-01T00:00:01.000Z",
      },
    ]
    const server = await startWebUi({
      project,
      host: "127.0.0.1",
      port: 0,
      pollIntervalMs: 60_000,
    })
    servers.push(server)

    const response = await fetch(`${server.url}/api/announcements/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        challengeId: "web-1",
        announcementKey: "notice:revision",
        status: "approved",
      }),
    })

    expect(response.status).toBe(200)
    expect(project.announcementReviews).toEqual([
      {
        challengeId: "web-1",
        announcementKey: "notice:revision",
        status: "approved",
      },
    ])
    expect(await response.json()).toMatchObject({
      announcementCandidates: [{ approvalStatus: "approved" }],
    })
  })

  it("通过模型凭据 API 导入、列出和移除凭据且不泄露原文", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctf-auth-server-"))
    roots.push(root)
    const authentication = await createFileModelAuthentication({
      storagePath: join(root, "auth.json"),
      importPath: join(root, "mounted-auth.json"),
    })
    const server = await startWebUi({
      project: new FakeDashboardProject(),
      modelAuthentication: authentication,
      modelConfiguration: new FakeModelConfiguration(),
      host: "127.0.0.1",
      port: 0,
      pollIntervalMs: 60_000,
    })
    servers.push(server)

    const imported = await fetch(`${server.url}/api/model-auth/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        json: JSON.stringify({ OPENAI_API_KEY: "server-test-secret" }),
      }),
    })
    expect(imported.status).toBe(200)
    const importedBody = await imported.text()
    expect(importedBody).toContain('"provider":"openai"')
    expect(importedBody).not.toContain("server-test-secret")

    const listed = await fetch(`${server.url}/api/model-auth`)
    const listedBody = await listed.text()
    expect(listedBody).toContain('"credentialType":"api_key"')
    expect(listedBody).not.toContain("server-test-secret")

    const removed = await fetch(
      `${server.url}/api/model-auth/providers/openai/logout`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      },
    )
    expect(removed.status).toBe(200)
    expect(await authentication.hasCredential("openai")).toBe(false)
  })

  it("允许无需预输入凭据的浏览器和 Device Code 登录", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctf-auth-login-server-"))
    roots.push(root)
    const authentication = await createFileModelAuthentication({
      storagePath: join(root, "auth.json"),
    })
    const startLogin = vi
      .spyOn(authentication, "startLogin")
      .mockImplementation(async ({ provider, method }) => ({
        id: `${provider}-${method}`,
        provider: "openai-codex",
        method: method === "oauth_device" ? "oauth_device" : "oauth_browser",
        status: "running",
        updatedAt: "2026-08-04T00:00:00.000Z",
      }))
    const server = await startWebUi({
      project: new FakeDashboardProject(),
      modelAuthentication: authentication,
      modelConfiguration: new FakeModelConfiguration(),
      host: "127.0.0.1",
      port: 0,
      pollIntervalMs: 60_000,
    })
    servers.push(server)

    for (const method of ["oauth_browser", "oauth_device"]) {
      const response = await fetch(`${server.url}/api/model-auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "openai-codex", method }),
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

  it("通过 SSE 立即发送当前快照", async () => {
    const project = new FakeDashboardProject()
    const server = await startWebUi({
      project,
      host: "127.0.0.1",
      port: 0,
      pollIntervalMs: 60_000,
    })
    servers.push(server)

    const controller = new AbortController()
    const response = await fetch(`${server.url}/api/events`, {
      signal: controller.signal,
    })
    expect(response.headers.get("content-type")).toContain("text/event-stream")
    if (!response.body) throw new Error("SSE 响应缺少 body")
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let received = ""
    while (!received.includes("event: snapshot")) {
      const chunk = await reader.read()
      if (chunk.done) break
      received += decoder.decode(chunk.value, { stream: true })
    }
    expect(received).toContain("event: snapshot")
    expect(received).toContain('"name":"Test CTF"')

    project.runValues.push({
      id: "run-misc-1",
      challengeId: "misc-1",
      workspace: "/workspace/run-misc-1",
      attempt: 1,
      source: "manual",
      status: "running",
      createdAt: "2026-07-29T12:05:00.000Z",
      updatedAt: "2026-07-29T12:05:00.000Z",
    })
    await server.refresh()
    let update = ""
    while (!update.includes("run-misc-1")) {
      const chunk = await reader.read()
      if (chunk.done) break
      update += decoder.decode(chunk.value, { stream: true })
    }
    controller.abort()
    expect(update).toContain("event: snapshot")
    expect(update).toContain("run-misc-1")
  })

  it("慢速平台故障只记录一次并退避，恢复后更新健康状态", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {})
    const project = new FakeDashboardProject()
    const server = await startWebUi({
      project,
      host: "127.0.0.1",
      port: 0,
      pollIntervalMs: 250,
    })
    servers.push(server)
    project.overviewDelayMs = 600
    project.overviewError = new Error("upstream timeout")

    await new Promise((resolve) => setTimeout(resolve, 950))
    const degraded = (await (await fetch(`${server.url}/health`)).json()) as {
      platformSync: { status: string; consecutiveFailures: number }
    }
    expect(degraded.platformSync).toMatchObject({
      status: "degraded",
      consecutiveFailures: 1,
    })
    expect(warning).toHaveBeenCalledTimes(1)

    project.overviewDelayMs = 0
    project.overviewError = undefined
    await new Promise((resolve) => setTimeout(resolve, 700))
    const recovered = (await (await fetch(`${server.url}/health`)).json()) as {
      platformSync: { status: string; lastError: string | null }
    }
    expect(recovered.platformSync).toMatchObject({
      status: "ok",
      lastError: null,
    })
    warning.mockRestore()
  })

  it("提供自主启停、并发设置、人工调度和取消 API", async () => {
    const scheduler = new FakeDashboardScheduler()
    const server = await startWebUi({
      project: new FakeDashboardProject(),
      scheduler,
      host: "127.0.0.1",
      port: 0,
      pollIntervalMs: 60_000,
    })
    servers.push(server)
    const post = (path: string, body = {}) =>
      fetch(`${server.url}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })

    expect((await post("/api/scheduler/auto/start")).status).toBe(200)
    expect(scheduler.snapshot().autoEnabled).toBe(true)
    scheduler.value.queued.push({
      challengeId: "misc-1",
      source: "manual",
      lane: "normal",
      manualOverride: false,
      enqueuedAt: "2026-07-29T12:00:00.000Z",
      position: 1,
      version: 1,
    })
    expect((await post("/api/scheduler/auto/pause")).status).toBe(200)
    expect(scheduler.snapshot().autoEnabled).toBe(false)
    expect(scheduler.snapshot().queued).toEqual([])

    expect(
      (await post("/api/scheduler/concurrency", { maxConcurrent: 4 })).status,
    ).toBe(200)
    expect(scheduler.snapshot().maxConcurrent).toBe(4)
    const invalidConcurrency = await post("/api/scheduler/concurrency", {
      maxConcurrent: 0,
    })
    expect(invalidConcurrency.status).toBe(400)
    expect(await invalidConcurrency.json()).toMatchObject({
      error: "invalid_scheduler_configuration",
    })

    const dispatched = await post("/api/challenges/misc-1/dispatch")
    expect(dispatched.status).toBe(200)
    const dispatchedBody = (await dispatched.json()) as {
      challenges: Array<{ id: string; status: string }>
    }
    expect(
      dispatchedBody.challenges.find((item) => item.id === "misc-1")?.status,
    ).toBe("queued")

    expect((await post("/api/challenges/misc-1/cancel")).status).toBe(200)
    expect(scheduler.snapshot().queued).toHaveLength(0)

    expect((await post("/api/runs/run-pwn-1/retry")).status).toBe(200)
    expect(
      (
        await post("/api/runs/run-pwn-1/retry", {
          prompt: "Focus on the saved crash input.",
        })
      ).status,
    ).toBe(200)
    expect(scheduler.retryAttemptCalls).toEqual([
      { runId: "run-pwn-1" },
      { runId: "run-pwn-1", prompt: "Focus on the saved crash input." },
    ])
    expect(
      (
        await post("/api/runs/run-pwn-1/retry", {
          prompt: "x".repeat(32_001),
        })
      ).status,
    ).toBe(400)
  })

  it("保存模型配置且不向浏览器回传 API Key", async () => {
    const modelConfiguration = new FakeModelConfiguration()
    const server = await startWebUi({
      project: new FakeDashboardProject(),
      scheduler: new FakeDashboardScheduler(),
      modelConfiguration,
      host: "127.0.0.1",
      port: 0,
      pollIntervalMs: 60_000,
    })
    servers.push(server)

    const initial = await fetch(`${server.url}/api/model-config`)
    expect(initial.status).toBe(200)
    const initialConfiguration = await initial.json()
    expect(initialConfiguration).toMatchObject({ models: [] })
    expect(initialConfiguration.subagentRoles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "general-purpose" }),
      ]),
    )

    const apiKey = "secret-model-key"
    const saved = await fetch(`${server.url}/api/model-config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        models: [
          {
            id: "solver",
            provider: "custom-openai",
            modelId: "solver-model",
            baseUrl: "https://models.example.test/v1/",
            contextWindow: 64_000,
            thinkingEnabled: true,
            reasoningEffort: "high",
            apiKey,
          },
        ],
        solverModelId: "solver",
        tldrModelId: "solver",
        subagentModels: { explorer: "solver" },
      }),
    })
    expect(saved.status).toBe(200)
    const savedText = await saved.text()
    expect(savedText).not.toContain(apiKey)
    expect(JSON.parse(savedText)).toMatchObject({
      configuration: {
        models: [
          {
            provider: "custom-openai",
            modelId: "solver-model",
            baseUrl: "https://models.example.test/v1",
            apiKeyConfigured: true,
            apiKeySource: "secret-store",
            thinkingEnabled: true,
            reasoningEffort: "high",
          },
        ],
        solverModelId: "solver",
        tldrModelId: "solver",
        subagentModels: { explorer: "solver" },
        configured: true,
      },
    })
    expect(modelConfiguration.lastApiKey).toBe(apiKey)

    const invalid = await fetch(`${server.url}/api/model-config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        models: [
          {
            id: "solver",
            provider: "custom-openai",
            modelId: "solver-model",
            baseUrl: "file:///tmp/model",
            contextWindow: 1_024,
            thinkingEnabled: false,
            reasoningEffort: "max",
          },
        ],
        solverModelId: "solver",
        tldrModelId: "solver",
        subagentModels: {},
      }),
    })
    expect(invalid.status).toBe(400)

    const badEffort = await fetch(`${server.url}/api/model-config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        models: [
          {
            id: "solver",
            provider: "custom-openai",
            modelId: "solver-model",
            baseUrl: "",
            contextWindow: 1_024,
            thinkingEnabled: false,
            reasoningEffort: "ultra",
          },
        ],
        solverModelId: "solver",
        tldrModelId: "solver",
        subagentModels: {},
      }),
    })
    expect(badEffort.status).toBe(400)

    const missingBinding = await fetch(`${server.url}/api/model-config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        models: [
          {
            id: "solver",
            provider: "custom-openai",
            modelId: "solver-model",
            baseUrl: "https://models.example.test/v1",
            contextWindow: 64_000,
            thinkingEnabled: true,
            reasoningEffort: "medium",
          },
        ],
        solverModelId: "missing",
        tldrModelId: "solver",
        subagentModels: {},
      }),
    })
    expect(missingBinding.status).toBe(400)
  })

  it("运行中切换思考强度(200/400/409 契约)", async () => {
    const project = new FakeDashboardProject()
    const server = await startWebUi({
      project,
      host: "127.0.0.1",
      port: 0,
      pollIntervalMs: 60_000,
    })
    servers.push(server)

    const ok = await fetch(
      `${server.url}/api/challenges/pwn-1/thinking-level`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ level: "max" }),
      },
    )
    expect(ok.status).toBe(200)
    expect(project.thinkingLevelCalls).toEqual([
      { challengeId: "pwn-1", level: "max" },
    ])

    const invalid = await fetch(
      `${server.url}/api/challenges/pwn-1/thinking-level`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ level: "ultra" }),
      },
    )
    expect(invalid.status).toBe(400)

    project.thinkingLevelResult = { error: "no_active_run" }
    const noRun = await fetch(
      `${server.url}/api/challenges/pwn-1/thinking-level`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ level: "low" }),
      },
    )
    expect(noRun.status).toBe(409)
  })

  it("向运行中的 Agent 发送人工消息(200/400/409 契约)", async () => {
    const project = new FakeDashboardProject()
    const server = await startWebUi({
      project,
      host: "127.0.0.1",
      port: 0,
      pollIntervalMs: 60_000,
    })
    servers.push(server)
    const post = (path: string, body: unknown) =>
      fetch(`${server.url}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })

    const delivered = await post("/api/challenges/pwn-1/message", {
      text: "先检查文件头",
    })
    expect(delivered.status).toBe(200)
    expect(await delivered.json()).toEqual({ runId: "run-pwn-1" })
    expect(project.sendMessageCalls).toEqual([
      { challengeId: "pwn-1", text: "先检查文件头" },
    ])

    expect(
      (await post("/api/challenges/pwn-1/message", { text: "   " })).status,
    ).toBe(400)
    expect((await post("/api/challenges/pwn-1/message", {})).status).toBe(400)

    project.sendMessageResult = { error: "no_active_run" }
    const noActive = await post("/api/challenges/pwn-1/message", {
      text: "继续",
    })
    expect(noActive.status).toBe(409)
    expect(await noActive.json()).toMatchObject({ error: "no_active_run" })

    // project 抛 invalid_message 时保留其原始文案(不统一改写为"消息不能为空")
    project.sendMessageResult = { error: "invalid_message" }
    const invalidMessage = await post("/api/challenges/pwn-1/message", {
      text: "x",
    })
    expect(invalidMessage.status).toBe(400)
    expect(await invalidMessage.json()).toMatchObject({
      error: "invalid_message",
      message: "消息内容不合法(测试)",
    })

    // message 路由不落入 dispatch|cancel 正则(不要求 scheduler)
    const withoutScheduler = await post("/api/challenges/pwn-1/dispatch", {})
    expect(withoutScheduler.status).toBe(503)
  })

  it("详情包含 SubAgent，并提供 steer/cancel 控制 API", async () => {
    const project = new FakeDashboardProject()
    const server = await startWebUi({
      project,
      host: "127.0.0.1",
      port: 0,
      pollIntervalMs: 60_000,
    })
    servers.push(server)
    const post = (path: string, body: unknown = {}) =>
      fetch(`${server.url}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })

    const details = await fetch(`${server.url}/api/challenges/pwn-1`)
    expect(await details.json()).toMatchObject({
      runs: [
        {
          id: "run-pwn-1",
          subagents: [
            {
              id: "worker-pwn-1",
              role: "pwn",
              status: "running",
              activeTool: "bash",
            },
          ],
        },
      ],
    })

    const steered = await post(
      "/api/runs/run-pwn-1/subagents/worker-pwn-1/steer",
      { message: "先验证泄漏稳定性" },
    )
    expect(steered.status).toBe(200)
    expect(await steered.json()).toMatchObject({
      id: "worker-pwn-1",
      description: expect.stringContaining("先验证泄漏稳定性"),
    })

    expect(
      (
        await post("/api/runs/run-pwn-1/subagents/worker-pwn-1/steer", {
          message: "   ",
        })
      ).status,
    ).toBe(400)

    const cancelled = await post(
      "/api/runs/run-pwn-1/subagents/worker-pwn-1/cancel",
    )
    expect(cancelled.status).toBe(200)
    expect(await cancelled.json()).toMatchObject({
      id: "worker-pwn-1",
      status: "cancelled",
    })
  })

  it("HTML 导出仅接受明确的 Run 或 SubAgent 会话", async () => {
    const project = new FakeDashboardProject()
    const server = await startWebUi({
      project,
      host: "127.0.0.1",
      port: 0,
      pollIntervalMs: 60_000,
      sessionHasConversation: async () => true,
    })
    servers.push(server)

    const ambiguous = await fetch(`${server.url}/api/challenges/pwn-1/export`)
    expect(ambiguous.status).toBe(404)
    expect(await ambiguous.json()).toMatchObject({
      error: "challenge_not_found",
    })

    const missingRun = await fetch(`${server.url}/api/runs/nope/export`)
    expect(missingRun.status).toBe(404)
    expect(await missingRun.json()).toMatchObject({ error: "run_not_found" })

    const missingSubagent = await fetch(
      `${server.url}/api/runs/run-pwn-1/subagents/nope/export`,
    )
    expect(missingSubagent.status).toBe(404)
    expect(await missingSubagent.json()).toMatchObject({
      error: "subagent_not_found",
    })
  })

  it("尚未产生 Agent 对话的 attempt 和 SubAgent 均拒绝导出", async () => {
    const project = new FakeDashboardProject()
    let exportCalls = 0
    const server = await startWebUi({
      project,
      host: "127.0.0.1",
      port: 0,
      pollIntervalMs: 60_000,
      sessionHasConversation: async () => false,
      exportSessionHtml: async () => {
        exportCalls++
        return Buffer.from("<!doctype html>")
      },
    })
    servers.push(server)

    for (const path of [
      "/api/runs/run-pwn-1/export",
      "/api/runs/run-pwn-1/subagents/worker-pwn-1/export",
    ]) {
      const response = await fetch(`${server.url}${path}`)
      expect(response.status).toBe(409)
      expect(await response.json()).toMatchObject({
        error: "session_not_ready",
      })
    }
    expect(exportCalls).toBe(0)
  })

  it("Run 与 SubAgent 对话使用各自的 Pi JSONL 导出 HTML", async () => {
    const project = new FakeDashboardProject()
    const sessionExports: Array<{
      sessionPath: string
      systemPrompt?: string
      toolNames?: string[]
    }> = []
    const server = await startWebUi({
      project,
      host: "127.0.0.1",
      port: 0,
      pollIntervalMs: 60_000,
      sessionHasConversation: async () => true,
      exportSessionHtml: async (sessionPath, metadata) => {
        sessionExports.push({
          sessionPath,
          systemPrompt: metadata?.systemPrompt,
          toolNames: metadata?.tools.map((tool) => tool.name),
        })
        return Buffer.from("<!doctype html><title>Pi Session</title>")
      },
    })
    servers.push(server)

    const runExport = await fetch(`${server.url}/api/runs/run-pwn-1/export`)
    expect(runExport.status).toBe(200)
    expect(runExport.headers.get("content-type")).toContain("text/html")
    expect(runExport.headers.get("content-disposition")).toBeNull()
    expect(await runExport.text()).toContain("<title>Pi Session")

    const subagentExport = await fetch(
      `${server.url}/api/runs/run-pwn-1/subagents/worker-pwn-1/export`,
    )
    expect(subagentExport.status).toBe(200)
    expect(await subagentExport.text()).toContain("<title>Pi Session")
    expect(sessionExports).toEqual([
      {
        sessionPath: "/sessions/run-pwn-1/session.jsonl",
        systemPrompt: "You are a CTF solver.",
        toolNames: ["ctf_submit_flag"],
      },
      {
        sessionPath: "/sessions/worker-pwn-1/session.jsonl",
        systemPrompt: undefined,
        toolNames: undefined,
      },
    ])
  })

  it("Run 与 SubAgent 通过同一结构化 API 返回当前 Pi 对话", async () => {
    const project = new FakeDashboardProject()
    const reads: string[] = []
    const server = await startWebUi({
      project,
      host: "127.0.0.1",
      port: 0,
      pollIntervalMs: 60_000,
      readSessionConversation: (sessionPath) => {
        reads.push(sessionPath)
        return {
          messages: [
            {
              entryId: "assistant-1",
              timestamp: "2026-08-01T00:00:00.000Z",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "found offset" }],
                api: "openai-completions",
                provider: "test",
                model: "test-model",
                usage: {
                  input: 1,
                  output: 1,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 2,
                  cost: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    total: 0,
                  },
                },
                stopReason: "stop",
                timestamp: 1,
              },
            },
          ],
        }
      },
    })
    servers.push(server)

    const run = await fetch(`${server.url}/api/runs/run-pwn-1/conversation`)
    const subagent = await fetch(
      `${server.url}/api/runs/run-pwn-1/subagents/worker-pwn-1/conversation`,
    )

    expect(run.status).toBe(200)
    expect(await run.json()).toMatchObject({
      messages: [{ message: { role: "assistant" } }],
    })
    expect(subagent.status).toBe(200)
    expect(reads).toEqual([
      "/sessions/run-pwn-1/session.jsonl",
      "/sessions/worker-pwn-1/session.jsonl",
    ])
  })

  it("尚未产生 assistant 消息时结构化对话也不可查看", async () => {
    const project = new FakeDashboardProject()
    const server = await startWebUi({
      project,
      host: "127.0.0.1",
      port: 0,
      pollIntervalMs: 60_000,
      readSessionConversation: () => ({
        messages: [
          {
            entryId: "user-1",
            timestamp: "2026-08-01T00:00:00.000Z",
            message: { role: "user", content: "start", timestamp: 1 },
          },
        ],
      }),
    })
    servers.push(server)

    const response = await fetch(
      `${server.url}/api/runs/run-pwn-1/conversation`,
    )
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: "session_not_ready" })
  })

  it("导出响应内联呈现，平台/run 数据不进入任何响应头(防 header 注入)", async () => {
    const project = new FakeDashboardProject()
    project.runValues.push({
      id: 'run"evil"1',
      challengeId: 'pwn"1;../evil',
      workspace: "/workspace/run-evil-1",
      attempt: 1,
      source: "manual",
      status: "running",
      createdAt: "2026-07-29T12:06:00.000Z",
      updatedAt: "2026-07-29T12:06:00.000Z",
    })
    const server = await startWebUi({
      project,
      host: "127.0.0.1",
      port: 0,
      pollIntervalMs: 60_000,
      sessionHasConversation: async () => true,
      exportSessionHtml: async () => Buffer.from("<!doctype html>"),
    })
    servers.push(server)

    const response = await fetch(
      `${server.url}/api/runs/${encodeURIComponent('run"evil"1')}/export`,
    )
    expect(response.status).toBe(200)
    // 内联页面不带下载文件名，因此平台/run 数据完全不会出现在响应头。
    expect(response.headers.get("content-disposition")).toBeNull()
    expect(response.headers.get("content-type")).toContain("text/html")
    expect(await response.text()).toContain("<!doctype html>")
  })
})
