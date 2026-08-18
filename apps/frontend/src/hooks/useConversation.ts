import type { AgentStreamEvent } from "@ctf-agent/core"
import { useCallback, useEffect, useMemo, useState } from "react"
import { apiMutation, apiRequest } from "../lib/api.ts"
import {
  type AgentActivity,
  applyAgentStreamEvent,
  INITIAL_AGENT_ACTIVITY,
  mergeCanonicalConversation,
  reduceAgentActivity,
  shouldRefreshAgentView,
} from "../lib/conversation-stream.ts"
import { errorMessage } from "../lib/format.ts"
import type { DashboardConversation } from "../types.ts"

export interface ConversationSource {
  /** 对话读接口（GET conversation）。 */
  conversationUrl: string
  /** 发送消息接口（POST）。 */
  sendUrl: string
  /** POST 请求体中的消息字段名：challenge 用 "text"，father/steer 用 "message"。 */
  bodyKey: "message" | "text"
  /** 当前 Run 或 SubAgent 的实时 Pi 事件接口。 */
  streamUrl: string
  /** 是否有可读取的持久化对话。 */
  hasConversation: boolean
}

/**
 * 结构化 Pi 会话面板的状态逻辑：加载对话、发送/引导消息、刷新。
 * Solver 对话与 SubAgent steer 共用同一实现。
 */
export function useConversation(
  target: ConversationSource,
  onChanged: () => Promise<void>,
): {
  conversation: DashboardConversation | null
  loading: boolean
  error: string
  message: string
  sending: boolean
  activity: AgentActivity
  setMessage: (message: string) => void
  send: (text: string) => Promise<void>
} {
  const [conversation, setConversation] = useState<DashboardConversation | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [message, setMessage] = useState("")
  const [sending, setSending] = useState(false)
  const [activity, setActivity] = useState<AgentActivity>(INITIAL_AGENT_ACTIVITY)

  const { conversationUrl, hasConversation } = target

  const load = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      setError("")
      const canonical = await apiRequest<DashboardConversation>(conversationUrl, { signal })
      setConversation((current) => mergeCanonicalConversation(canonical, current))
    },
    [conversationUrl],
  )

  useEffect(() => {
    const controller = new AbortController()
    setConversation(null)
    setError("")
    if (!hasConversation) {
      setLoading(false)
      return () => controller.abort()
    }
    setLoading(true)
    void load(controller.signal)
      .catch((cause) => {
        if (!isAbortError(cause)) setError(errorMessage(cause))
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [hasConversation, load])

  useEffect(() => {
    const controller = new AbortController()
    setActivity(INITIAL_AGENT_ACTIVITY)
    const source = new EventSource(target.streamUrl)
    const pending: AgentStreamEvent[] = []
    let frame: number | undefined
    const flush = (): void => {
      frame = undefined
      const events = pending.splice(0)
      if (events.length === 0) return
      setConversation((current) => events.reduce(applyAgentStreamEvent, current))
      setActivity((current) => events.reduce(reduceAgentActivity, current))
    }
    const queue = (event: Event): void => {
      try {
        const parsed = JSON.parse((event as MessageEvent<string>).data) as AgentStreamEvent
        pending.push(parsed)
        if (shouldRefreshAgentView(parsed)) {
          void onChanged().catch((cause) => {
            if (!controller.signal.aborted && !isAbortError(cause)) setError(errorMessage(cause))
          })
        }
        frame ??= requestAnimationFrame(flush)
      } catch {
        // 丢弃无法解析的增量帧，JSONL 会在下一次加载时校准。
      }
    }
    source.addEventListener("ready", () => {
      setActivity((current) => ({ ...current, connection: "connected" }))
      if (hasConversation) {
        void load(controller.signal).catch((cause) => {
          if (!controller.signal.aborted && !isAbortError(cause)) setError(errorMessage(cause))
        })
      }
    })
    source.addEventListener("agent_event", queue)
    source.onerror = () => {
      setActivity((current) => ({ ...current, connection: "reconnecting" }))
    }
    return () => {
      controller.abort()
      source.close()
      if (frame !== undefined) cancelAnimationFrame(frame)
    }
  }, [hasConversation, load, onChanged, target.streamUrl])

  const send = useCallback(
    async (text: string): Promise<void> => {
      const trimmed = text.trim()
      if (!trimmed) return
      setSending(true)
      setError("")
      try {
        await apiMutation(target.sendUrl, "POST", { [target.bodyKey]: trimmed })
        setMessage("")
        await onChanged()
        if (hasConversation) await load()
      } catch (cause) {
        setError(errorMessage(cause))
      } finally {
        setSending(false)
      }
    },
    [hasConversation, load, onChanged, target.sendUrl],
  )

  return useMemo(
    () => ({
      conversation,
      loading,
      error,
      message,
      sending,
      activity,
      setMessage,
      send,
    }),
    [activity, conversation, error, loading, message, send, sending],
  )
}

function isAbortError(cause: unknown): boolean {
  return cause instanceof Error && cause.name === "AbortError"
}
