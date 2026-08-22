import { describe, expect, it } from "vite-plus/test"
import { createWebUiApp } from "../src/server.ts"
import {
  FakeDashboardProject,
  FakeDashboardScheduler,
  FakeModelConfiguration,
} from "./fake-project.ts"
import { jsonOf, jsonRequest } from "./helpers.ts"

function appWithScheduler() {
  const project = new FakeDashboardProject()
  const scheduler = new FakeDashboardScheduler()
  const modelConfiguration = new FakeModelConfiguration()
  const { app } = createWebUiApp({
    project,
    scheduler,
    modelConfiguration,
    frontendDist: "/nonexistent",
  })
  return { app, project, scheduler, modelConfiguration }
}

describe("调度器路由", () => {
  it("自主启停、并发设置与人工调度/取消", async () => {
    const { app, scheduler } = appWithScheduler()

    expect((await jsonRequest(app, "/api/scheduler/auto/start", "POST", {})).status).toBe(200)
    expect(scheduler.snapshot().autoEnabled).toBe(true)

    scheduler.value.queued.push({
      challengeId: "misc-1",
      source: "manual",
      stage: "execution",
      lane: "normal",
      manualOverride: false,
      enqueuedAt: "2026-07-29T12:00:00.000Z",
      position: 1,
      version: 1,
    })
    scheduler.value.active.push({
      challengeId: "pwn-1",
      runId: "run-pwn-1",
      attempt: 1,
      source: "auto",
      phase: "running",
      startedAt: "2026-07-29T12:00:00.000Z",
    })
    expect((await jsonRequest(app, "/api/scheduler/auto/pause", "POST", {})).status).toBe(200)
    expect(scheduler.snapshot().autoEnabled).toBe(false)
    expect(scheduler.snapshot().queued).toHaveLength(1)
    expect(scheduler.snapshot().active).toHaveLength(1)

    expect((await jsonRequest(app, "/api/scheduler/active/stop", "POST", {})).status).toBe(200)
    expect(scheduler.stopAllActiveCalls).toBe(1)
    expect(scheduler.snapshot().active).toEqual([])

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

  it("批量编排空闲队列，并在启动时按顺序提交到执行队列", async () => {
    const { app, scheduler } = appWithScheduler()

    const staged = await jsonRequest(app, "/api/scheduler/idle", "POST", {
      challengeIds: ["misc-1", "pwn-1"],
    })
    expect(staged.status).toBe(200)
    expect(scheduler.snapshot().idle.map((item) => item.challengeId)).toEqual(["misc-1", "pwn-1"])

    const reordered = await jsonRequest(app, "/api/scheduler/idle/order", "PUT", {
      challengeIds: ["pwn-1", "misc-1"],
      expectedVersion: scheduler.snapshot().idleVersion,
    })
    expect(reordered.status).toBe(200)
    expect(scheduler.snapshot().idle.map((item) => item.challengeId)).toEqual(["pwn-1", "misc-1"])

    const staleOrder = await jsonRequest(app, "/api/scheduler/idle/order", "PUT", {
      challengeIds: ["misc-1", "pwn-1"],
      expectedVersion: scheduler.snapshot().idleVersion - 1,
    })
    expect(staleOrder.status).toBe(409)
    expect(await jsonOf(staleOrder)).toMatchObject({
      error: "queue_version_conflict",
      snapshot: {
        scheduler: {
          idle: [{ challengeId: "pwn-1" }, { challengeId: "misc-1" }],
        },
      },
    })

    const removed = await jsonRequest(app, "/api/scheduler/idle", "DELETE", {
      challengeIds: ["misc-1"],
    })
    expect(removed.status).toBe(200)
    expect(scheduler.snapshot().idle.map((item) => item.challengeId)).toEqual(["pwn-1"])
    expect(
      (
        await jsonRequest(app, "/api/scheduler/idle", "POST", {
          challengeIds: ["misc-1"],
        })
      ).status,
    ).toBe(200)

    expect((await jsonRequest(app, "/api/scheduler/start", "POST", {})).status).toBe(200)
    expect(scheduler.snapshot()).toMatchObject({
      state: "running",
      mode: "manual",
      idle: [],
      queued: [
        { challengeId: "pwn-1", stage: "execution" },
        { challengeId: "misc-1", stage: "execution" },
      ],
    })

    const invalid = await jsonRequest(app, "/api/scheduler/idle", "POST", {
      challengeIds: [],
    })
    expect(invalid.status).toBe(400)
    expect(await jsonOf(invalid)).toMatchObject({ error: "invalid_scheduler_idle_batch" })
  })

  it("队列重排：position 与 expectedVersion 各自错误码", async () => {
    const { app, scheduler } = appWithScheduler()
    scheduler.value.queued.push({
      challengeId: "misc-1",
      source: "manual",
      stage: "execution",
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

    const stale = await jsonRequest(app, "/api/scheduler/queue/misc-1", "PATCH", {
      position: 1,
      expectedVersion: 1,
    })
    expect(stale.status).toBe(409)
    expect(await jsonOf(stale)).toMatchObject({
      error: "queue_version_conflict",
      snapshot: {
        scheduler: {
          queued: [{ challengeId: "misc-1", position: 2, version: 2 }],
        },
      },
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

  it("仅在 Solver 模型可用时恢复已暂停的调度器", async () => {
    const { app, scheduler, modelConfiguration } = appWithScheduler()
    modelConfiguration.value.configured = true
    delete modelConfiguration.value.unavailableReason
    scheduler.value.available = false
    scheduler.value.unavailableReason = "LLM 服务需要人工处理"

    const response = await jsonRequest(app, "/api/scheduler/resume", "POST", {})
    expect(response.status).toBe(200)
    expect(scheduler.resumeCalls).toBe(1)
    expect(scheduler.snapshot()).toMatchObject({ available: true })
  })

  it("Solver 模型不可用时拒绝恢复且保持调度器暂停", async () => {
    const { app, scheduler } = appWithScheduler()
    scheduler.value.available = false
    scheduler.value.unavailableReason = "LLM 服务需要人工处理"

    const response = await jsonRequest(app, "/api/scheduler/resume", "POST", {})
    expect(response.status).toBe(409)
    expect(await jsonOf(response)).toMatchObject({ error: "solver_model_unavailable" })
    expect(scheduler.resumeCalls).toBe(0)
    expect(scheduler.snapshot()).toMatchObject({
      available: false,
      unavailableReason: "LLM 服务需要人工处理",
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
