import { type AgentStreamEvent, appendAgentMessageDelta } from "@ctf-agent/core/agent-stream"
import type { AgentMessage } from "@earendil-works/pi-agent-core"
import type { DashboardConversation } from "../types.ts"

export interface AgentToolActivity {
  toolCallId: string
  toolName: string
  args: unknown
  partialResult?: unknown
  result?: unknown
  status: "running" | "succeeded" | "failed"
  startedAt: string
  updatedAt: string
}

export interface AgentActivity {
  connection: "connecting" | "connected" | "reconnecting"
  phase: "idle" | "responding" | "tool" | "compacting" | "retrying"
  detail?: string
  queued: number
  streamingMessageId?: string
  tools: Record<string, AgentToolActivity>
}

export const INITIAL_AGENT_ACTIVITY: AgentActivity = {
  connection: "connecting",
  phase: "idle",
  queued: 0,
  tools: {},
}

/** 用权威 JSONL 替换历史，同时保留尚未落盘的实时消息。 */
export function mergeCanonicalConversation(
  canonical: DashboardConversation,
  current: DashboardConversation | null,
): DashboardConversation {
  const live = (current?.messages ?? []).filter(
    (item) =>
      item.entryId.startsWith("live:") &&
      !canonical.messages.some(
        (persisted) => JSON.stringify(persisted.message) === JSON.stringify(item.message),
      ),
  )
  return { messages: [...canonical.messages, ...live] }
}

/** 将瞬时 Pi 事件投影到当前对话；message_end 后仍会由 JSONL 再次校准。 */
export function applyAgentStreamEvent(
  conversation: DashboardConversation | null,
  event: AgentStreamEvent,
): DashboardConversation {
  const messages = [...(conversation?.messages ?? [])]
  if (event.type === "message_started") {
    upsertLiveMessage(messages, event.messageId, event.message, event.createdAt)
  } else if (event.type === "text_delta" || event.type === "thinking_delta") {
    const index = messages.findIndex((item) => item.entryId === liveEntryId(event.messageId))
    if (index >= 0) {
      const current = messages[index]
      if (current) {
        messages[index] = {
          ...current,
          message: appendAgentMessageDelta(
            current.message,
            event.contentIndex,
            event.type === "text_delta" ? "text" : "thinking",
            event.delta,
          ),
        }
      }
    }
  } else if (event.type === "message_updated" || event.type === "message_completed") {
    upsertLiveMessage(messages, event.messageId, event.message, event.createdAt)
  }
  return { messages }
}

export function reduceAgentActivity(
  activity: AgentActivity,
  event: AgentStreamEvent,
): AgentActivity {
  if (event.type === "agent_started") {
    return { ...activity, phase: "responding", detail: undefined }
  }
  if (event.type === "agent_finished") {
    return { ...activity, phase: "idle", detail: undefined, queued: 0 }
  }
  if (event.type === "message_started") {
    return {
      ...activity,
      phase: "responding",
      detail: undefined,
      streamingMessageId: event.messageId,
    }
  }
  if (
    event.type === "text_delta" ||
    event.type === "thinking_delta" ||
    event.type === "message_updated"
  ) {
    return { ...activity, phase: "responding", detail: undefined }
  }
  if (event.type === "message_completed") {
    return { ...activity, streamingMessageId: undefined }
  }
  if (event.type === "tool_started") {
    return {
      ...activity,
      phase: "tool",
      detail: event.toolName,
      tools: {
        ...activity.tools,
        [event.toolCallId]: {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
          status: "running",
          startedAt: event.createdAt,
          updatedAt: event.createdAt,
        },
      },
    }
  }
  if (event.type === "tool_updated") {
    const current = activity.tools[event.toolCallId]
    if (!current) return activity
    return {
      ...activity,
      tools: {
        ...activity.tools,
        [event.toolCallId]: {
          ...current,
          partialResult: event.partialResult,
          updatedAt: event.createdAt,
        },
      },
    }
  }
  if (event.type === "tool_completed") {
    const current = activity.tools[event.toolCallId]
    return {
      ...activity,
      phase: "responding",
      detail: undefined,
      tools: {
        ...activity.tools,
        [event.toolCallId]: {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: current?.args,
          result: event.result,
          status: event.isError ? "failed" : "succeeded",
          startedAt: current?.startedAt ?? event.createdAt,
          updatedAt: event.createdAt,
        },
      },
    }
  }
  if (event.type === "queue_updated") {
    return { ...activity, queued: event.queued }
  }
  if (event.type === "status_changed") {
    return {
      ...activity,
      phase:
        event.status === "compacting"
          ? "compacting"
          : event.status === "retrying"
            ? "retrying"
            : event.status === "idle"
              ? "idle"
              : "responding",
      detail: event.detail,
    }
  }
  return activity
}

export function shouldRefreshAgentView(event: AgentStreamEvent): boolean {
  return (
    event.type === "agent_finished" ||
    (event.type === "tool_completed" && event.toolName === "father_request_test_access")
  )
}

function liveEntryId(messageId: string): string {
  return `live:${messageId}`
}

function upsertLiveMessage(
  messages: DashboardConversation["messages"],
  messageId: string,
  message: AgentMessage,
  timestamp: string,
): void {
  const entryId = liveEntryId(messageId)
  const index = messages.findIndex((item) => item.entryId === entryId)
  const next = { entryId, timestamp, message }
  if (index >= 0) messages[index] = next
  else messages.push(next)
}
