import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentToolResult } from "@earendil-works/pi-agent-core"
import { afterEach, describe, expect, it } from "vite-plus/test"
import { createBlackboardReadTool } from "../../src/collaboration/blackboard.ts"
import { RunStore } from "../../src/persistence/run-store.ts"

const roots: string[] = []
const stores: RunStore[] = []

afterEach(async () => {
  for (const store of stores.splice(0)) store.close()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ctf-reader-"))
  roots.push(root)
  const store = await RunStore.open(join(root, "runs.sqlite"))
  stores.push(store)
  for (const [id, challengeId] of [
    ["run-old", "one"],
    ["run-current", "one"],
    ["run-other", "two"],
  ] as const) {
    store.createRun({
      id,
      challengeId,
      workspace: join(root, id),
      attempt: id === "run-current" ? 2 : 1,
    })
    if (id === "run-old") store.updateRun(id, { status: "failed" })
  }
  return { store, reader: createBlackboardReadTool({ runStore: store, challengeId: "one" }) }
}

interface Page {
  schemaVersion: number
  entries: Array<{
    id: number
    description?: string
    preview?: string
    previewComplete?: boolean
    creatorRunId: string
    contentHash: string
  }>
  missingIds: number[]
  omittedIds: number[]
  hasMore: boolean
  nextAfterId: number | null
}

function page(result: AgentToolResult<Record<string, unknown>>): Page {
  const block = result.content[0]
  if (!block || block.type !== "text") throw new Error("reader did not return text")
  return JSON.parse(block.text) as Page
}

describe("challenge-scoped blackboard reader", () => {
  it("preserves the legacy view and offers explicit bounded pages without duplicating entries", async () => {
    const { store, reader } = await fixture()
    const original = store.recordEvidence("one", "run-old", "known fact")
    const other = store.recordEvidence("two", "run-other", "other challenge secret")

    const legacy = await reader.execute("legacy", {})
    expect(legacy.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("known fact"),
    })
    expect(JSON.stringify(legacy.details)).not.toContain("known fact")

    const first = await reader.execute("index", { schemaVersion: 2 })
    const index = page(first)
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(8 * 1024)
    expect(index).toMatchObject({ schemaVersion: 2, hasMore: false, nextAfterId: null })
    expect(index.entries).toEqual([
      expect.objectContaining({ id: original.id, preview: "known fact", creatorRunId: "run-old" }),
    ])
    expect(JSON.stringify(first.details)).not.toContain("known fact")

    const full = page(await reader.execute("full", { view: "full", ids: [original.id, other.id] }))
    expect(full.entries).toEqual([
      expect.objectContaining({
        id: original.id,
        description: "known fact",
        creatorRunId: "run-old",
      }),
    ])
    expect(full.missingIds).toEqual([other.id])
    expect(JSON.stringify(full)).not.toContain("other challenge secret")

    const hash = full.entries[0]?.contentHash
    store.updateEvidence("one", original.id, "corrected fact")
    const updated = page(await reader.execute("changed", { view: "full", ids: [original.id] }))
    expect(updated.entries[0]?.contentHash).not.toBe(hash)
    expect(updated.entries[0]?.creatorRunId).toBe("run-old")
    store.deleteEvidence("one", original.id)
    expect(page(await reader.execute("missing", { ids: [original.id] })).missingIds).toEqual([
      original.id,
    ])
  })

  it("enumerates 256 records of each kind without gaps and returns the largest legal escaped record", async () => {
    const { store, reader } = await fixture()
    const evidence = Array.from({ length: 256 }, (_, index) =>
      store.recordEvidence(
        "one",
        "run-current",
        index === 0 ? "\u0001".repeat(4_000) : `evidence ${index}`,
      ),
    )
    const opportunities = Array.from({ length: 256 }, (_, index) =>
      store.recordOpportunity("one", "run-current", `opportunity ${index}`, [evidence[0]!.id]),
    )
    for (const [kind, records] of [
      ["evidence", evidence],
      ["opportunity", opportunities],
    ] as const) {
      let afterId = 0
      const seen: number[] = []
      for (let attempts = 0; attempts < 256; attempts++) {
        const result = await reader.execute("page", { kind, view: "index", afterId, limit: 16 })
        const data = page(result)
        expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(8 * 1024)
        seen.push(...data.entries.map((entry) => entry.id))
        if (!data.hasMore) {
          expect(data.nextAfterId).toBeNull()
          break
        }
        expect(data.nextAfterId).not.toBeNull()
        expect(data.nextAfterId!).toBeGreaterThan(afterId)
        afterId = data.nextAfterId!
      }
      expect(seen).toEqual(records.map((record) => record.id))
    }
    const full = await reader.execute("max", { view: "full", ids: [evidence[0]!.id] })
    expect(Buffer.byteLength(JSON.stringify(full))).toBeLessThanOrEqual(64 * 1024)
    expect(page(full).entries[0]?.description).toBe("\u0001".repeat(4_000))
  }, 30_000)

  it("rejects unsafe pagination and mixed ID/cursor queries", async () => {
    const { reader } = await fixture()
    await expect(reader.execute("invalid", { ids: [1], afterId: 0 })).rejects.toThrow()
    await expect(
      reader.execute("invalid", { ids: [Number.MAX_SAFE_INTEGER + 1] }),
    ).rejects.toThrow()
    await expect(reader.execute("invalid", { limit: 17 })).rejects.toThrow()
    await expect(reader.execute("invalid", { schemaVersion: 1, view: "full" })).rejects.toThrow()
    await expect(reader.execute("invalid", { schemaVersion: 3 })).rejects.toThrow()
  })

  it("returns exact Unicode previews, paginates large ID requests, and bounds legacy output", async () => {
    const { store, reader } = await fixture()
    const records = Array.from({ length: 16 }, (_, index) =>
      store.recordEvidence(
        "one",
        "run-current",
        index === 0 ? "😀".repeat(161) : "\u0001".repeat(4_000),
      ),
    )
    const preview = page(await reader.execute("preview", { ids: [records[0]!.id] })).entries[0]!
    expect(preview.preview).toBe("😀".repeat(160))
    expect(preview.previewComplete).toBe(false)

    let remaining = records.map((record) => record.id)
    const seen: number[] = []
    while (remaining.length > 0) {
      const response = await reader.execute("full-ids", { view: "full", ids: remaining })
      expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(64 * 1024)
      const data = page(response)
      expect(data.entries.length).toBeGreaterThan(0)
      seen.push(...data.entries.map((entry) => entry.id))
      remaining = data.omittedIds
    }
    expect(seen).toEqual(records.map((record) => record.id))
    const legacy = await reader.execute("legacy", { schemaVersion: 1 })
    expect(Buffer.byteLength(JSON.stringify(legacy))).toBeLessThanOrEqual(64 * 1024)
    expect(legacy.details).toEqual({ schemaVersion: 1, truncated: true })
    expect(JSON.stringify(legacy.content)).toContain("schemaVersion 2")
  }, 30_000)
})
