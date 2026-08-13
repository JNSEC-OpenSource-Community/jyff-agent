import { afterEach, describe, expect, it } from "vite-plus/test"
import { FakeDashboardProject } from "./fake-project.ts"
import { createTestApp, jsonOf, jsonRequest, readSseUntil, type TestApp } from "./helpers.ts"

describe("系统与快照路由", () => {
  let testApp: TestApp | undefined

  afterEach(async () => {
    await testApp?.cleanup()
    testApp = undefined
  })

  it("提供健康检查、静态前端与 SPA 兜底", async () => {
    testApp = await createTestApp()
    const { app } = testApp

    const health = await app.request("/health")
    expect(health.status).toBe(200)
    expect(await jsonOf(health)).toMatchObject({
      status: "ok",
      connectedClients: 0,
      platformSync: { status: "ok" },
    })

    const home = await app.request("/")
    expect(home.headers.get("content-type")).toContain("text/html")

    // SPA 兜底：任意非 API 路径返回首页
    const nested = await app.request("/projects/demo/settings")
    expect(nested.status).toBe(200)
    expect(nested.headers.get("content-type")).toContain("text/html")

    // 未知 API 路径返回结构化 404
    const unknown = await app.request("/api/does-not-exist")
    expect(unknown.status).toBe(404)
    expect(await jsonOf(unknown)).toEqual({ error: "not_found" })
  })

  it("快照、详情与平台刷新 API", async () => {
    const project = new FakeDashboardProject()
    testApp = await createTestApp({ project })
    const { app } = testApp

    const snapshot = await app.request("/api/snapshot")
    expect(snapshot.status).toBe(200)
    const snapshotBody = await jsonOf(snapshot)
    expect(snapshotBody.challenges).toHaveLength(3)
    expect(snapshotBody.overview).toMatchObject({ name: "Test CTF" })

    const details = await app.request("/api/challenges/pwn-1")
    expect(details.status).toBe(200)
    expect(await jsonOf(details)).toMatchObject({
      challenge: { title: "Heap Garden" },
    })
    expect((await app.request("/api/challenges/missing")).status).toBe(404)

    const refreshed = await jsonRequest(app, "/api/refresh", "POST", {})
    expect(refreshed.status).toBe(200)
    expect(project.refreshCalls).toBe(1)
  })

  it("平台部分读取失败时保留其余题目内容和本地 Run 详情", async () => {
    const project = new FakeDashboardProject()
    project.overviewError = new Error("platform offline")
    testApp = await createTestApp({ project })
    const { app } = testApp

    const snapshot = await app.request("/api/snapshot")
    expect(snapshot.status).toBe(200)
    expect(await jsonOf(snapshot)).toMatchObject({
      overview: { name: "本地记录" },
      challenges: [
        expect.objectContaining({
          id: "pwn-1",
          title: "Heap Garden",
          category: "pwn",
        }),
        expect.objectContaining({ id: "web-1", title: "Cookie Jar" }),
        expect.objectContaining({ id: "misc-1", title: "Signal" }),
      ],
    })

    const details = await app.request("/api/challenges/pwn-1")
    expect(details.status).toBe(200)
    expect(await jsonOf(details)).toMatchObject({
      solverAvailable: false,
      challenge: { id: "pwn-1" },
      runs: [expect.objectContaining({ id: "run-pwn-1" })],
    })
  })

  it("项目级路径两种形态（新式与旧式 /api 后缀）等价", async () => {
    testApp = await createTestApp()
    const { app } = testApp

    for (const prefix of ["/api/projects/whatever", "/api/projects/whatever/api"]) {
      const snapshot = await app.request(`${prefix}/snapshot`)
      expect(snapshot.status).toBe(200)
      expect(await jsonOf(snapshot)).toMatchObject({
        overview: { name: "Test CTF" },
      })
    }
  })

  it("项目 Dashboard 可以释放受管远程环境", async () => {
    const project = new FakeDashboardProject()
    testApp = await createTestApp({ project })
    const { app } = testApp

    const response = await app.request("/api/projects/whatever/environments/env-1", {
      method: "DELETE",
    })

    expect(response.status).toBe(200)
    expect(await jsonOf(response)).toMatchObject({
      remoteEnvironment: {
        capacity: { maximum: 1, occupied: 0, available: 1 },
        leases: [],
      },
    })
    expect(project.environmentValues[0]?.status).toBe("stopped")
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
    testApp = await createTestApp({ project })
    const { app } = testApp

    const response = await jsonRequest(app, "/api/announcements/review", "POST", {
      challengeId: "web-1",
      announcementKey: "notice:revision",
      status: "approved",
    })
    expect(response.status).toBe(200)
    expect(project.announcementReviews).toEqual([
      {
        challengeId: "web-1",
        announcementKey: "notice:revision",
        status: "approved",
      },
    ])
    expect(await jsonOf(response)).toMatchObject({
      announcementCandidates: [{ approvalStatus: "approved" }],
    })
  })

  it("通过 SSE 立即发送当前快照，并在 refresh 后广播更新", async () => {
    const project = new FakeDashboardProject()
    testApp = await createTestApp({ project })
    const { app, sync } = testApp

    const response = await app.request("/api/events")
    expect(response.headers.get("content-type")).toContain("text/event-stream")
    const initial = await readSseUntil(response, "event: snapshot")
    expect(initial).toContain("event: snapshot")
    expect(initial).toContain('"name":"Test CTF"')

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
    await sync.refresh()
    const update = await readSseUntil(response, "run-misc-1")
    expect(update).toContain("event: snapshot")
    expect(update).toContain("run-misc-1")
  })

  it("项目级 SSE 只广播该项目内容", async () => {
    testApp = await createTestApp()
    const { app } = testApp
    const response = await app.request("/api/projects/alpha/events")
    expect(response.status).toBe(200)
    const received = await readSseUntil(response, "event: snapshot")
    expect(received).toContain('"name":"Test CTF"')
  })

  it("SSE 客户端断开后从注册表移除", async () => {
    testApp = await createTestApp()
    const { app, sse } = testApp
    const response = await app.request("/api/events")
    await readSseUntil(response, "event: snapshot")
    expect(sse.size).toBe(1)
    await response.body?.getReader().cancel()
    // 等待 abort 传播
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(sse.size).toBe(0)
  })
})
