import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { JsonlSessionStorage, Session } from "@earendil-works/pi-agent-core"
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node"
import { fauxAssistantMessage, fauxText, fauxThinking } from "@earendil-works/pi-ai/providers/faux"
import { afterEach, describe, expect, it } from "vite-plus/test"
import type { SubagentRecord } from "../../src/collaboration/subagent-manager.ts"
import {
  collectExecutionReport,
  EXECUTION_MARKER,
  reportPage,
  shortSubagentPage,
} from "../../src/collaboration/subagent-report.ts"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function record(index: number): SubagentRecord {
  return {
    id: `worker-${String(index).padStart(3, "0")}`,
    runId: "run-1",
    executionId: `execution-${index}`,
    role: "analyst",
    displayName: "Analyst",
    description: "review",
    status: "completed",
    background: true,
    prompt: "inspect",
    sessionPath: "/tmp/session.jsonl",
    containerCwd: "/workspace",
    resultKind: "assistant_final",
    result: `${"\u0001".repeat(1_200)}${index}`,
    turns: 1,
    toolUses: 0,
    totalTokens: 1,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:01.000Z",
  }
}

describe("subagent report boundaries and projections", () => {
  it("walks original Pi entries across compaction without leaking old messages or thinking", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctf-report-session-"))
    roots.push(root)
    const env = new NodeExecutionEnv({ cwd: root })
    const storage = await JsonlSessionStorage.create(env, join(root, "session.jsonl"), {
      cwd: root,
      sessionId: "worker",
    })
    const session = new Session(storage)
    const oldId = await session.appendMessage(fauxAssistantMessage("OLD EXECUTION"))
    await session.appendCustomEntry(EXECUTION_MARKER, { executionId: "current" })
    await session.appendMessage(
      fauxAssistantMessage([
        fauxThinking("PRIVATE THINKING"),
        fauxText("first block"),
        fauxText("second block"),
      ]),
    )
    await session.appendMessage({
      role: "toolResult",
      toolCallId: "tool",
      toolName: "bash",
      content: [{ type: "text", text: "latest tool evidence" }],
      isError: false,
      timestamp: Date.now(),
    })
    await session.appendCompaction(
      "OLD EXECUTION PRIVATE THINKING",
      undefined,
      1,
      undefined,
      undefined,
      undefined,
      [fauxAssistantMessage("retained copy")],
    )
    expect(await collectExecutionReport(session, "current", true)).toEqual({
      result: "first block\nsecond block",
      resultKind: "assistant_final",
    })
    expect(await collectExecutionReport(session, "current", false)).toEqual({
      result: "[bash] latest tool evidence",
      resultKind: "tool_partial",
    })
    await session.moveTo(oldId)
    await expect(collectExecutionReport(session, "current", false)).rejects.toThrow(
      "result_boundary_unavailable",
    )
  })

  it("enumerates bounded list pages with a run-bound cursor", () => {
    const records = Array.from({ length: 70 }, (_, index) => record(index))
    const seen: string[] = []
    let cursor: string | undefined
    do {
      const page = shortSubagentPage("run-1", records, { cursor, limit: 32 })
      const text = JSON.stringify(page)
      const envelope = {
        content: [{ type: "text", text }],
        details: { omittedCount: page.omittedCount, nextCursor: page.nextCursor },
      }
      expect(Buffer.byteLength(JSON.stringify(envelope))).toBeLessThanOrEqual(16 * 1024)
      expect(page.agents.length).toBeGreaterThan(0)
      for (const agent of page.agents) {
        expect(Array.from(agent.result ?? "")).toHaveLength(1_200)
        expect(agent.hasMore).toBe(true)
      }
      seen.push(...page.agents.map((agent) => agent.id))
      cursor = page.nextCursor ?? undefined
    } while (cursor)
    expect(seen).toEqual(records.map((entry) => entry.id))
    const first = shortSubagentPage("run-1", records)
    expect(() => shortSubagentPage("other-run", records, { cursor: first.nextCursor! })).toThrow(
      "invalid_cursor",
    )
  })

  it("uses stable versions and validates offsets and execution changes", () => {
    const original = { ...record(1), result: "a😀b" }
    const first = reportPage(original, { limit: 2 })
    expect(first).toMatchObject({ result: "a😀", totalLength: 3, nextOffset: 2, hasMore: true })
    const version = first.resultVersion as string
    expect(reportPage(original, { offset: 2, expectedResultVersion: version })).toMatchObject({
      result: "b",
      nextOffset: null,
    })
    expect(reportPage(original, { offset: 3, expectedResultVersion: version })).toMatchObject({
      result: "",
      nextOffset: null,
    })
    expect(() => reportPage(original, { offset: 4, expectedResultVersion: version })).toThrow(
      "invalid_offset",
    )
    expect(() => reportPage(original, { offset: 1 })).toThrow("expected_result_version_required")
    expect(
      reportPage(
        {
          ...original,
          executionId: "new",
          result: undefined,
          resultKind: undefined,
          status: "running",
        },
        { offset: 2, expectedResultVersion: version },
      ),
    ).toMatchObject({ code: "result_changed" })
    expect(
      reportPage({ ...original, executionId: "new" }, { expectedResultVersion: version }),
    ).toMatchObject({ code: "result_changed" })
  })
})
