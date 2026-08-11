import { describe, expect, it } from "vite-plus/test"
import { createWebUiApp } from "../src/server.ts"
import { FakeDashboardProject, FakeDashboardScheduler } from "./fake-project.ts"
import { jsonOf, jsonRequest } from "./helpers.ts"

function appWithScheduler() {
  const project = new FakeDashboardProject()
  const scheduler = new FakeDashboardScheduler()
  const { app } = createWebUiApp({
    project,
    scheduler,
    frontendDist: "/nonexistent",
  })
  return { app, project, scheduler }
}

describe("调度器路由", () => {
  it("自主启停、并发设置与人工调度/取消", async () => {
    const { app, scheduler } = appWithScheduler()

    expect((await jsonRequest(app, "/api/scheduler/auto/start", "POST", {})).status).toBe(200)
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
    expect((await jsonRequest(app, "/api/scheduler/auto/pause", "POST", {})).status).toBe(200)
    expect(scheduler.snapshot().autoEnabled).toBe(false)
    expect(scheduler.snapshot().queued).toEqual([])

    const concurrency = await jsonRequest(app, "/api/scheduler/concurrency", "POST", {
      maxConcurrent: 4,
    })
    expect(concurrency.status).toBe(200)
    expect(scheduler.snapshot().maxConcurrent).toBe(4)

    const invalid = await jsonRequest(app, "/api/scheduler/concurrency", "POST", {
      maxConcurrent: 0,
    })
    expect(invalid.status).toBe(400)
    expect(await jsonOf(invalid)).toMatchObject({
      error: "invalid_scheduler_configuration",
    })

    const dispatched = await jsonRequest(app, "/api/challenges/misc-1/dispatch", "POST", {})
    expect(dispatched.status).toBe(200)
    const dispatchedBody = await jsonOf(dispatched)
    expect(
      (dispatchedBody.challenges as Array<{ id: string; status: string }>).find(
        (item) => item.id === "misc-1",
      )?.status,
    ).toBe("queued")
    expect(scheduler.dispatchCalls).toEqual([{ challengeId: "misc-1", force: false }])

    expect((await jsonRequest(app, "/api/challenges/misc-1/cancel", "POST", {})).status).toBe(200)
    expect(scheduler.snapshot().queued).toHaveLength(0)

    const forced = await jsonRequest(app, "/api/challenges/pwn-1/dispatch", "POST", {
      force: true,
    })
    expect(forced.status).toBe(200)
    expect(scheduler.dispatchCalls.at(-1)).toEqual({
      challengeId: "pwn-1",
      force: true,
    })
  })

  it("队列重排：position 与 expectedVersion 各自错误码", async () => {
    const { app, scheduler } = appWithScheduler()
    scheduler.value.queued.push({
      challengeId: "misc-1",
      source: "manual",
      lane: "normal",
      manualOverride: false,
      enqueuedAt: "2026-07-29T12:00:00.000Z",
      position: 1,
      version: 1,
    })

    const ok = await jsonRequest(app, "/api/scheduler/queue/misc-1", "PATCH", {
      position: 2,
      expectedVersion: 1,
      overrideBlockedLane: true,
    })
    expect(ok.status).toBe(200)
    expect(scheduler.snapshot().queued[0]).toMatchObject({
      challengeId: "misc-1",
      position: 2,
    })

    const badPosition = await jsonRequest(app, "/api/scheduler/queue/misc-1", "PATCH", {
      position: 0,
      expectedVersion: 1,
    })
    expect(badPosition.status).toBe(400)
    expect(await jsonOf(badPosition)).toMatchObject({
      error: "invalid_queue_position",
    })

    const badVersion = await jsonRequest(app, "/api/scheduler/queue/misc-1", "PATCH", {
      position: 2,
      expectedVersion: 0,
    })
    expect(badVersion.status).toBe(400)
    expect(await jsonOf(badVersion)).toMatchObject({
      error: "invalid_queue_version",
    })
  })

  it("未配置调度器时调度端点返回 503 unavailable", async () => {
    const { app } = createWebUiApp({
      project: new FakeDashboardProject(),
      frontendDist: "/nonexistent",
    })
    const response = await jsonRequest(app, "/api/scheduler/auto/start", "POST", {})
    expect(response.status).toBe(503)
    expect(await jsonOf(response)).toMatchObject({ error: "unavailable" })
  })

  it("Run 重试：可选 prompt，超长 prompt 400", async () => {
    const { app, scheduler } = appWithScheduler()

    expect((await jsonRequest(app, "/api/runs/run-pwn-1/retry", "POST", {})).status).toBe(200)
    expect(
      (
        await jsonRequest(app, "/api/runs/run-pwn-1/retry", "POST", {
          prompt: "Focus on the saved crash input.",
        })
      ).status,
    ).toBe(200)
    expect(scheduler.retryAttemptCalls).toEqual([
      { runId: "run-pwn-1" },
      { runId: "run-pwn-1", prompt: "Focus on the saved crash input." },
    ])

    const tooLong = await jsonRequest(app, "/api/runs/run-pwn-1/retry", "POST", {
      prompt: "x".repeat(32_001),
    })
    expect(tooLong.status).toBe(400)
    expect(await jsonOf(tooLong)).toMatchObject({
      error: "invalid_retry_prompt",
    })
  })
})
