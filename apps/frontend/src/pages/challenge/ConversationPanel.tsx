import { Icon } from "@iconify/react"
import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import {
  Button,
  EmptyState,
  ErrorNotice,
  Textarea,
} from "../../components/index.ts"
import type { ConversationTarget } from "../../hooks/useChallengeDetails.ts"
import { useConversation } from "../../hooks/useConversation.ts"
import { toolLabel } from "../../lib/conversation.ts"
import { absoluteTime } from "../../lib/time.ts"
import { cn } from "../../lib/utils.ts"
import type { DashboardRun } from "../../types.ts"
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
  runStatus,
  hasConversation,
  conversationUrl,
  streamUrl,
  sendUrl,
  exportUrl,
  onChanged,
}: {
  target: ConversationTarget
  attempt: number
  runStatus: DashboardRun["status"]
  hasConversation: boolean
  conversationUrl: string
  streamUrl: string
  sendUrl: string
  exportUrl?: string
  onChanged(): Promise<void>
}): React.ReactElement {
  const {
    conversation,
    loading,
    error,
    message,
    sending,
    activity,
    setMessage,
    send,
  } = useConversation(
    { conversationUrl, streamUrl, sendUrl, hasConversation },
    onChanged,
  )

  const scrollRef = useRef<HTMLDivElement>(null)
  const atBottomRef = useRef(true)
  const prevLenRef = useRef(0)
  const [newBelow, setNewBelow] = useState(0)
  const messages = conversation?.messages ?? []
  const contentVersion = useMemo(
    () =>
      messages.reduce(
        (total, item) => total + JSON.stringify(item.message).length,
        messages.length,
      ),
    [messages],
  )
  const isRunActive = [
    "preparing",
    "running",
    "blocking",
    "writing_writeup",
  ].includes(runStatus)
  const status = activityLabel(activity, isRunActive)

  useEffect(() => {
    // 文本增量不会改变消息数，但仍需触发底部跟随。
    void contentVersion
    const currentLen = messages.length
    const element = scrollRef.current
    if (!element) return
    if (prevLenRef.current === 0 && currentLen > 0) {
      requestAnimationFrame(() => {
        element.scrollTop = element.scrollHeight
      })
    } else if (atBottomRef.current) {
      requestAnimationFrame(() => {
        element.scrollTop = element.scrollHeight
      })
    } else if (currentLen > prevLenRef.current) {
      setNewBelow((count) => count + currentLen - prevLenRef.current)
    }
    prevLenRef.current = currentLen
  }, [contentVersion, messages.length])

  const scrollToBottom = useCallback(() => {
    const element = scrollRef.current
    if (!element) return
    element.scrollTo({ top: element.scrollHeight, behavior: "smooth" })
    atBottomRef.current = true
    setNewBelow(0)
  }, [])

  const handleScroll = useCallback(() => {
    const element = scrollRef.current
    if (!element) return
    const atBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight < 48
    atBottomRef.current = atBottom
    if (atBottom) setNewBelow(0)
  }, [])

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault()
    await send(message)
  }

  return (
    <section
      className="flex h-full min-h-0 flex-1 flex-col"
      aria-label="Agent 对话"
    >
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border/80 bg-card/70 px-4 py-3 backdrop-blur-sm max-lg:px-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="relative flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/70 text-primary">
            <Icon
              icon={target.type === "solver" ? "lucide:bot" : "lucide:git-fork"}
              width="16"
              aria-hidden="true"
            />
            {isRunActive ? (
              <span className="absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full border-2 border-card bg-success" />
            ) : null}
          </span>
          <div className="min-w-0">
            <div className="flex items-baseline gap-2">
              <strong className="truncate text-sm font-semibold tracking-tight">
                {targetLabel(target)}
              </strong>
              <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                {targetSubLabel(target, attempt)}
              </span>
            </div>
            <div
              className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground"
              aria-live="polite"
            >
              <span
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  status.active ? "bg-primary animate-pulse-glow" : "bg-quiet",
                )}
              />
              <span className="truncate">{status.text}</span>
              {activity.queued > 0 ? (
                <span className="shrink-0">· {activity.queued} 条指令排队</span>
              ) : null}
            </div>
          </div>
        </div>
        {exportUrl ? (
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0 max-lg:px-2"
            asChild
          >
            <a href={exportUrl} target="_blank" rel="noreferrer">
              <Icon icon="lucide:file-code-2" width="15" aria-hidden="true" />
              <span className="max-lg:sr-only">查看 HTML</span>
            </a>
          </Button>
        ) : null}
      </header>

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-5 py-5 max-lg:px-3 max-lg:py-4"
        style={{ scrollbarGutter: "stable" }}
      >
        <div className="mx-auto w-full max-w-3xl">
          {loading ? <ConversationSkeleton /> : null}
          {error ? <ErrorNotice message={error} className="mb-4" /> : null}
          {!loading && messages.length === 0 ? (
            isRunActive ? (
              <WorkingEmptyState label={status.text} />
            ) : (
              <EmptyState
                icon="lucide:message-circle-dashed"
                title="尚无 Agent 对话"
                description="这个 Attempt 还没有生成可查看的回复。"
              />
            )
          ) : null}
          <div
            className="flex flex-col gap-6"
            aria-live="polite"
            aria-relevant="additions text"
          >
            {messages.map(({ entryId, message: item, timestamp }) => {
              const streaming =
                entryId === `live:${activity.streamingMessageId ?? ""}`
              return (
                <article
                  key={entryId}
                  className={cn(
                    "group/message relative min-w-0",
                    item.role === "user"
                      ? "ml-auto max-w-[85%] rounded-xl border border-border/80 bg-muted/70 px-4 py-3"
                      : "w-full pl-5 before:absolute before:top-1 before:bottom-1 before:left-0 before:w-px before:bg-border",
                    streaming &&
                      item.role === "assistant" &&
                      "before:bg-primary/70 before:shadow-[0_0_12px_rgba(94,106,210,0.45)]",
                  )}
                >
                  <MessageMeta
                    role={item.role}
                    timestamp={absoluteTime(timestamp)}
                  />
                  <MessageBody
                    message={item}
                    streaming={streaming}
                    toolActivities={activity.tools}
                  />
                  {streaming && item.role === "assistant" ? (
                    <>
                      <span
                        className="agent-stream-cursor mt-2"
                        aria-hidden="true"
                      />
                      <span className="sr-only">Agent 正在继续输出</span>
                    </>
                  ) : null}
                </article>
              )
            })}
          </div>
        </div>
      </div>

      {newBelow > 0 ? (
        <div className="relative z-10 flex h-0 shrink-0 justify-center">
          <button
            type="button"
            onClick={scrollToBottom}
            className="-translate-y-12 rounded-lg border border-border bg-popover px-3 py-1.5 text-xs font-medium text-foreground shadow-lg transition-colors hover:border-primary/40 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="flex items-center gap-1.5">
              <Icon icon="lucide:arrow-down" width="13" aria-hidden="true" />
              {newBelow} 条新内容
            </span>
          </button>
        </div>
      ) : null}

      <form
        className="shrink-0 border-t border-border/80 bg-card/80 p-3 backdrop-blur-sm max-lg:p-2"
        onSubmit={(event) => void onSubmit(event)}
      >
        <div className="mx-auto max-w-3xl rounded-xl border border-border bg-background/70 p-1.5 shadow-[0_8px_24px_-18px_rgba(94,106,210,0.65)] transition-colors focus-within:border-primary/45">
          <Textarea
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder={
              isRunActive
                ? "给 Agent 补充方向或要求…"
                : "发送消息以继续这个 Attempt…"
            }
            rows={1}
            name="agent-message"
            autoComplete="off"
            aria-label="发送给 Agent 的消息"
            className="min-h-10 max-h-40 resize-none border-0 bg-transparent px-2 py-2 shadow-none focus-visible:ring-0"
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault()
                event.currentTarget.form?.requestSubmit()
              }
            }}
          />
          <div className="flex items-center justify-between gap-3 px-1 pb-0.5">
            <span className="text-[10px] text-muted-foreground max-sm:hidden">
              Enter 发送 · Shift + Enter 换行
            </span>
            <Button
              type="submit"
              size="icon"
              className="ml-auto size-8 rounded-lg"
              disabled={sending || !message.trim()}
              aria-label={sending ? "正在发送消息" : "发送消息"}
            >
              <Icon
                icon={sending ? "lucide:loader-circle" : "lucide:arrow-up"}
                className={sending ? "animate-spin" : ""}
                width="16"
                aria-hidden="true"
              />
            </Button>
          </div>
        </div>
      </form>
    </section>
  )
}

