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

/**
 * 将一个文本增量折叠进 Assistant 消息。
 *
 * 服务端用它维护可重放的 in-flight 快照，前端用它消费实时事件；两端采用
 * 同一规则，避免切页重连时依赖上游 event.message 的更新时机。
 */
export function appendAgentMessageDelta(
  message: AgentMessage,
  contentIndex: number,
  type: "text" | "thinking",
  delta: string,
): AgentMessage {
  if (message.role !== "assistant") return message
  const content = [...message.content]
  const current = content[contentIndex]
  if (type === "text") {
    content[contentIndex] = {
      type: "text",
      text: current?.type === "text" ? `${current.text}${delta}` : delta,
    }
  } else {
    content[contentIndex] = {
      type: "thinking",
      thinking: current?.type === "thinking" ? `${current.thinking}${delta}` : delta,
      redacted: false,
    }
  }
  return { ...message, content }
}
