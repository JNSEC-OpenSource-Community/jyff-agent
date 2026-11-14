import { createHash } from "node:crypto"
import type { Session } from "@earendil-works/pi-agent-core"
import type { SubagentRecord, SubagentResultKind } from "./subagent-manager.ts"

export const REPORT_PAGE_LIMIT = 8_000
export const REPORT_ENVELOPE_BUDGET = 96 * 1024
export const REPORT_COLLECTION_BUDGET = 16 * 1024
export const REPORT_PREVIEW_LIMIT = 1_200
export const EXECUTION_MARKER = "ctf_subagent_execution"

interface ExecutionReport {
  result: string
  resultKind: Exclude<SubagentResultKind, "legacy">
}

/** Read only original messages on the current parent chain, never compaction copies or thinking. */
export async function collectExecutionReport(
  session: Session,
  executionId: string,
  final: boolean,
): Promise<ExecutionReport | undefined> {
  let id = await session.getLeafId()
  const visited = new Set<string>()
  let report: ExecutionReport | undefined
  while (id) {
    if (visited.has(id)) throw new Error("result_boundary_unavailable")
    visited.add(id)
    const entry = await session.getEntry(id)
    if (!entry) throw new Error("result_boundary_unavailable")
    if (entry.type === "custom" && entry.customType === EXECUTION_MARKER) {
      const data = entry.data as { executionId?: unknown } | undefined
      if (data?.executionId !== executionId) throw new Error("result_boundary_unavailable")
      return report
    }
    if (!report && entry.type === "message") {
      const message = entry.message
      if (message.role === "assistant") {
        const result = textBlocks(message.content)
        if (result.trim()) {
          report = { result, resultKind: final ? "assistant_final" : "assistant_partial" }
        }
      } else if (!final && message.role === "toolResult") {
        const result = textBlocks(message.content)
        if (result.trim() && result.trim() !== "(no output)") {
          report = { result: `[${message.toolName}] ${result}`, resultKind: "tool_partial" }
        }
      }
    }
    id = entry.parentId
  }
  throw new Error("result_boundary_unavailable")
}

function textBlocks(content: unknown): string {
  if (!Array.isArray(content)) return ""
  return content
    .flatMap((block: unknown) => {
      if (!block || typeof block !== "object") return []
      const value = block as { type?: unknown; text?: unknown }
      return value.type === "text" && typeof value.text === "string" ? [value.text] : []
    })
    .join("\n")
}

export function resultVersion(record: SubagentRecord): string {
  const domain = {
    schemaVersion: 1,
    runId: record.runId,
    subagentId: record.id,
    executionId: record.executionId ?? "legacy",
    resultKind: record.resultKind ?? (record.executionId ? null : "legacy"),
    result: record.result ?? null,
  }
  return `v1:${createHash("sha256").update(JSON.stringify(domain)).digest("hex")}`
}

export function limitCodePoints(value: string, limit: number): string {
  return Array.from(value).slice(0, limit).join("")
}

export interface ReportQuery {
  offset?: number
  limit?: number
  expectedResultVersion?: string
}

export function reportPage(
  record: SubagentRecord,
  query: ReportQuery = {},
): Record<string, unknown> {
  const offset = query.offset ?? 0
  const limit = query.limit ?? REPORT_PAGE_LIMIT
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("invalid_offset")
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > REPORT_PAGE_LIMIT) {
    throw new Error("invalid_limit")
  }
  if (offset > 0 && !query.expectedResultVersion)
    throw new Error("expected_result_version_required")

  const resultKind = record.resultKind ?? (record.executionId ? undefined : "legacy")
  const version = resultVersion(record)
  const metadata = {
    id: limitCodePoints(record.id, 128),
    runId: limitCodePoints(record.runId, 128),
    role: limitCodePoints(record.role, 120),
    description: limitCodePoints(record.description, 240),
    status: record.status,
    background: record.background,
    ...(record.executionId ? { executionId: limitCodePoints(record.executionId, 128) } : {}),
    ...(record.error ? { error: limitCodePoints(record.error, 1_000) } : {}),
    ...(resultKind ? { resultKind } : {}),
    resultVersion: version,
  }
  if (query.expectedResultVersion && query.expectedResultVersion !== version) {
    return { ...metadata, code: "result_changed" }
  }
  if (record.result === undefined) {
    return {
      ...metadata,
      code:
        record.status === "running" || record.status === "queued"
          ? "result_pending"
          : "result_unavailable",
    }
  }
  const points = Array.from(record.result)
  if (offset > points.length) throw new Error("invalid_offset")
  const end = Math.min(offset + limit, points.length)
  return {
    ...metadata,
    result: points.slice(offset, end).join(""),
    totalLength: points.length,
    nextOffset: end < points.length ? end : null,
    hasMore: end < points.length,
  }
}

