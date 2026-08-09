import { Icon } from "@iconify/react"
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
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

export interface ConversationViewState {
  scrollTop: number
  atBottom: boolean
  newBelow: number
}

export type ConversationViewStateStore = Map<string, ConversationViewState>

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
  viewKey,
  viewStateStore,
  onSelectSubagent,
  onChanged,
  header,
  readOnly = false,
  notice,
  emptyDescription,
  composerPlaceholder,
  idleStatusLabel,
}: {
  target: ConversationTarget
  attempt: number
  runStatus: DashboardRun["status"]
  hasConversation: boolean
  conversationUrl: string
  streamUrl: string
  sendUrl: string
  exportUrl?: string
  viewKey?: string
  viewStateStore?: ConversationViewStateStore
  onSelectSubagent?(id: string): void
  onChanged(): Promise<void>
  header?: { label: string; subLabel: string; icon: string }
  readOnly?: boolean
  notice?: ReactNode
  emptyDescription?: string
  composerPlaceholder?: string
  idleStatusLabel?: string
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
  const localViewStateStore = useRef<ConversationViewStateStore>(new Map())
  const activeViewStateStore = viewStateStore ?? localViewStateStore.current
  const activeViewKey = viewKey ?? conversationUrl
  const atBottomRef = useRef(true)
  const prevLenRef = useRef(0)
  const newBelowRef = useRef(0)
  const pendingRestoreRef = useRef<ConversationViewState | null>(null)
  const [newBelow, setNewBelow] = useState(0)
  const [awayFromBottom, setAwayFromBottom] = useState(false)
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
  const status = activityLabel(activity, isRunActive, idleStatusLabel)

  useLayoutEffect(() => {
    const saved = activeViewStateStore.get(activeViewKey) ?? null
    pendingRestoreRef.current = saved
    prevLenRef.current = 0
    atBottomRef.current = saved?.atBottom ?? true
    newBelowRef.current = saved?.newBelow ?? 0
    setNewBelow(newBelowRef.current)
    setAwayFromBottom(saved ? !saved.atBottom : false)

    return () => {
      const element = scrollRef.current
      if (!element) return
      activeViewStateStore.set(activeViewKey, {
        scrollTop: element.scrollTop,
        atBottom: atBottomRef.current,
        newBelow: newBelowRef.current,
      })
    }
  }, [activeViewKey, activeViewStateStore])

  useEffect(() => {
    // 文本增量不会改变消息数，但仍需触发底部跟随。
    void contentVersion
    const currentLen = messages.length
    const element = scrollRef.current
    if (!element) return
    const saved = pendingRestoreRef.current
    if (saved && currentLen > 0) {
      pendingRestoreRef.current = null
      requestAnimationFrame(() => {
        element.scrollTop = saved.atBottom
          ? element.scrollHeight
          : Math.min(
              saved.scrollTop,
              Math.max(0, element.scrollHeight - element.clientHeight),
            )
        atBottomRef.current = saved.atBottom
        setAwayFromBottom(!saved.atBottom)
      })
    } else if (prevLenRef.current === 0 && currentLen > 0) {
      requestAnimationFrame(() => {
        element.scrollTop = element.scrollHeight
        atBottomRef.current = true
        setAwayFromBottom(false)
      })
    } else if (atBottomRef.current) {
      requestAnimationFrame(() => {
        element.scrollTop = element.scrollHeight
        setAwayFromBottom(false)
      })
    } else if (currentLen > prevLenRef.current) {
      const added = currentLen - prevLenRef.current
      setNewBelow((count) => {
        const next = count + added
        newBelowRef.current = next
        return next
      })
    }
    prevLenRef.current = currentLen
  }, [contentVersion, messages.length])

  const scrollToBottom = useCallback(() => {
    const element = scrollRef.current
    if (!element) return
    element.scrollTo({ top: element.scrollHeight, behavior: "smooth" })
    atBottomRef.current = true
    setAwayFromBottom(false)
    newBelowRef.current = 0
    setNewBelow(0)
  }, [])

  const handleScroll = useCallback(() => {
    const element = scrollRef.current
    if (!element) return
    const atBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight < 48
    atBottomRef.current = atBottom
    setAwayFromBottom(!atBottom)
    if (atBottom) {
      newBelowRef.current = 0
      setNewBelow(0)
    }
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
              icon={
                header?.icon ??
                (target.type === "solver" ? "lucide:bot" : "lucide:git-fork")
              }
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
                {header?.label ?? targetLabel(target)}
              </strong>
              <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                {header?.subLabel ?? targetSubLabel(target, attempt)}
              </span>
            </div>
            <div
              className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground"
              aria-live="polite"
            >
              <span
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  status.active ? "bg-primary" : "bg-quiet",
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
        <div className="mx-auto w-full max-w-5xl">
          {loading ? <ConversationSkeleton /> : null}
          {error ? <ErrorNotice message={error} className="mb-4" /> : null}
          {!loading && messages.length === 0 ? (
            isRunActive ? (
              <WorkingEmptyState label={status.text} />
            ) : (
              <EmptyState
                icon="lucide:message-circle-dashed"
                title="尚无 Agent 对话"
                description={
                  emptyDescription ?? "这个 Attempt 还没有生成可查看的回复。"
                }
              />
            )
          ) : null}
          <div
            className="flex flex-col gap-6"
            aria-live="polite"
            aria-relevant="additions text"
          >
            {messages.map(({ entryId, message: item, timestamp }, index) => {
              const streaming =
                entryId === `live:${activity.streamingMessageId ?? ""}`
              return (
                <article
                  key={entryId}
                  className={cn(
                    "group/message relative min-w-0",
                    item.role === "user"
                      ? "ml-auto max-w-[88%] overflow-hidden rounded-xl border border-border/80 bg-muted/70 px-4 py-3"
                      : "w-full pl-5 before:absolute before:top-1 before:bottom-1 before:left-0 before:w-px before:bg-border",
                  )}
                >
                  <MessageMeta
                    role={item.role}
                    timestamp={absoluteTime(timestamp)}
                  />
                  <MessageBody
                    message={item}
                    streaming={streaming}
                    latest={index === messages.length - 1}
                    toolActivities={activity.tools}
                    onSelectSubagent={onSelectSubagent}
                  />
                </article>
              )
            })}
          </div>
        </div>
      </div>

      {awayFromBottom ? (
        <div className="relative z-20 flex mb-3! h-0 shrink-0 items-center justify-center">
          <button
            type="button"
            onClick={scrollToBottom}
            className="animate-in fade-in-0 slide-in-from-bottom-2 relative inline-flex size-9 -translate-y-5 items-center justify-center rounded-full border border-border/80 bg-card/80 text-foreground opacity-80 shadow-md backdrop-blur-sm transition-[transform,opacity,border-color,background-color] duration-200 hover:-translate-y-[1.375rem] hover:border-primary/40 hover:bg-card hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:animate-none motion-reduce:transition-none"
            aria-label={
              newBelow > 0 ? `回到底部，${newBelow} 条新内容` : "回到底部"
            }
          >
            <Icon icon="lucide:arrow-down" width="15" aria-hidden="true" />
            {newBelow > 0 ? (
              <span className="absolute -top-1 -right-1 flex min-w-4.5 items-center justify-center rounded-full bg-primary px-1 text-[9px] leading-4.5 font-semibold text-primary-foreground shadow-sm">
                {newBelow > 99 ? "99+" : newBelow}
              </span>
            ) : null}
          </button>
        </div>
      ) : null}

      {notice}
      {!readOnly ? (
        <form
          className="shrink-0 border-t border-border/80 bg-card/80 p-3 backdrop-blur-sm max-lg:p-2"
          onSubmit={(event) => void onSubmit(event)}
        >
          <div className="mx-auto flex max-w-5xl items-end gap-2 rounded-xl border border-border bg-background/70 p-1.5 transition-colors focus-within:border-primary/45">
            <Textarea
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder={
                composerPlaceholder ??
                (isRunActive
                  ? "给 Agent 补充方向或要求…"
                  : "发送消息以继续这个 Attempt…")
              }
              rows={1}
              name="agent-message"
              autoComplete="off"
              aria-label="发送给 Agent 的消息"
              className="min-h-10 max-h-40 flex-1 resize-none border-0 bg-transparent px-2 py-2 shadow-none focus-visible:ring-0"
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
              className="size-8 shrink-0 rounded-lg"
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
        </form>
      ) : null}
    </section>
  )
}

function activityLabel(
  activity: ReturnType<typeof useConversation>["activity"],
  isRunActive: boolean,
  idleStatusLabel?: string,
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
  if (isRunActive)
    return idleStatusLabel
      ? { text: idleStatusLabel, active: false }
      : { text: "Agent 正在处理题目", active: true }
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
