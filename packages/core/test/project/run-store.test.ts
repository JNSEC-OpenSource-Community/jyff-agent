import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it } from "vitest"
import { RunStore } from "../../src/persistence/run-store.js"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

async function storeFixture(): Promise<{
  root: string
  path: string
  store: RunStore
}> {
  const root = await mkdtemp(join(tmpdir(), "ctf-run-store-"))
  roots.push(root)
  const path = join(root, "runs.sqlite")
  return { root, path, store: await RunStore.open(path) }
}

describe("RunStore", () => {
  it("持久化 Run 状态、attempt 和事件，并可在重开后查询", async () => {
    const { path, store } = await storeFixture()
    store.createRun({
      id: "run-1",
      challengeId: "web-1",
      workspace: "workspace",
      attempt: 1,
    })
    store.updateRun(
      "run-1",
      { status: "running", startedAt: "2026-01-01T00:00:00.000Z" },
      "run_started",
    )
    store.updateRun(
      "run-1",
      {
        status: "solved",
        closeReason: "submitted",
        finishedAt: "2026-01-01T00:01:00.000Z",
      },
      "run_finished",
    )

    expect(store.isSolved("web-1")).toBe(true)
    expect(store.nextAttempt("web-1")).toBe(2)
    expect(store.events("run-1").map((event) => event.type)).toEqual([
      "run_created",
      "run_started",
      "run_finished",
    ])
    store.close()

    const reopened = await RunStore.open(path)
    expect(reopened.listRuns({ challengeId: "web-1" })).toEqual([
      expect.objectContaining({
        id: "run-1",
        status: "solved",
        closeReason: "submitted",
        attempt: 1,
      }),
    ])
    reopened.close()
  })

  it("agent_thinking 事件可持久化与读取(data 原文保留)", async () => {
    const { path, store } = await storeFixture()
    store.createRun({
      id: "run-1",
      challengeId: "web-1",
      workspace: "workspace",
      attempt: 1,
    })
    const thinking = { text: "先枚举 /robots.txt，再看响应头", ts: "chunk-1" }

    const appended = store.appendEvent("run-1", "agent_thinking", thinking)
    expect(appended).toMatchObject({
      runId: "run-1",
      type: "agent_thinking",
      data: thinking,
    })
    expect(appended.createdAt).toBeTruthy()

    const persisted = store
      .events("run-1")
      .find((event) => event.type === "agent_thinking")
    expect(persisted).toEqual(
      expect.objectContaining({
        runId: "run-1",
        type: "agent_thinking",
        data: thinking,
      }),
    )
    store.close()

    const reopened = await RunStore.open(path)
    const afterReopen = reopened
      .events("run-1")
      .find((event) => event.type === "agent_thinking")
    expect(afterReopen).toEqual(
      expect.objectContaining({
        type: "agent_thinking",
        data: thinking,
      }),
    )
    reopened.close()
  })

  it("可直接读取最后事件，避免 Dashboard 扫描完整时间线", async () => {
    const { store } = await storeFixture()
    store.createRun({
      id: "run-latest",
      challengeId: "misc-1",
      workspace: "workspace",
      attempt: 1,
    })
    store.appendEvent("run-latest", "agent_thinking", { text: "first" })
    const latest = store.appendEvent("run-latest", "agent_message", {
      text: "done",
    })

    expect(store.latestEvent("run-latest")).toEqual(latest)
    expect(store.latestEvent("missing")).toBeUndefined()
    store.close()
  })

  it("agent_usage 事件可持久化与读取(data 原文保留,含 cost 与 reasoning)", async () => {
    const { path, store } = await storeFixture()
    store.createRun({
      id: "run-1",
      challengeId: "web-1",
      workspace: "workspace",
      attempt: 1,
    })
    const usage = {
      input: 1200,
      output: 340,
      cacheRead: 800,
      cacheWrite: 0,
      reasoning: 200,
      totalTokens: 1540,
      cost: {
        input: 0.01,
        output: 0.02,
        cacheRead: 0.001,
        cacheWrite: 0,
        total: 0.031,
      },
      ts: "2026-08-02T12:00:00.000Z",
    }

    const appended = store.appendEvent("run-1", "agent_usage", usage)
    expect(appended).toMatchObject({
      runId: "run-1",
      type: "agent_usage",
      data: usage,
    })
    expect(appended.createdAt).toBeTruthy()

    const persisted = store
      .events("run-1")
      .find((event) => event.type === "agent_usage")
    expect(persisted).toEqual(
      expect.objectContaining({
        runId: "run-1",
        type: "agent_usage",
        data: usage,
      }),
    )
    store.close()

    const reopened = await RunStore.open(path)
    const afterReopen = reopened
      .events("run-1")
      .find((event) => event.type === "agent_usage")
    expect(afterReopen).toEqual(
      expect.objectContaining({
        type: "agent_usage",
        data: usage,
      }),
    )
    reopened.close()
  })

  it("启动恢复时把遗留 preparing/running Run 标记为 interrupted", async () => {
    const { store } = await storeFixture()
    store.createRun({
      id: "preparing",
      challengeId: "pwn-1",
      workspace: "a",
      attempt: 1,
    })
    store.createRun({
      id: "running",
      challengeId: "pwn-2",
      workspace: "b",
      attempt: 1,
    })
    store.updateRun("running", { status: "running" })

    const interrupted = store.markInterruptedRuns("测试恢复")
    expect(interrupted).toHaveLength(2)
    expect(store.listRuns().map((run) => run.status)).toEqual([
      "interrupted",
      "interrupted",
    ])
    expect(
      store
        .listRuns()
        .every(
          (run) =>
            run.closeReason === "interrupted" && run.error === "测试恢复",
        ),
    ).toBe(true)
    store.close()
  })

  it("只把调度来源计入重试预算，并为直接运行保留兼容默认值", async () => {
    const { store } = await storeFixture()
    store.createRun({
      id: "direct",
      challengeId: "rev-1",
      workspace: "a",
      attempt: 1,
    })
    store.updateRun("direct", { status: "closed", closeReason: "manual" })
    store.createRun({
      id: "test",
      challengeId: "rev-1",
      workspace: "b",
      attempt: 2,
      source: "test",
    })
    store.updateRun("test", { status: "closed", closeReason: "manual" })
    store.createRun({
      id: "manual",
      challengeId: "rev-1",
      workspace: "c",
      attempt: 3,
      source: "manual",
    })
    store.updateRun("manual", { status: "closed", closeReason: "manual" })
    store.createRun({
      id: "retry",
      challengeId: "rev-1",
      workspace: "d",
      attempt: 4,
      source: "retry",
    })

    expect(store.getRun("direct")?.source).toBe("direct")
    expect(store.schedulerAttemptCount("rev-1")).toBe(2)
    store.close()
  })

  it("平台瞬时故障的创建失败不消耗调度 attempt", async () => {
    const { store } = await storeFixture()
    store.createRun({
      id: "infra-failure",
      challengeId: "web-1",
      workspace: "workspace",
      attempt: 1,
      source: "auto",
    })
    store.updateRun(
      "infra-failure",
      { status: "failed", error: "HTTP 502" },
      "run_creation_failed",
      { error: "HTTP 502", retryable: true },
    )

    expect(store.schedulerAttemptCount("web-1")).toBe(0)
    expect(store.nextAttempt("web-1")).toBe(2)
    store.close()
  })

  it("持久化 Session 中断计数和 blocked，并支持人工重置", async () => {
    const { store } = await storeFixture()
    store.createRun({
      id: "interrupted",
      challengeId: "web-blocked",
      workspace: "a",
      attempt: 1,
      source: "auto",
    })
    store.updateRun("interrupted", {
      status: "interrupted",
      closeReason: "interrupted",
    })
    store.createRun({
      id: "blocked",
      challengeId: "web-blocked",
      workspace: "b",
      attempt: 2,
      source: "retry",
    })
    store.updateRun("blocked", {
      status: "blocked",
      closeReason: "blocked",
    })

    expect(store.sessionInterruptionCount("web-blocked")).toBe(2)
    expect(store.challengeRuntimeState("web-blocked")).toMatchObject({
      blockScore: 2,
      blocked: true,
      blockedRunId: "blocked",
    })
    expect(store.isChallengeBlocked("web-blocked")).toBe(true)
    expect(store.schedulerAttemptCount("web-blocked")).toBe(0)

    store.resetSessionInterruptions("web-blocked")
    expect(store.sessionInterruptionCount("web-blocked")).toBe(0)
    expect(store.challengeRuntimeState("web-blocked")).toMatchObject({
      blockScore: 0,
      blocked: false,
      blockedAt: null,
      blockedRunId: null,
    })
    expect(store.isChallengeBlocked("web-blocked")).toBe(false)
    expect(store.events("blocked").at(-1)?.type).toBe(
      "session_interruptions_reset",
    )
    store.close()
  })

  it("从数据库层拒绝同题创建两个 active Run", async () => {
    const { store } = await storeFixture()
    store.createRun({
      id: "active-1",
      challengeId: "same-challenge",
      workspace: "a",
      attempt: 1,
    })
    expect(() =>
      store.createRun({
        id: "active-2",
        challengeId: "same-challenge",
        workspace: "b",
        attempt: 2,
      }),
    ).toThrow()

    store.updateRun("active-1", {
      status: "interrupted",
      closeReason: "interrupted",
    })
    expect(
      store.createRun({
        id: "active-2",
        challengeId: "same-challenge",
        workspace: "b",
        attempt: 2,
      }).id,
    ).toBe("active-2")
    store.close()
  })

  it("以幂等 block event ledger 计分，并仅在 score 大于阈值时 blocked", async () => {
    const { store } = await storeFixture()
    store.createRun({
      id: "score-run",
      challengeId: "crypto-score",
      workspace: "workspace",
      attempt: 1,
    })

    for (let index = 1; index <= 4; index += 1) {
      store.recordChallengeBlockEvent({
        challengeId: "crypto-score",
        runId: "score-run",
        eventKey: `compact:${index}`,
        delta: 2,
        reason: "compact_boundary",
        compactPerformed: true,
      })
    }
    expect(store.challengeRuntimeState("crypto-score")).toMatchObject({
      blockScore: 8,
      effectiveBlockThreshold: 8,
      blocked: false,
    })

    const blocked = store.recordChallengeBlockEvent({
      challengeId: "crypto-score",
      runId: "score-run",
      eventKey: "stop:5",
      delta: 1,
      reason: "model_stop",
    })
    expect(blocked).toMatchObject({
      scoreBefore: 8,
      scoreAfter: 9,
      threshold: 8,
    })
    expect(store.challengeRuntimeState("crypto-score")).toMatchObject({
      blockScore: 9,
      blocked: true,
      blockedRunId: "score-run",
    })

    const replay = store.recordChallengeBlockEvent({
      challengeId: "crypto-score",
      runId: "score-run",
      eventKey: "stop:5",
      delta: 1,
      reason: "model_stop",
    })
    expect(replay).toEqual(blocked)
    expect(store.challengeBlockEvents("crypto-score")).toHaveLength(5)
    expect(store.challengeRuntimeState("crypto-score").blockScore).toBe(9)
    store.close()
  })

  it("打开旧 runtime state 时迁移 block score 且保留 blocked 事实", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctf-run-store-legacy-runtime-"))
    roots.push(root)
    const path = join(root, "runs.sqlite")
    const legacy = new DatabaseSync(path)
    legacy.exec(`
      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        challenge_id TEXT NOT NULL,
        workspace TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        status TEXT NOT NULL,
        close_reason TEXT,
        error TEXT,
        cleanup_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      ) STRICT;
      INSERT INTO runs (
        id, challenge_id, workspace, attempt, status, close_reason,
        created_at, updated_at
      ) VALUES (
        'legacy-blocked', 'legacy-challenge', 'workspace', 1, 'blocked', 'blocked',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:01:00.000Z'
      );
      CREATE TABLE challenge_runtime_state (
        challenge_id TEXT PRIMARY KEY,
        session_interruptions INTEGER NOT NULL DEFAULT 0,
        blocked INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO challenge_runtime_state (
        challenge_id, session_interruptions, blocked, updated_at
      ) VALUES (
        'legacy-challenge', 2, 1, '2026-01-01T00:01:00.000Z'
      );
    `)
    legacy.close()

    const migrated = await RunStore.open(path)
    expect(migrated.getRun("legacy-blocked")?.source).toBe("direct")
    expect(migrated.challengeRuntimeState("legacy-challenge")).toEqual({
      challengeId: "legacy-challenge",
      blockScore: 9,
      baseBlockThreshold: 8,
      revivalCount: 0,
      effectiveBlockThreshold: 8,
      blocked: true,
      blockedAt: "2026-01-01T00:01:00.000Z",
      blockedRunId: "legacy-blocked",
      lifecycleGeneration: 0,
      sessionInterruptions: 2,
      updatedAt: "2026-01-01T00:01:00.000Z",
    })
    migrated.close()

    const reopened = await RunStore.open(path)
    expect(reopened.challengeRuntimeState("legacy-challenge").blockScore).toBe(
      9,
    )
    reopened.close()
  })

  it("打开旧数据库时自动补充 run source 字段", async () => {
    const { path, store } = await storeFixture()
    store.close()
    const legacy = new DatabaseSync(path)
    legacy.exec("ALTER TABLE runs DROP COLUMN source")
    legacy.exec(`
      INSERT INTO runs (
        id, challenge_id, workspace, attempt, status, created_at, updated_at
      ) VALUES (
        'legacy', 'misc-1', 'workspace', 1, 'closed',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      )
    `)
    legacy.close()

    const migrated = await RunStore.open(path)
    expect(migrated.getRun("legacy")).toMatchObject({
      id: "legacy",
      source: "direct",
    })
    migrated.close()
  })
})