export interface SubagentListPage {
  agents: Array<
    SubagentRecord & { resultVersion?: string; totalLength?: number; hasMore?: boolean }
  >
  omittedCount: number
  nextCursor: string | null
}

function cursorFor(runId: string, record: SubagentRecord): string {
  return Buffer.from(JSON.stringify([runId, record.createdAt, record.id])).toString("base64url")
}

function cursorParts(runId: string, cursor: string): [string, string] {
  try {
    if (cursor.length > 2_048 || !/^[A-Za-z0-9_-]+$/u.test(cursor)) throw new Error()
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"))
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 3 ||
      parsed[0] !== runId ||
      typeof parsed[1] !== "string" ||
      typeof parsed[2] !== "string"
    )
      throw new Error()
    return [parsed[1], parsed[2]]
  } catch {
    throw new Error("invalid_cursor")
  }
}

/** Bounded projection for lists and recovery prompts; the complete report remains in RunStore. */
export function shortSubagentPage(
  runId: string,
  records: readonly SubagentRecord[],
  options: { cursor?: string; limit?: number; budget?: number } = {},
): SubagentListPage {
  const limit = options.limit ?? 16
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32) throw new Error("invalid_limit")
  const budget = options.budget ?? REPORT_COLLECTION_BUDGET
  if (!Number.isSafeInteger(budget) || budget < 8 * 1024 || budget > REPORT_COLLECTION_BUDGET) {
    throw new Error("invalid_budget")
  }
  const cursor = options.cursor ? cursorParts(runId, options.cursor) : undefined
  const sorted = records
    .filter((record) => record.runId === runId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
  const remaining = cursor
    ? sorted.filter(
        (record) =>
          record.createdAt.localeCompare(cursor[0]) > 0 ||
          (record.createdAt === cursor[0] && record.id.localeCompare(cursor[1]) > 0),
      )
    : sorted
  const agents: SubagentListPage["agents"] = []
  for (const record of remaining.slice(0, limit)) {
    const points = record.result === undefined ? undefined : Array.from(record.result)
    const projected = {
      ...record,
      role: limitCodePoints(record.role, 120),
      displayName: limitCodePoints(record.displayName, 120),
      description: limitCodePoints(record.description, 240),
      prompt: limitCodePoints(record.prompt, 240),
      sessionPath: limitCodePoints(record.sessionPath, 512),
      containerCwd: limitCodePoints(record.containerCwd, 512),
      ...(record.error ? { error: limitCodePoints(record.error, 1_000) } : {}),
      ...(record.activeTool ? { activeTool: limitCodePoints(record.activeTool, 120) } : {}),
      ...(points
        ? {
            result: points.slice(0, REPORT_PREVIEW_LIMIT).join(""),
            resultKind: record.resultKind ?? (record.executionId ? undefined : ("legacy" as const)),
            resultVersion: resultVersion(record),
            totalLength: points.length,
            hasMore: points.length > REPORT_PREVIEW_LIMIT,
          }
        : {}),
    }
    const trial = [...agents, projected]
    const page: SubagentListPage = {
      agents: trial,
      omittedCount: remaining.length - trial.length,
      nextCursor: remaining.length > trial.length ? cursorFor(runId, record) : null,
    }
    const text = JSON.stringify(page)
    const escapedPrompt = text
      .replaceAll("&", "\\u0026")
      .replaceAll("<", "\\u003c")
      .replaceAll(">", "\\u003e")
    const envelope = JSON.stringify({
      content: [{ type: "text", text }],
      details: { omittedCount: page.omittedCount, nextCursor: page.nextCursor },
    })
    if (Buffer.byteLength(envelope) > budget || Buffer.byteLength(escapedPrompt) > budget - 80)
      break
    agents.push(projected)
  }
  if (agents.length === 0 && remaining.length > 0) throw new Error("subagent_list_entry_too_large")
  const last = remaining[agents.length - 1]
  return {
    agents,
    omittedCount: remaining.length - agents.length,
    nextCursor: remaining.length > agents.length && last ? cursorFor(runId, last) : null,
  }
}
