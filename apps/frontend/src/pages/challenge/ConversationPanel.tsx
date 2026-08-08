import { Icon } from "@iconify/react"
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react"
import {
  Button,
  EmptyState,
  ErrorNotice,
  Spinner,
  Textarea,
} from "../../components/index.ts"
import type { ConversationTarget } from "../../hooks/useChallengeDetails.ts"
import { useConversation } from "../../hooks/useConversation.ts"
import { absoluteTime } from "../../lib/time.ts"
import { cn } from "../../lib/utils.ts"
import { MessageBody, MessageMeta } from "./MessageBody.tsx"

function targetLabel(target: ConversationTarget): string {
  return target.type === "solver" ? "Solver Agent" : target.subagent.displayName
}

function targetSubLabel(target: ConversationTarget, attempt: number): string {
  return target.type === "solver" ? `Attempt ${attempt}` : target.subagent.role
}

export function ConversationPanel({
  target,
  attempt,
  hasConversation,
  conversationUrl,
  sendUrl,
  exportUrl,
  onChanged,
}: {
  target: ConversationTarget
  attempt: number
  hasConversation: boolean
  conversationUrl: string
  sendUrl: string
  exportUrl?: string
  onChanged(): Promise<void>
}): React.ReactElement {
  const { conversation, loading, error, message, sending, setMessage, send } =
    useConversation({ conversationUrl, sendUrl, hasConversation }, onChanged)

  const scrollRef = useRef<HTMLDivElement>(null)
  const [newBelow, setNewBelow] = useState(0)
  const prevLenRef = useRef(0)

  const messages = conversation?.messages ?? []

  // Track message count and auto-scroll
  useEffect(() => {
    const currentLen = messages.length
    if (currentLen > prevLenRef.current && prevLenRef.current > 0) {
      // New messages arrived
      const el = scrollRef.current
      if (el) {
        const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
        if (atBottom) {
          // Auto scroll to bottom
          requestAnimationFrame(() => {
            el.scrollTop = el.scrollHeight
          })
        } else {
          // Not at bottom — increment new message counter
          setNewBelow((n) => n + (currentLen - prevLenRef.current))
        }
      }
    } else if (currentLen > 0 && prevLenRef.current === 0) {
      // Initial load — scroll to bottom
      requestAnimationFrame(() => {
        if (scrollRef.current) {
          scrollRef.current.scrollTop = scrollRef.current.scrollHeight
        }
      })
    }
    prevLenRef.current = currentLen
  }, [messages.length])

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current
    if (el) {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" })
      setNewBelow(0)
    }
  }, [])

  // Reset new message counter when user manually scrolls to bottom
  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (el) {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
      if (atBottom && newBelow > 0) {
        setNewBelow(0)
      }
    }
  }, [newBelow])

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault()
    await send(message)
  }

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      {/* Header bar */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span
            className={cn(
              "flex size-8 shrink-0 items-center justify-center rounded-full border text-primary",
              "border-primary/30 bg-primary/5",
            )}
          >
            <Icon
              icon={target.type === "solver" ? "lucide:bot" : "lucide:network"}
              width="17"
            />
          </span>
          <div className="min-w-0">
            <strong className="block truncate text-sm">
              {targetLabel(target)}
            </strong>
            <small className="block truncate text-xs text-muted-foreground">
              {targetSubLabel(target, attempt)}
            </small>
          </div>
        </div>
        {exportUrl ? (
          <Button variant="ghost" size="sm" asChild>
            <a href={exportUrl} target="_blank" rel="noreferrer">
              <Icon icon="lucide:file-code-2" width="15" /> 查看 HTML
            </a>
          </Button>
        ) : null}
      </div>

      {/* Messages area */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-4"
        style={{ scrollbarGutter: "stable" }}
      >
        {loading ? <Spinner label="读取 Pi 会话" /> : null}
        {error ? <ErrorNotice message={error} className="mb-3" /> : null}
        {!loading && !hasConversation ? (
          <EmptyState
            icon="lucide:message-circle-dashed"
            title="尚无 Agent 对话"
            description="该 attempt 还没有生成可查看的 Assistant 消息。"
          />
        ) : null}
        <div className="flex flex-col gap-4">
          {messages.map(({ entryId, message: item, timestamp }) => (
            <article
              key={entryId}
              className={cn(
                "max-w-[85%] rounded-2xl border px-4 py-2.5 shadow-sm",
                item.role === "user"
                  ? "self-end border-border bg-muted text-foreground"
                  : "self-start border-border bg-card",
              )}
            >
              <MessageMeta
                role={item.role}
                timestamp={absoluteTime(timestamp)}
              />
              <MessageBody message={item} />
            </article>
          ))}
        </div>
      </div>

      {/* New messages popover */}
      {newBelow > 0 ? (
        <div className="flex shrink-0 justify-center pb-1">
          <button
            type="button"
            onClick={scrollToBottom}
            className="flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-xs font-medium text-primary shadow-sm transition-all hover:bg-muted hover:border-primary/30"
          >
            <Icon icon="lucide:arrow-down" width="13" />
            {newBelow} 条新消息
          </button>
        </div>
      ) : null}

      {/* Input area */}
      <form
        className="shrink-0 border-t border-border p-3"
        onSubmit={(event) => void onSubmit(event)}
      >
        <div className="flex items-end gap-2">
          <Textarea
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder={
              target.type === "solver"
                ? "向当前 Solver 发送补充指令…"
                : "Steer 这个 SubAgent；完成的会话会从持久化状态恢复…"
            }
            rows={2}
            className="min-h-12 flex-1 resize-none"
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault()
                event.currentTarget.form?.requestSubmit()
              }
            }}
          />
          <Button
            type="submit"
            size="icon"
            disabled={sending || !message.trim()}
            aria-label="发送消息"
          >
            <Icon
              icon={sending ? "lucide:loader-circle" : "lucide:arrow-up"}
              className={sending ? "animate-spin" : ""}
              width="18"
            />
          </Button>
        </div>
      </form>
    </div>
  )
}
