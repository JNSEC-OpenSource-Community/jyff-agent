import { Icon } from "@iconify/react"
import type { FormEvent } from "react"
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
import { MessageBody, MessageMeta } from "./MessageBody.tsx"

function targetLabel(target: ConversationTarget): string {
  return target.type === "solver" ? "Solver Agent" : target.subagent.displayName
}

function targetSubLabel(target: ConversationTarget, attempt: number): string {
  return target.type === "solver" ? `Attempt ${attempt}` : target.subagent.role
}

/**
 * 结构化 Pi 会话面板：读取持久化对话、渲染消息流、发送/引导消息。
 * Solver 对话与 SubAgent steer 共用同一组件。
 */
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

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault()
    await send(message)
  }

  const messages = conversation?.messages ?? []
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div className="border-border/60 flex shrink-0 items-center justify-between gap-2 border-b px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="bg-muted text-muted-foreground flex size-8 shrink-0 items-center justify-center rounded-full">
            <Icon
              icon={target.type === "solver" ? "lucide:bot" : "lucide:network"}
              width="17"
            />
          </span>
          <div className="min-w-0">
            <strong className="block truncate text-sm">
              {targetLabel(target)}
            </strong>
            <small className="text-muted-foreground block truncate text-xs">
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
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {loading ? <Spinner label="读取 Pi 会话" /> : null}
        {error ? <ErrorNotice message={error} /> : null}
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
              className={
                item.role === "user"
                  ? "border-border/60 bg-muted/30 max-w-[85%] self-end rounded-lg border px-3 py-2"
                  : "border-border/60 max-w-[85%] self-start rounded-lg border bg-background/40 px-3 py-2"
              }
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
      <form
        className="border-border/60 shrink-0 border-t p-3"
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
