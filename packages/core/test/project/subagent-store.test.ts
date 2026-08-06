import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { SubagentRecord } from "../../src/collaboration/subagent-manager.ts"
import { RunStore } from "../../src/persistence/run-store.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

async function storeFixture(): Promise<RunStore> {
  const root = await mkdtemp(join(tmpdir(), "ctf-subagent-store-"))
  roots.push(root)
  return await RunStore.open(join(root, "runs.sqlite"))
}

function record(overrides: Partial<SubagentRecord> = {}): SubagentRecord {
  return {
    id: "worker-1",
    runId: "run-1",
    role: "pwn",
    displayName: "Pwn",
    description: "locate primitive",
    status: "running",
    background: true,
    prompt: "Find a stable leak",
    sessionPath: "F:/project/runs/run-1/subagents/worker-1/session.jsonl",
    containerCwd: "/workspace/subagents/worker-1",
    activeTool: "bash",
    turns: 2,
    toolUses: 3,
    totalTokens: 4096,
    inputTokens: 1_024,
    cacheReadTokens: 3_072,
    cacheWriteTokens: 128,
    createdAt: "2026-08-04T10:00:00.000Z",
    updatedAt: "2026-08-04T10:01:00.000Z",
    startedAt: "2026-08-04T10:00:01.000Z",
    ...overrides,
  }
}

describe("RunStore SubAgent persistence", () => {
  it("以同一稳定 ID 更新完整 worker 生命周期快照", async () => {
    const store = await storeFixture()
    store.createRun({
      id: "run-1",
      challengeId: "pwn-1",
      workspace: "workspace",
      attempt: 1,
    })
    store.upsertSubagent(record())
    store.upsertSubagent(
      record({
        status: "completed",
        result: "leak verified",
        activeTool: undefined,
        turns: 4,
        completedAt: "2026-08-04T10:02:00.000Z",
        updatedAt: "2026-08-04T10:02:00.000Z",
      }),
    )

    expect(store.subagents("run-1")).toEqual([
      expect.objectContaining({
        id: "worker-1",
        status: "completed",
        result: "leak verified",
        turns: 4,
        toolUses: 3,
        totalTokens: 4096,
        inputTokens: 1_024,
        cacheReadTokens: 3_072,
        cacheWriteTokens: 128,
      }),
    ])
    store.close()
  })

  it("启动恢复时只中断 queued/running worker", async () => {
    const store = await storeFixture()
    store.createRun({
      id: "run-1",
      challengeId: "rev-1",
      workspace: "workspace",
      attempt: 1,
    })
    store.upsertSubagent(record({ id: "running" }))
    store.upsertSubagent(record({ id: "queued", status: "queued" }))
    store.upsertSubagent(
      record({
        id: "done",
        status: "completed",
        completedAt: "2026-08-04T10:02:00.000Z",
      }),
    )

    expect(store.markInterruptedSubagents("service restarted")).toHaveLength(2)
    expect(store.subagents("run-1")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "running", status: "interrupted" }),
        expect.objectContaining({ id: "queued", status: "interrupted" }),
        expect.objectContaining({ id: "done", status: "completed" }),
      ]),
    )
    store.close()
  })
})
