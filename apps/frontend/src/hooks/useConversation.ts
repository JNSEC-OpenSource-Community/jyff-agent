import { useCallback, useEffect, useMemo, useState } from "react"
import { apiMutation, apiRequest } from "../lib/api.ts"
import { errorMessage } from "../lib/format.ts"
import type { DashboardConversation } from "../types.ts"

export interface ConversationSource {
  /** 对话读接口（GET conversation）。 */
  conversationUrl: string
  /** 发送消息接口（POST）。 */
  sendUrl: string
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
  setMessage(message: string): void
  send(text: string): Promise<void>
} {
  const [conversation, setConversation] =
    useState<DashboardConversation | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [message, setMessage] = useState("")
  const [sending, setSending] = useState(false)

  const { conversationUrl, hasConversation } = target

  const load = useCallback(async (): Promise<void> => {
    setError("")
    setConversation(await apiRequest<DashboardConversation>(conversationUrl))
  }, [conversationUrl])

  useEffect(() => {
    setConversation(null)
    setError("")
    if (!hasConversation) return
    setLoading(true)
    void load()
      .catch((cause) => setError(errorMessage(cause)))
      .finally(() => setLoading(false))
  }, [hasConversation, load])

  const send = useCallback(
    async (text: string): Promise<void> => {
      const trimmed = text.trim()
      if (!trimmed) return
      setSending(true)
      setError("")
      try {
        await apiMutation(target.sendUrl, "POST", { message: trimmed })
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
      setMessage,
      send,
    }),
    [conversation, error, loading, message, send, sending],
  )
}