function activityLabel(
  activity: ReturnType<typeof useConversation>["activity"],
  isRunActive: boolean,
): { text: string; active: boolean } {
  if (activity.connection === "reconnecting") {
    return { text: "实时连接中断，正在重连", active: true }
  }
  if (activity.phase === "tool") {
    return {
      text: `正在执行 ${toolLabel(activity.detail ?? "工具")}`,
      active: true,
    }
  }
  if (activity.phase === "compacting") {
    return { text: "正在整理上下文", active: true }
  }
  if (activity.phase === "retrying") {
    return { text: activity.detail ?? "正在等待重试", active: true }
  }
  if (activity.phase === "responding") {
    return { text: "正在分析并生成回复", active: true }
  }
  if (isRunActive) return { text: "Agent 正在处理题目", active: true }
  return { text: "历史会话", active: false }
}

function ConversationSkeleton(): React.ReactElement {
  return (
    <div className="space-y-5" role="status" aria-label="正在读取 Pi 会话">
      {["w-2/3", "w-5/6", "w-1/2"].map((width) => (
        <div key={width} className="space-y-2 pl-5">
          <div className="h-2.5 w-20 animate-pulse rounded bg-muted" />
          <div className={cn("h-3 animate-pulse rounded bg-muted", width)} />
          <div className="h-3 w-full animate-pulse rounded bg-muted" />
        </div>
      ))}
    </div>
  )
}

function WorkingEmptyState({ label }: { label: string }): React.ReactElement {
  return (
    <div
      className="flex min-h-52 flex-col items-center justify-center text-center"
      role="status"
    >
      <span className="relative mb-4 flex size-10 items-center justify-center rounded-xl border border-primary/25 bg-primary/5 text-primary">
        <Icon icon="lucide:bot" width="18" aria-hidden="true" />
        <span className="absolute inset-0 animate-ping-soft rounded-xl border border-primary/30" />
      </span>
      <p className="text-sm font-medium text-foreground">{label}</p>
      <p className="mt-1 max-w-xs text-xs leading-relaxed text-muted-foreground">
        第一段回复或工具调用会实时出现在这里。
      </p>
    </div>
  )
}
