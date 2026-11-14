import { createHash } from "node:crypto"
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core"
import { Type } from "typebox"
import {
  BLACKBOARD_DESCRIPTION_MAX_LENGTH,
  BLACKBOARD_SOURCE_MAX_ITEMS,
  type BlackboardSummary,
  type EvidenceRecord,
  type OpportunityRecord,
  type RunStore,
} from "../persistence/run-store.ts"

export const BLACKBOARD_TOOL_MAX_CHARACTERS = 64_000
export const BLACKBOARD_INJECTION_MAX_CHARACTERS = 16_000
const BATCH_EVIDENCE_REFERENCE = 1

function result(details: Record<string, unknown>): AgentToolResult<Record<string, unknown>> {
  return {
    content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
    details,
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Serialize the blackboard into natural language Markdown for Agent consumption.
 *
 * Current approach: structured serialization. Each evidence/opportunity is listed
 * with its ID reference, allowing the Agent to use exact IDs in follow-up calls.
 *
 * Future: if the graph grows to hundreds of entries, this function can be replaced
 * with an LLM-based summarizer without changing the data model or tool interface.
 */
export function serializeBlackboard(
  summary: BlackboardSummary,
  options: { maxCharacters?: number } = {},
): string {
  const lines: string[] = []

  if (summary.evidence.length > 0) {
    lines.push("## Recorded Evidence")
    for (const e of summary.evidence) {
      lines.push(`- [e${e.id}] ${JSON.stringify(e.description)}`)
    }
    lines.push("")
  }

  const openOpportunities = summary.opportunities.filter((o) => o.status === "open")
  const concludedOpportunities = summary.opportunities.filter((o) => o.status === "concluded")

  if (openOpportunities.length > 0) {
    lines.push("## Open Opportunities")
    for (const o of openOpportunities) {
      const sources = o.sourceEvidenceIds.map((id) => `e${id}`).join(", ")
      lines.push(`- [o${o.id}] from ${sources}: ${JSON.stringify(o.description)}`)
    }
    lines.push("")
  }

  if (concludedOpportunities.length > 0) {
    lines.push("## Concluded Opportunities")
    for (const o of concludedOpportunities) {
      const sources = o.sourceEvidenceIds.map((id) => `e${id}`).join(", ")
      const target = o.targetEvidenceId ? ` → e${o.targetEvidenceId}` : ""
      const resolution = o.resolution ?? "confirmed"
      lines.push(
        `- [o${o.id}] (${resolution}) from ${sources}${target}: ${JSON.stringify(o.description)}`,
      )
    }
    lines.push("")
  }

  const text = lines.join("\n")
  const maxCharacters = Math.max(
    0,
    Math.floor(options.maxCharacters ?? BLACKBOARD_TOOL_MAX_CHARACTERS),
  )
  if (text.length <= maxCharacters) return text

  const suffix = [
    "",
    "[Blackboard snapshot truncated. Call blackboard_read for the latest bounded snapshot.]",
  ].join("\n")
  if (suffix.length >= maxCharacters) return suffix.slice(0, maxCharacters)
  return text.slice(0, maxCharacters - suffix.length) + suffix
}

export interface BlackboardToolOptions {
  runStore: RunStore
  challengeId: string
  runId: string
}

type ReadKind = "evidence" | "opportunity"
type ReadView = "index" | "full"
type ReadRecord = EvidenceRecord | OpportunityRecord

interface ReadPage {
  schemaVersion: 2
  kind: ReadKind
  view: ReadView
  readAt: string
  entries: Record<string, unknown>[]
  missingIds: number[]
  omittedIds: number[]
  hasMore: boolean
  nextAfterId: number | null
}

const INDEX_BUDGET = 8 * 1024
const FULL_BUDGET = 64 * 1024

function pageResult(page: ReadPage): AgentToolResult<Record<string, unknown>> {
  return {
    content: [{ type: "text", text: JSON.stringify(page) }],
    details: {
      schemaVersion: page.schemaVersion,
      kind: page.kind,
      view: page.view,
      hasMore: page.hasMore,
      nextAfterId: page.nextAfterId,
      missingIds: page.missingIds,
      omittedIds: page.omittedIds,
    },
  }
}

function fits(result: AgentToolResult<Record<string, unknown>>, budget: number): boolean {
  return Buffer.byteLength(JSON.stringify(result), "utf8") <= budget
}

function safeInteger(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${field} must be a safe integer between ${min} and ${max}`)
  }
  return value
}

function projectRecord(
  kind: ReadKind,
  view: ReadView,
  record: ReadRecord,
): Record<string, unknown> {
  const opportunity = kind === "opportunity" ? (record as OpportunityRecord) : undefined
  const semantic = {
    version: 1,
    kind,
    id: record.id,
    description: record.description,
    status: opportunity?.status ?? "recorded",
    resolution: opportunity?.resolution ?? null,
    sourceEvidenceIds: [...(opportunity?.sourceEvidenceIds ?? [])].sort((a, b) => a - b),
    targetEvidenceId: opportunity?.targetEvidenceId ?? null,
  }
  const contentHash = `sha256:${createHash("sha256").update(JSON.stringify(semantic)).digest("hex")}`
  const common = {
    id: record.id,
    status: semantic.status,
    creatorRunId: record.runId,
    createdAt: record.createdAt,
    contentHash,
  }
  if (view === "full") {
    return {
      ...common,
      description: record.description,
      ...(opportunity
        ? {
            resolution: semantic.resolution,
            sourceEvidenceIds: semantic.sourceEvidenceIds,
            targetEvidenceId: semantic.targetEvidenceId,
            concludedAt: opportunity.concludedAt,
          }
        : {}),
    }
  }
  const points = Array.from(record.description)
  return {
    ...common,
    preview: points.slice(0, 160).join(""),
    previewComplete: points.length <= 160,
  }
}

function legacyResult(summary: BlackboardSummary): AgentToolResult<Record<string, unknown>> {
  const text = serializeBlackboard(summary, { maxCharacters: Number.MAX_SAFE_INTEGER })
  const make = (value: string, truncated: boolean): AgentToolResult<Record<string, unknown>> => ({
    content: [{ type: "text", text: value }],
    details: { schemaVersion: 1, truncated },
  })
  if (fits(make(text, false), FULL_BUDGET)) return make(text, false)
  const suffix = "\n[Blackboard snapshot truncated. Use schemaVersion 2 to read complete entries.]"
  const points = Array.from(text)
  let low = 0
  let high = points.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (fits(make(points.slice(0, middle).join("") + suffix, true), FULL_BUDGET)) low = middle
    else high = middle - 1
  }
  return make(points.slice(0, low).join("") + suffix, true)
}

/** A challenge-bound reader. Empty input retains the legacy Markdown view; explicit queries use v2. */
export function createBlackboardReadTool(options: {
  runStore: RunStore
  challengeId: string
}): AgentTool {
  return {
    name: "blackboard_read",
    label: "Read Blackboard",
    description:
      "Read this challenge's blackboard. Empty input returns the legacy snapshot. " +
      "Use schemaVersion=2 for a bounded evidence/opportunity index; use view=full and ids for complete entries. " +
      "Continue lists using nextAfterId, or omittedIds for an ID query.",
    parameters: Type.Object(
      {
        schemaVersion: Type.Optional(Type.Union([Type.Literal(1), Type.Literal(2)])),
        kind: Type.Optional(Type.Union([Type.Literal("evidence"), Type.Literal("opportunity")])),
        view: Type.Optional(Type.Union([Type.Literal("index"), Type.Literal("full")])),
        afterId: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 16 })),
        ids: Type.Optional(
          Type.Array(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), {
            minItems: 1,
            maxItems: 16,
          }),
        ),
      },
      { additionalProperties: false },
    ),
    executionMode: "sequential",
    async execute(_id, raw) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid query")
      const input = raw as Record<string, unknown>
      const allowed = new Set(["schemaVersion", "kind", "view", "afterId", "limit", "ids"])
      if (Object.keys(input).some((key) => !allowed.has(key)))
        throw new Error("Unknown query field")
      if (
        input.schemaVersion !== undefined &&
        input.schemaVersion !== 1 &&
        input.schemaVersion !== 2
      ) {
        throw new Error("Unsupported schemaVersion")
      }
      const hasQuery = ["kind", "view", "afterId", "limit", "ids"].some(
        (key) => input[key] !== undefined,
      )
      if (input.schemaVersion === 1 && hasQuery)
        throw new Error("Legacy mode does not accept query fields")
      if (input.schemaVersion !== 2 && !hasQuery) {
        return legacyResult(options.runStore.getBlackboardSummary(options.challengeId))
      }

      const kind = input.kind ?? "evidence"
      const view = input.view ?? "index"
      if (kind !== "evidence" && kind !== "opportunity") throw new Error("Invalid kind")
      if (view !== "index" && view !== "full") throw new Error("Invalid view")
      if (input.ids !== undefined && (input.afterId !== undefined || input.limit !== undefined)) {
        throw new Error("ids cannot be combined with afterId or limit")
      }
      let ids: number[] | undefined
      if (input.ids !== undefined) {
        if (!Array.isArray(input.ids) || input.ids.length < 1 || input.ids.length > 16) {
          throw new Error("ids must contain 1 to 16 entries")
        }
        ids = [...new Set(input.ids.map((id) => safeInteger(id, "id", 1, Number.MAX_SAFE_INTEGER)))]
      }
      const afterId = safeInteger(input.afterId ?? 0, "afterId", 0, Number.MAX_SAFE_INTEGER)
      const limit = safeInteger(input.limit ?? 8, "limit", 1, 16)
      const records = options.runStore.getBlackboardRecords(options.challengeId)
      const all: ReadRecord[] = kind === "evidence" ? records.evidence : records.opportunities
      const budget = view === "index" ? INDEX_BUDGET : FULL_BUDGET
      const base: Pick<ReadPage, "schemaVersion" | "kind" | "view" | "readAt"> = {
        schemaVersion: 2,
        kind,
        view,
        readAt: new Date().toISOString(),
      }
      const entries: Record<string, unknown>[] = []

      if (ids) {
        const byId = new Map(all.map((entry) => [entry.id, entry]))
        const missingIds = ids.filter((id) => !byId.has(id))
        const present = ids.flatMap((id) => {
          const entry = byId.get(id)
          return entry ? [entry] : []
        })
        for (const [index, record] of present.entries()) {
          const omittedIds = present.slice(index + 1).map((entry) => entry.id)
          const trial: ReadPage = {
            ...base,
            entries: [...entries, projectRecord(kind, view, record)],
            missingIds,
            omittedIds,
            hasMore: omittedIds.length > 0,
            nextAfterId: null,
          }
          if (!fits(pageResult(trial), budget)) break
          entries.push(trial.entries[trial.entries.length - 1]!)
        }
        const omittedIds = present.slice(entries.length).map((entry) => entry.id)
        if (entries.length === 0 && present.length > 0)
          throw new Error("blackboard entry exceeds response budget")
        return pageResult({
          ...base,
          entries,
          missingIds,
          omittedIds,
          hasMore: omittedIds.length > 0,
          nextAfterId: null,
        })
      }

      const eligible = all.filter((entry) => entry.id > afterId)
      for (const record of eligible.slice(0, limit)) {
        const trialEntries = [...entries, projectRecord(kind, view, record)]
        const hasMore = eligible.length > trialEntries.length
        const trial: ReadPage = {
          ...base,
          entries: trialEntries,
          missingIds: [],
          omittedIds: [],
          hasMore,
          nextAfterId: hasMore ? record.id : null,
        }
        if (!fits(pageResult(trial), budget)) break
        entries.push(trialEntries[trialEntries.length - 1]!)
      }
      if (entries.length === 0 && eligible.length > 0)
        throw new Error("blackboard entry exceeds response budget")
      const hasMore = eligible.length > entries.length
      return pageResult({
        ...base,
        entries,
        missingIds: [],
        omittedIds: [],
        hasMore,
        nextAfterId: hasMore ? (entries[entries.length - 1]?.id as number) : null,
      })
    },
  }
}

export function createBlackboardTools(options: BlackboardToolOptions): AgentTool[] {
  const { runStore, challengeId, runId } = options

  return [
    createBlackboardReadTool({ runStore, challengeId }),
    {
      name: "blackboard_record",
      label: "Record to Blackboard",
      description:
        "Record to the shared challenge blackboard. You can combine multiple operations. " +
        'Evidence must be one object such as {"evidence":{"description":"verified finding"}}; ' +
        "do not pass a string or an array as evidence. When the same call creates Evidence and " +
        "an Opportunity, use 1 in sourceEvidenceIds to reference the newly created Evidence.",
      parameters: Type.Object({
        evidence: Type.Optional(
          Type.Object({
            description: Type.String({
              minLength: 1,
              maxLength: BLACKBOARD_DESCRIPTION_MAX_LENGTH,
            }),
          }),
        ),
        opportunity: Type.Optional(
          Type.Object({
            description: Type.String({
              minLength: 1,
              maxLength: BLACKBOARD_DESCRIPTION_MAX_LENGTH,
            }),
            sourceEvidenceIds: Type.Array(Type.Integer({ minimum: 1 }), {
              minItems: 1,
              maxItems: BLACKBOARD_SOURCE_MAX_ITEMS,
            }),
          }),
        ),
        concludeOpportunity: Type.Optional(
          Type.Object({
            opportunityId: Type.Integer({ minimum: 1 }),
            resolution: Type.Optional(
              Type.Union([Type.Literal("confirmed"), Type.Literal("dead_end")]),
            ),
            resultDescription: Type.String({
              minLength: 1,
              maxLength: BLACKBOARD_DESCRIPTION_MAX_LENGTH,
            }),
          }),
        ),
      }),
      executionMode: "sequential",
      async execute(_id, params) {
        const input = params as {
          evidence?: { description: string }
          opportunity?: { description: string; sourceEvidenceIds: number[] }
          concludeOpportunity?: {
            opportunityId: number
            resolution?: "confirmed" | "dead_end"
            resultDescription: string
          }
        }

        if (!input.evidence && !input.opportunity && !input.concludeOpportunity) {
          throw new Error(
            "At least one of evidence, opportunity, or concludeOpportunity is required",
          )
        }

        const details: Record<string, unknown> = {}
        let createdEvidenceId: number | undefined

        if (input.evidence) {
          try {
            const record = runStore.recordEvidence(challengeId, runId, input.evidence.description)
            details.evidence = record
            createdEvidenceId = record.id
          } catch (err) {
            details.evidenceError = errorText(err)
          }
        }

        if (input.opportunity) {
          try {
            const sourceEvidenceIds = input.opportunity.sourceEvidenceIds.map((evidenceId) => {
              if (evidenceId === BATCH_EVIDENCE_REFERENCE && createdEvidenceId !== undefined) {
                return createdEvidenceId
              }
              return evidenceId
            })
            const record = runStore.recordOpportunity(
              challengeId,
              runId,
              input.opportunity.description,
              sourceEvidenceIds,
            )
            details.opportunity = record
          } catch (err) {
            details.opportunityError = errorText(err)
          }
        }

        if (input.concludeOpportunity) {
          try {
            const concluded = runStore.concludeOpportunity(
              challengeId,
              input.concludeOpportunity.opportunityId,
              input.concludeOpportunity.resultDescription,
              runId,
              input.concludeOpportunity.resolution ?? "confirmed",
            )
            details.concluded = concluded
          } catch (err) {
            details.concludeError = errorText(err)
          }
        }

        return result(details)
      },
    },
    {
      name: "blackboard_manage",
      label: "Manage Blackboard Entry",
      description:
        "Correct or delete one existing blackboard Evidence or Opportunity by ID. " +
        "Referenced Evidence must not be deleted until its Opportunities are updated or deleted.",
      parameters: Type.Object({
        action: Type.Union([
          Type.Literal("update_evidence"),
          Type.Literal("delete_evidence"),
          Type.Literal("update_opportunity"),
          Type.Literal("delete_opportunity"),
        ]),
        evidenceId: Type.Optional(Type.Integer({ minimum: 1 })),
        opportunityId: Type.Optional(Type.Integer({ minimum: 1 })),
        description: Type.Optional(
          Type.String({
            minLength: 1,
            maxLength: BLACKBOARD_DESCRIPTION_MAX_LENGTH,
          }),
        ),
        sourceEvidenceIds: Type.Optional(
          Type.Array(Type.Integer({ minimum: 1 }), {
            minItems: 1,
            maxItems: BLACKBOARD_SOURCE_MAX_ITEMS,
          }),
        ),
      }),
      executionMode: "sequential",
      async execute(_id, params) {
        const input = params as {
          action:
            | "update_evidence"
            | "delete_evidence"
            | "update_opportunity"
            | "delete_opportunity"
          evidenceId?: number
          opportunityId?: number
          description?: string
          sourceEvidenceIds?: number[]
        }
        try {
          switch (input.action) {
            case "update_evidence": {
              if (input.evidenceId === undefined || !input.description) {
                throw new Error("update_evidence requires evidenceId and description")
              }
              return result({
                action: input.action,
                record: runStore.updateEvidence(challengeId, input.evidenceId, input.description),
              })
            }
            case "delete_evidence": {
              if (input.evidenceId === undefined) {
                throw new Error("delete_evidence requires evidenceId")
              }
              return result({
                action: input.action,
                record: runStore.deleteEvidence(challengeId, input.evidenceId),
              })
            }
            case "update_opportunity": {
              if (input.opportunityId === undefined) {
                throw new Error("update_opportunity requires opportunityId")
              }
              return result({
                action: input.action,
                record: runStore.updateOpportunity(challengeId, input.opportunityId, {
                  ...(input.description === undefined ? {} : { description: input.description }),
                  ...(input.sourceEvidenceIds === undefined
                    ? {}
                    : { sourceEvidenceIds: input.sourceEvidenceIds }),
                }),
              })
            }
            case "delete_opportunity": {
              if (input.opportunityId === undefined) {
                throw new Error("delete_opportunity requires opportunityId")
              }
              return result({
                action: input.action,
                record: runStore.deleteOpportunity(challengeId, input.opportunityId),
              })
            }
          }
        } catch (error) {
          return result({ action: input.action, error: errorText(error) })
        }
      },
    },
  ]
}
