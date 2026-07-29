import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { RunStore } from "../../src/project/run-store.js"

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
})
