import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it } from "vitest"
import { RunStore } from "../../src/run-store.js"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function storeFixture(): Promise<{ root: string; path: string; store: RunStore }> {
  const root = await mkdtemp(join(tmpdir(), "ctf-run-store-"))
  roots.push(root)
  const path = join(root, "runs.sqlite")
  return { root, path, store: await RunStore.open(path) }
}

describe("RunStore", () => {
  it("持久化 Run 状态、attempt 和事件，并可在重开后查询", async () => {
    const { path, store } = await storeFixture()
    store.createRun({ id: "run-1", challengeId: "web-1", workspace: "workspace", attempt: 1 })
    store.updateRun("run-1", { status: "running", startedAt: "2026-01-01T00:00:00.000Z" }, "run_started")
    store.updateRun("run-1", {
      status: "solved",
      closeReason: "submitted",
      finishedAt: "2026-01-01T00:01:00.000Z",
    }, "run_finished")

    expect(store.isSolved("web-1")).toBe(true)
    expect(store.nextAttempt("web-1")).toBe(2)
    expect(store.events("run-1").map((event) => event.type)).toEqual(["run_created", "run_started", "run_finished"])
    store.close()

    const reopened = await RunStore.open(path)
    expect(reopened.listRuns({ challengeId: "web-1" })).toEqual([
      expect.objectContaining({ id: "run-1", status: "solved", closeReason: "submitted", attempt: 1 }),
    ])
    reopened.close()
  })

  it("agent_thinking 事件可持久化与读取(data 原文保留)", async () => {
    const { path, store } = await storeFixture()
    store.createRun({ id: "run-1", challengeId: "web-1", workspace: "workspace", attempt: 1 })
    const thinking = { text: "先枚举 /robots.txt，再看响应头", ts: "chunk-1" }

    const appended = store.appendEvent("run-1", "agent_thinking", thinking)
    expect(appended).toMatchObject({ runId: "run-1", type: "agent_thinking", data: thinking })
    expect(appended.createdAt).toBeTruthy()

    const persisted = store.events("run-1").find((event) => event.type === "agent_thinking")
    expect(persisted).toEqual(expect.objectContaining({
      runId: "run-1",
      type: "agent_thinking",
      data: thinking,
    }))
    store.close()

    const reopened = await RunStore.open(path)
    const afterReopen = reopened.events("run-1").find((event) => event.type === "agent_thinking")
    expect(afterReopen).toEqual(expect.objectContaining({
      type: "agent_thinking",
      data: thinking,
    }))
    reopened.close()
  })

  it("agent_usage 事件可持久化与读取(data 原文保留,含 cost 与 reasoning)", async () => {
    const { path, store } = await storeFixture()
    store.createRun({ id: "run-1", challengeId: "web-1", workspace: "workspace", attempt: 1 })
    const usage = {
      input: 1200,
      output: 340,
      cacheRead: 800,
      cacheWrite: 0,
      reasoning: 200,
      totalTokens: 1540,
      cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0, total: 0.031 },
      ts: "2026-08-02T12:00:00.000Z",
    }

    const appended = store.appendEvent("run-1", "agent_usage", usage)
    expect(appended).toMatchObject({ runId: "run-1", type: "agent_usage", data: usage })
    expect(appended.createdAt).toBeTruthy()

    const persisted = store.events("run-1").find((event) => event.type === "agent_usage")
    expect(persisted).toEqual(expect.objectContaining({
      runId: "run-1",
      type: "agent_usage",
      data: usage,
    }))
    store.close()

    const reopened = await RunStore.open(path)
    const afterReopen = reopened.events("run-1").find((event) => event.type === "agent_usage")
    expect(afterReopen).toEqual(expect.objectContaining({
      type: "agent_usage",
      data: usage,
    }))
    reopened.close()
  })

  it("启动恢复时把遗留 preparing/running Run 标记为 interrupted", async () => {
    const { store } = await storeFixture()
    store.createRun({ id: "preparing", challengeId: "pwn-1", workspace: "a", attempt: 1 })
    store.createRun({ id: "running", challengeId: "pwn-2", workspace: "b", attempt: 1 })
    store.updateRun("running", { status: "running" })

    const interrupted = store.markInterruptedRuns("测试恢复")
    expect(interrupted).toHaveLength(2)
    expect(store.listRuns().map((run) => run.status)).toEqual(["interrupted", "interrupted"])
    expect(store.listRuns().every((run) => run.closeReason === "interrupted" && run.error === "测试恢复")).toBe(true)
    store.close()
  })

  it("只把调度来源计入重试预算，并为直接运行保留兼容默认值", async () => {
    const { store } = await storeFixture()
    store.createRun({ id: "direct", challengeId: "rev-1", workspace: "a", attempt: 1 })
    store.createRun({
      id: "test",
      challengeId: "rev-1",
      workspace: "b",
      attempt: 2,
      source: "test",
    })
    store.createRun({
      id: "manual",
      challengeId: "rev-1",
      workspace: "c",
      attempt: 3,
      source: "manual",
    })
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
