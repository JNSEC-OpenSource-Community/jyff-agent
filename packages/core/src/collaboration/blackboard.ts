import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core"
import { Type } from "typebox"
import { BLACKBOARD_RECORD_REMINDER_PROMPT } from "../../prompts/index.ts"
import {
  BLACKBOARD_DESCRIPTION_MAX_LENGTH,
  BLACKBOARD_SOURCE_MAX_ITEMS,
  type BlackboardSummary,
  type RunStore,
} from "../persistence/run-store.ts"

export const BLACKBOARD_TOOL_MAX_CHARACTERS = 64_000
export const BLACKBOARD_INJECTION_MAX_CHARACTERS = 16_000

function result(
  details: Record<string, unknown>,
): AgentToolResult<Record<string, unknown>> {
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
    lines.push("## Confirmed Evidence")
    for (const e of summary.evidence) {
      lines.push(`- [e${e.id}] ${JSON.stringify(e.description)}`)
    }
    lines.push("")
  }

  const openOpportunities = summary.opportunities.filter(
    (o) => o.status === "open",
  )
  const concludedOpportunities = summary.opportunities.filter(
    (o) => o.status === "concluded",
  )

  if (openOpportunities.length > 0) {
    lines.push("## Open Opportunities")
    for (const o of openOpportunities) {
      const sources = o.sourceEvidenceIds.map((id) => `e${id}`).join(", ")
      lines.push(
        `- [o${o.id}] from ${sources}: ${JSON.stringify(o.description)}`,
      )
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

  lines.push(BLACKBOARD_RECORD_REMINDER_PROMPT)
  const text = lines.join("\n")
  const maxCharacters = Math.max(
    0,
    Math.floor(options.maxCharacters ?? BLACKBOARD_TOOL_MAX_CHARACTERS),
  )
  if (text.length <= maxCharacters) return text

  const suffix = [
    "",
    "[Blackboard snapshot truncated. Call ctf_blackboard_read for the latest bounded snapshot.]",
  ].join("\n")
  if (suffix.length >= maxCharacters) return suffix.slice(0, maxCharacters)
  return text.slice(0, maxCharacters - suffix.length) + suffix
}

export interface BlackboardToolOptions {
  runStore: RunStore
  challengeId: string
  runId: string
}

export function createBlackboardTools(
  options: BlackboardToolOptions,
): AgentTool[] {
  const { runStore, challengeId, runId } = options

  return [
    {
      name: "ctf_blackboard_read",
      label: "Read Blackboard",
      description:
        "Read the current state of the shared challenge blackboard, including all confirmed evidence and open/concluded opportunities.",
      parameters: Type.Object({}),
      executionMode: "sequential",
      async execute() {
        const summary = runStore.getBlackboardSummary(challengeId)
        const text = serializeBlackboard(summary)
        return {
          content: [{ type: "text", text }],
          details: summary as unknown as Record<string, unknown>,
        }
      },
    },
    {
      name: "ctf_blackboard_record",
      label: "Record to Blackboard",
      description:
        "Record to the shared challenge blackboard. You can record evidence (confirmed findings), " +
        "declare opportunities (experimental directions from existing evidence), conclude opportunities " +
        "as confirmed or dead_end while atomically recording result Evidence, or combine these operations. " +
        'Evidence must be one object such as {"evidence":{"description":"verified finding"}}; ' +
        "do not pass a string or an array as evidence.",
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

        if (
          !input.evidence &&
          !input.opportunity &&
          !input.concludeOpportunity
        ) {
          throw new Error(
            "At least one of evidence, opportunity, or concludeOpportunity is required",
          )
        }

        const details: Record<string, unknown> = {}

        if (input.evidence) {
          try {
            const record = runStore.recordEvidence(
              challengeId,
              runId,
              input.evidence.description,
            )
            details.evidence = record
          } catch (err) {
            details.evidenceError = errorText(err)
          }
        }

        if (input.opportunity) {
          try {
            const record = runStore.recordOpportunity(
              challengeId,
              runId,
              input.opportunity.description,
              input.opportunity.sourceEvidenceIds,
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
  ]
}
