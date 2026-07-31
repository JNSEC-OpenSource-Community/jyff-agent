import { afterEach, describe, expect, it } from "vitest"
import { startWebUi, type WebUiServer } from "../src/server.ts"
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
    expect(await health.json()).toMatchObject({ status: "ok", connectedClients: 0 })

    const home = await fetch(server.url)
    expect(home.headers.get("content-type")).toContain("text/html")
    expect(await home.text()).toContain("题目作战面板")

    const snapshot = await fetch(`${server.url}/api/snapshot`)
    const snapshotBody = await snapshot.json() as { challenges: unknown[] }
    expect(snapshotBody.challenges).toHaveLength(3)

    const details = await fetch(`${server.url}/api/challenges/pwn-1`)
    const detailsBody = await details.json() as { challenge: { title: string } }
    expect(detailsBody.challenge.title).toBe("Heap Garden")
    expect((await fetch(`${server.url}/api/challenges/missing`)).status).toBe(404)

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
    const response = await fetch(`${server.url}/api/events`, { signal: controller.signal })
    expect(response.headers.get("content-type")).toContain("text/event-stream")
    const reader = response.body!.getReader()
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
    const post = (path: string, body = {}) => fetch(`${server.url}${path}`, {
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
    const dispatchedBody = await dispatched.json() as {
      challenges: Array<{ id: string; status: string }>
    }
    expect(dispatchedBody.challenges.find((item) => item.id === "misc-1")?.status)
      .toBe("queued")

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
        apiKeySource: "webui",
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
      }),
    })
    expect(invalid.status).toBe(400)
  })
})
