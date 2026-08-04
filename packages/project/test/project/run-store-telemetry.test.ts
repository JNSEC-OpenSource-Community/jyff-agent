import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { RunStore } from "../../src/run-store.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("RunStore dashboard telemetry", () => {
  it("持久化工具进度事件并汇总每题黑板统计", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctf-telemetry-"))
    roots.push(root)
    const store = await RunStore.open(join(root, "runs.sqlite"))
    store.createRun({
      id: "run-1",
      challengeId: "challenge-1",
      workspace: "/workspace",
      attempt: 1,
    })

    try {
      const event = store.appendEvent("run-1", "tool_started", {
        toolName: "bash",
        args: { command: "[omitted]" },
      })
      const origin = store.ensureOrigin("challenge-1", "run-1", {
        title: "Challenge",
        category: "pwn",
        score: 500,
        description: "Test",
        attachments: [],
      })
      const opportunity = store.recordOpportunity(
        "challenge-1",
        "run-1",
        "Try a ROP chain",
        [origin.id],
      )
      store.concludeOpportunity(
        "challenge-1",
        opportunity.id,
        "ROP chain confirmed",
        "run-1",
      )

      expect(event).toMatchObject({ runId: "run-1", type: "tool_started" })
      expect(store.events("run-1").at(-1)?.data).toEqual({
        toolName: "bash",
        args: { command: "[omitted]" },
      })
      expect(store.getBlackboardStats()).toEqual([{
        challengeId: "challenge-1",
        evidence: 2,
        openOpportunities: 0,
        concludedOpportunities: 1,
      }])
    } finally {
      store.close()
    }
  })
})
