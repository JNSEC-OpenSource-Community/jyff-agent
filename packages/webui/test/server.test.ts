import { afterEach, describe, expect, it } from "vitest"
import { startWebUi, type WebUiServer } from "../src/server.ts"
import type { DashboardControlPlane } from "../src/types.ts"
import {
  FakeDashboardProject,
  FakeDashboardScheduler,
  FakeModelConfiguration,
} from "./fake-project.ts"

const servers: WebUiServer[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

describe("WebUI HTTP server", () => {
  it("未配置时仍可启动，并通过控制面 API 测试和应用平台配置", async () => {
    let project: FakeDashboardProject | undefined
    let phase: "unconfigured" | "ready" = "unconfigured"
    let appliedConfig: unknown
    const snapshot = () => ({
      phase,
      configured: phase === "ready",
      projectId: phase === "ready" ? "demo" : null,
      projectName: phase === "ready" ? "Demo CTF" : null,
      platformId: phase === "ready" ? "ctfd" : null,
      lastError: null,
      updatedAt: "2026-08-04T00:00:00.000Z",
    })
    const controlPlane: DashboardControlPlane = {
      snapshot,
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
    }
    const server = await startWebUi({
      controlPlane,
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
    const tested = await fetch(`${server.url}/api/control-plane/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config, secrets: { CTFD_TOKEN: "secret" } }),
    })
    expect(tested.status).toBe(200)
    expect(await tested.json()).toMatchObject({ ok: true })

    const applied = await fetch(`${server.url}/api/control-plane/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config, secrets: { CTFD_TOKEN: "secret" } }),
    })
    expect(applied.status).toBe(200)
    expect(appliedConfig).toEqual(config)
    expect(await applied.json()).toMatchObject({
      setup: { state: { phase: "ready" } },
      snapshot: { overview: { name: "Test CTF" } },
    })
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
    expect(await home.text()).toContain("题目作战面板")

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

  it("提供自主启停、人工调度和取消 API", async () => {
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
    expect((await post("/api/scheduler/auto/pause")).status).toBe(200)
    expect(scheduler.snapshot().autoEnabled).toBe(false)

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
    expect(await initial.json()).toMatchObject({
      provider: "openrouter",
      apiKeyConfigured: false,
    })

    const apiKey = "secret-model-key"
    const saved = await fetch(`${server.url}/api/model-config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "custom-openai",
        modelId: "solver-model",
        baseUrl: "https://models.example.test/v1/",
        contextWindow: 64_000,
        maxTokens: 4_096,
        thinkingEnabled: true,
        reasoningEffort: "high",
        apiKey,
      }),
    })
    expect(saved.status).toBe(200)
    const savedText = await saved.text()
    expect(savedText).not.toContain(apiKey)
    expect(JSON.parse(savedText)).toMatchObject({
      configuration: {
        provider: "custom-openai",
        modelId: "solver-model",
        baseUrl: "https://models.example.test/v1",
        apiKeyConfigured: true,
        apiKeySource: "secret-store",
        thinkingEnabled: true,
        reasoningEffort: "high",
        configured: true,
      },
    })
    expect(modelConfiguration.lastApiKey).toBe(apiKey)

    const invalid = await fetch(`${server.url}/api/model-config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "custom-openai",
        modelId: "solver-model",
        baseUrl: "file:///tmp/model",
        contextWindow: 1_024,
        maxTokens: 2_048,
        thinkingEnabled: false,
        reasoningEffort: "max",
      }),
    })
    expect(invalid.status).toBe(400)

    const badEffort = await fetch(`${server.url}/api/model-config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "custom-openai",
        modelId: "solver-model",
        baseUrl: "",
        contextWindow: 1_024,
        maxTokens: 2_048,
        thinkingEnabled: false,
        reasoningEffort: "ultra",
      }),
    })
    expect(badEffort.status).toBe(400)
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

  it("会话复盘导出:无 run 404;指定不存在 run 404;200 返回 Markdown 与附件头", async () => {
    const project = new FakeDashboardProject()
    const server = await startWebUi({
      project,
      host: "127.0.0.1",
      port: 0,
      pollIntervalMs: 60_000,
    })
    servers.push(server)

    // 无 run 的题 → 404 no_runs
    const noRuns = await fetch(`${server.url}/api/challenges/web-1/export`)
    expect(noRuns.status).toBe(404)
    expect(await noRuns.json()).toMatchObject({ error: "no_runs" })

    // 指定不存在的 run → 404 run_not_found
    const missingRun = await fetch(
      `${server.url}/api/challenges/pwn-1/export?run=nope`,
    )
    expect(missingRun.status).toBe(404)
    expect(await missingRun.json()).toMatchObject({ error: "run_not_found" })

    // 存在 run → 200 Markdown 附件
    const exportAll = await fetch(`${server.url}/api/challenges/pwn-1/export`)
    expect(exportAll.status).toBe(200)
    expect(exportAll.headers.get("content-type")).toContain("text/markdown")
    expect(exportAll.headers.get("content-disposition")).toMatch(
      /^attachment; filename="session-pwn-1-all-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.md"$/,
    )
    const body = await exportAll.text()
    expect(body).toContain("# CTF Agent 会话复盘：pwn-1")
    expect(body).toContain("## Run run-pwn-（attempt 1 · running）")

    // 指定 run + full 参数同样可用
    const single = await fetch(
      `${server.url}/api/challenges/pwn-1/export?run=run-pwn-1&full=1`,
    )
    expect(single.status).toBe(200)
    expect(single.headers.get("content-disposition")).toMatch(
      /filename="session-pwn-1-[a-z0-9-]+-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.md"/,
    )
    expect(await single.text()).toContain("Run 数：1（指定 run-pwn-1）")
  })

  it("导出文件名对平台数据做白名单消毒(防 header 注入)", async () => {
    const project = new FakeDashboardProject()
    project.runValues.push({
      id: "run-evil-1",
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
    })
    servers.push(server)

    const response = await fetch(
      `${server.url}/api/challenges/${encodeURIComponent('pwn"1;../evil')}/export`,
    )
    expect(response.status).toBe(200)
    const disposition = response.headers.get("content-disposition")
    expect(disposition).not.toBeNull()
    const filename = /filename="([^"]+)"/.exec(disposition ?? "")?.[1]
    expect(filename).toBeDefined()
    if (filename === undefined) throw new Error("响应缺少导出文件名")
    expect(filename).toContain("session-pwn_1_.._evil-all-")
    expect(filename).not.toContain('"')
    expect(filename).not.toContain(";")
    expect(filename).not.toContain("/")
  })
})
