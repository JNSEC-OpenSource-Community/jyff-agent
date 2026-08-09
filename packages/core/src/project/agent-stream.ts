import type { AgentMessage } from "@earendil-works/pi-agent-core"

export interface AgentStreamTarget {
  runId: string
  subagentId?: string
}

interface AgentStreamEventBase extends AgentStreamTarget {
  seq: number
  createdAt: string
}

export type AgentStreamEvent = AgentStreamEventBase &
  (
    | { type: "agent_started" }
    | { type: "agent_finished" }
    | {
        type: "message_started"
        messageId: string
        message: AgentMessage
      }
    | {
        type: "text_delta"
        messageId: string
        contentIndex: number
        delta: string
      }
    | {
        type: "thinking_delta"
        messageId: string
        contentIndex: number
        delta: string
      }
    | {
        type: "message_updated"
        messageId: string
        message: AgentMessage
      }
    | {
        type: "message_completed"
        messageId: string
        message: AgentMessage
      }
    | {
        type: "tool_started"
        toolCallId: string
        toolName: string
        args: unknown
      }
    | {
        type: "tool_updated"
        toolCallId: string
        toolName: string
        partialResult: unknown
      }
    | {
        type: "tool_completed"
        toolCallId: string
        toolName: string
        result: unknown
        isError: boolean
      }
    | {
        type: "queue_updated"
        queued: number
      }
    | {
        type: "status_changed"
        status: "compacting" | "retrying" | "active" | "idle"
        detail?: string
      }
  )

export type AgentStreamListener = (event: AgentStreamEvent) => void

type WithoutAgentStreamEnvelope<T> = T extends AgentStreamEvent
  ? Omit<T, keyof AgentStreamEventBase>
  : never

export type AgentStreamPayload = WithoutAgentStreamEnvelope<AgentStreamEvent>
