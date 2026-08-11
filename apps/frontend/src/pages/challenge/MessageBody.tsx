import type { AgentMessage } from "@earendil-works/pi-agent-core"
import { Icon } from "@iconify/react"
import { useEffect, useState } from "react"
import { AnsiText } from "../../components/content/AnsiText.tsx"
import { MarkdownContent } from "../../components/content/MarkdownContent.tsx"
import {
  Badge,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../../components/index.ts"
import {
  roleLabel,
  shouldAutoExpandToolResult,
  textContent,
  toolLabel,
} from "../../lib/conversation.ts"
import type { AgentToolActivity } from "../../lib/conversation-stream.ts"
import { absoluteTime } from "../../lib/time.ts"
import { cn } from "../../lib/utils.ts"

/** 解析 XML 内容，检测顶层标签并返回语义化渲染所需的数据。 */
function parseXmlContent(text: string): {
  tag: string | null
  content: string
  children: Record<string, string>
} {
  const trimmed = text.trim()
  if (!trimmed.startsWith("<") || !trimmed.includes(">")) {
    return { tag: null, content: text, children: {} }
  }

  // 匹配顶层标签名
  const rootMatch = trimmed.match(/^<([a-zA-Z_][\w-]*)\b/)
  if (!rootMatch?.[1]) return { tag: null, content: trimmed, children: {} }

  const rootTag: string = rootMatch[1]
  const children: Record<string, string> = {}

  // 匹配 <tag>...</tag> 的内部内容
  const escaped = rootTag.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")
  const innerMatch = trimmed.match(new RegExp(`<${escaped}[^>]*>([\\s\\S]*)<\\/${escaped}>`))
  const inner = innerMatch?.[1] ?? trimmed

  // 提取子标签
  const subTagRegex = /<(\w+)\b[^>]*>([\s\S]*?)<\/\1>/g
  let subMatch = subTagRegex.exec(inner)
  while (subMatch !== null) {
    const subTag = subMatch[1]
    const subContent = subMatch[2]
    if (subTag && subContent) {
      if (!children[subTag]) {
        children[subTag] = subContent.trim()
      }
    }
    subMatch = subTagRegex.exec(inner)
  }

  return { tag: rootTag, content: trimmed, children }
}

/** 检测文本是否包含 XML，返回类型信息。 */
function classifyXml(text: string): {
  isXml: boolean
  tag: string | null
  content: string
} {
  const trimmed = text.trim()
  if (!trimmed.startsWith("<") || !trimmed.includes(">")) {
    return { isXml: false, tag: null, content: text }
  }
  // 简单闭合检测
  const hasClose = trimmed.includes("/>") || /<\/\w+>/.test(trimmed)
  if (!hasClose) return { isXml: false, tag: null, content: text }

  const tagMatch = trimmed.match(/^<([a-zA-Z_][\w-]*)\b/)
  return { isXml: true, tag: tagMatch?.[1] ?? null, content: trimmed }
}

/** 从工具参数中提取可读的简短摘要，用于折叠按钮上显示。 */
function toolDetail(name: string, args: unknown): string | null {
  try {
    const a = args as Record<string, unknown> | undefined
    if (!a) return null
    switch (name) {
      case "bash": {
        const cmd = displayValue(a.command ?? a.cmd)
        return cmd.length > 60 ? `${cmd.slice(0, 60)}…` : cmd || null
      }
      case "read":
      case "edit": {
        const fp = displayValue(a.path ?? a.file_path ?? a.filePath)
        if (!fp) return null
        // 只显示文件名
        const name = fp.split(/[/\\]/).pop() ?? fp
        return name.length > 40 ? `${name.slice(0, 40)}…` : name
      }
      case "write": {
        const fp = displayValue(a.path ?? a.file_path ?? a.filePath)
        if (!fp) return null
        const name = fp.split(/[/\\]/).pop() ?? fp
        return name.length > 40 ? `${name.slice(0, 40)}…` : name
      }
      case "list": {
        const dir = displayValue(a.path ?? a.directory ?? a.dir)
        return dir || null
      }
      case "ctf_submit_flag": {
        const flag = displayValue(a.flag)
        return flag ? `🚩 ${flag.slice(0, 24)}…` : null
      }
      case "Agent": {
        const role = displayValue(a.subagent_type ?? a.role ?? a.subagent)
        const description = displayValue(a.description)
        return [role, description].filter(Boolean).join(" · ") || null
      }
      case "get_subagent_result": {
        const id = displayValue(a.agent_id)
        return a.wait === true ? `${shortId(id)} · 等待完成` : shortId(id)
      }
      case "steer_subagent":
      case "cancel_subagent": {
        return shortId(displayValue(a.agent_id)) || null
      }
      default:
        return null
    }
  } catch {
    return null
  }
}

function displayValue(value: unknown): string {
  if (value === undefined || value === null) return ""
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value)
  }
  try {
    return JSON.stringify(value) ?? ""
  } catch {
    return ""
  }
}

const SUBAGENT_TOOL_NAMES = new Set([
  "Agent",
  "get_subagent_result",
  "steer_subagent",
  "cancel_subagent",
  "list_subagents",
])

function shortId(id: string): string {
  if (!id) return ""
  return id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-3)}` : id
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined
  }
  return value as Record<string, unknown>
}

function parsedToolOutput(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    try {
      return recordOf(JSON.parse(value))
    } catch {
      return undefined
    }
  }
  const record = recordOf(value)
  return recordOf(record?.details) ?? record
}

function subagentIdFromTool(toolName: string, args: unknown, output: unknown): string | undefined {
  if (!SUBAGENT_TOOL_NAMES.has(toolName)) return undefined
  const input = recordOf(args)
  const result = parsedToolOutput(output)
  const candidate = input?.agent_id ?? input?.resume ?? result?.id ?? result?.agent_id
  return typeof candidate === "string" && candidate ? candidate : undefined
}

function ToolBlock({
  label,
  detail,
  error,
  extra,
  activity,
  autoOpen = false,
  ansi = false,
  subagent,
  subagentTool = false,
}: {
  label: string
  detail: string
  error?: boolean
  extra?: string | null
  activity?: AgentToolActivity
  autoOpen?: boolean
  ansi?: boolean
  subagent?: {
    id: string
    onSelect: (id: string) => void
  }
  subagentTool?: boolean
}): React.ReactElement {
  const elapsed = useElapsed(activity)
  const running = activity?.status === "running"
  const failed = error || activity?.status === "failed"
  const statusLabel = running
    ? `运行中 · ${elapsed}`
    : failed
      ? "执行失败"
      : activity?.status === "succeeded"
        ? `完成 · ${elapsed}`
        : null
  const renderedDetail = activity?.partialResult
    ? `${detail}\n\n${stringifyToolOutput(activity.partialResult)}`
    : activity?.result
      ? `${detail}\n\n${stringifyToolOutput(activity.result)}`
      : detail || "（等待输出）"
  return (
    <Collapsible
      defaultOpen={autoOpen}
      className={cn(
        "group/tool relative overflow-hidden rounded-lg border transition-colors data-[state=open]:bg-muted/70",
        failed
          ? "border-danger/30 bg-danger/5"
          : running
            ? "border-primary/35 bg-primary/[0.045]"
            : "border-border/80 bg-muted/55",
      )}
    >
      <div className="flex min-w-0 items-stretch">
        <CollapsibleTrigger className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 px-3 py-2.5 text-xs font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset">
          <span
            className={cn(
              "flex size-6 shrink-0 items-center justify-center rounded-md border",
              failed
                ? "border-danger/25 bg-danger/10 text-danger"
                : running
                  ? "border-primary/30 bg-primary/10 text-primary"
                  : "border-border bg-background/60",
            )}
          >
            <Icon
              icon={
                failed
                  ? "lucide:circle-x"
                  : subagentTool
                    ? "lucide:waypoints"
                    : "lucide:terminal-square"
              }
              width="14"
              aria-hidden="true"
            />
          </span>
          <span className="min-w-0 flex-1 truncate text-left">
            {label}
            {extra ? (
              <span className="ml-1.5 font-normal text-muted-foreground/70">{extra}</span>
            ) : null}
          </span>
          {statusLabel ? (
            <span
              className={cn(
                "shrink-0 font-mono text-[10px] tabular-nums",
                failed ? "text-danger" : running ? "text-primary" : "text-muted-foreground",
              )}
              aria-live={running ? "polite" : undefined}
            >
              {statusLabel}
            </span>
          ) : null}
          <Icon
            icon="lucide:chevron-down"
            className="shrink-0 transition-transform group-data-[state=open]/tool:rotate-180"
            width="15"
            aria-hidden="true"
          />
        </CollapsibleTrigger>
        {subagent ? (
          <button
            type="button"
            onClick={() => subagent.onSelect(subagent.id)}
            className="group/link flex shrink-0 items-center gap-1.5 border-l border-border/80 px-3 text-xs font-medium text-primary outline-none transition-colors hover:bg-primary/10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            aria-label={`打开 SubAgent ${subagent.id} 对话`}
          >
            <span className="hidden font-mono text-[10px] sm:inline">{shortId(subagent.id)}</span>
            <Icon
              icon="lucide:arrow-up-right"
              width="13"
              className="transition-transform group-hover/link:-translate-y-0.5 group-hover/link:translate-x-0.5"
              aria-hidden="true"
            />
          </button>
        ) : null}
      </div>
      <CollapsibleContent className="border-t border-border/80">
        <pre className="max-w-full overflow-x-auto px-3 py-2.5 font-mono text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]">
          {ansi ? <AnsiText text={renderedDetail} /> : renderedDetail}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  )
}

function ThinkingBlock({
  redacted,
  content,
  streaming = false,
  latest = false,
}: {
  redacted: boolean
  content: string
  streaming?: boolean
  latest?: boolean
}): React.ReactElement {
  const [open, setOpen] = useState(streaming)
  useEffect(() => {
    if (streaming) setOpen(true)
    else if (!latest) setOpen(false)
  }, [latest, streaming])
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="group/thinking overflow-hidden rounded-lg border border-border/80 bg-muted/55 transition-colors data-[state=open]:bg-muted/70"
    >
      <CollapsibleTrigger className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2.5 text-xs font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-md border border-border bg-background/60">
          <Icon icon="lucide:brain" width="14" aria-hidden="true" />
        </span>
        <span>{streaming ? "正在推理" : "推理记录"}</span>
        {streaming ? (
          <span className="agent-thinking-wave" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
        ) : null}
        <Icon
          icon="lucide:chevron-down"
          className="ml-auto shrink-0 transition-transform group-data-[state=open]/thinking:rotate-180"
          width="15"
          aria-hidden="true"
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="border-t border-border/80 px-3 py-2.5">
        {redacted ? (
          <p className="text-sm text-muted-foreground">推理内容已由模型提供方隐藏。</p>
        ) : (
          <MarkdownContent className="text-muted-foreground">{content}</MarkdownContent>
        )}
      </CollapsibleContent>
    </Collapsible>
  )
}

export function MessageBody({
  message,
  streaming = false,
  latest = false,
  toolActivities = {},
  onSelectSubagent,
}: {
  message: AgentMessage
  streaming?: boolean
  latest?: boolean
  toolActivities?: Record<string, AgentToolActivity>
  onSelectSubagent?: (id: string) => void
}): React.ReactElement {
  if (message.role === "user") {
    const raw = textContent(message.content)
    const xml = classifyXml(raw)
    if (xml.isXml) {
      return <XmlContent tag={xml.tag} content={xml.content} onSelectSubagent={onSelectSubagent} />
    }
    return <MarkdownContent>{raw}</MarkdownContent>
  }
  if (message.role === "assistant") {
    return (
      <div className="flex flex-col gap-2">
        {message.content.map((part, index) => {
          if (part.type === "text") {
            const xml = classifyXml(part.text)
            if (xml.isXml) {
              return (
                <XmlContent
                  key={`text-${index}`}
                  tag={xml.tag}
                  content={xml.content}
                  onSelectSubagent={onSelectSubagent}
                />
              )
            }
            return <MarkdownContent key={`text-${index}`}>{part.text}</MarkdownContent>
          }
          if (part.type === "thinking")
            return (
              <ThinkingBlock
                key={`thinking-${index}`}
                redacted={part.redacted === true}
                content={part.thinking}
                streaming={streaming}
                latest={latest}
              />
            )
          if (part.type === "toolCall") {
            const activity = toolActivities[part.id]
            const subagentId = subagentIdFromTool(part.name, part.arguments, activity?.result)
            return (
              <ToolBlock
                key={part.id}
                label={toolLabel(part.name)}
                detail={JSON.stringify(part.arguments, null, 2)}
                extra={toolDetail(part.name, part.arguments)}
                activity={activity}
                ansi={part.name === "bash"}
                subagent={
                  subagentId && onSelectSubagent
                    ? { id: subagentId, onSelect: onSelectSubagent }
                    : undefined
                }
                subagentTool={SUBAGENT_TOOL_NAMES.has(part.name)}
              />
            )
          }
          return null
        })}
        {message.errorMessage ? (
          <div className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
            {message.errorMessage}
          </div>
        ) : null}
      </div>
    )
  }
  if (message.role === "toolResult") {
    const detail = textContent(message.content)
    const subagentId = subagentIdFromTool(message.toolName, undefined, detail)
    return (
      <ToolBlock
        label={`${toolLabel(message.toolName)} · 返回`}
        detail={detail}
        error={message.isError}
        autoOpen={shouldAutoExpandToolResult(detail)}
        ansi={message.toolName === "bash"}
        subagent={
          subagentId && onSelectSubagent
            ? { id: subagentId, onSelect: onSelectSubagent }
            : undefined
        }
        subagentTool={SUBAGENT_TOOL_NAMES.has(message.toolName)}
      />
    )
  }

  const custom = message as unknown as Record<string, unknown>
  if (message.role === "bashExecution") {
    const cmd = displayValue(custom.command)
    const detail = `$ ${cmd}\n${displayValue(custom.output)}`
    return (
      <ToolBlock
        label="终端命令"
        detail={detail}
        error={typeof custom.exitCode === "number" && custom.exitCode !== 0}
        extra={cmd.length > 50 ? `${cmd.slice(0, 50)}…` : cmd || null}
        autoOpen={shouldAutoExpandToolResult(detail)}
        ansi
      />
    )
  }
  return (
    <MarkdownContent>
      {textContent(custom.content) || displayValue(custom.summary) || "系统消息"}
    </MarkdownContent>
  )
}

function stringifyToolOutput(value: unknown): string {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function useElapsed(activity?: AgentToolActivity): string {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (activity?.status !== "running") return
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [activity?.status])
  if (!activity) return ""
  const end = activity.status === "running" ? now : Date.parse(activity.updatedAt)
  const seconds = Math.max(0, Math.floor((end - Date.parse(activity.startedAt)) / 1_000))
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

export function MessageMeta({
  role,
  timestamp,
}: {
  role: AgentMessage["role"]
  timestamp: string
}): React.ReactElement {
  return (
    <div className="mb-1.5 flex items-center gap-2 text-[11px] text-muted-foreground">
      <span className="font-bold tracking-wider uppercase">{roleLabel(role)}</span>
      <time>{timestamp}</time>
    </div>
  )
}

/** XML/HTML 内容按标签语义化展示。 */
function XmlContent({
  tag,
  content,
  onSelectSubagent,
}: {
  tag: string | null
  content: string
  onSelectSubagent?: (id: string) => void
}): React.ReactElement {
  const parsed = parseXmlContent(content)

  switch (tag) {
    case "challenge_context":
      return <ChallengeContextCard parsed={parsed} />
    case "challenge_announcements":
      return <AnnouncementsCard parsed={parsed} />
    case "challenge_blackboard":
      return (
        <JsonCard
          parsed={parsed}
          icon="lucide:clipboard-check"
          iconColor="text-info"
          title="Blackboard"
        />
      )
    case "active_subagents":
      return (
        <JsonCard
          parsed={parsed}
          icon="lucide:network"
          iconColor="text-primary"
          title="Active SubAgents"
        />
      )
    case "blocked_finalization":
      return <BlockedFinalizationCard parsed={parsed} />
    case "task-notification":
      return (
        <JsonCard
          parsed={parsed}
          icon="lucide:bell"
          iconColor="text-warning"
          title="SubAgent Notification"
        />
      )
    case "subagent_notification":
      return <SubagentNotificationCard parsed={parsed} onSelectSubagent={onSelectSubagent} />
    default:
      return <GenericXmlCard tag={tag} content={content} />
  }
}

function BlockedFinalizationCard({
  parsed,
}: {
  parsed: ReturnType<typeof parseXmlContent>
}): React.ReactElement {
  const content = parsed.content
    .replace(/^<blocked_finalization\b[^>]*>\s*/i, "")
    .replace(/\s*<\/blocked_finalization>\s*$/i, "")
    .replace(/<active_subagents\b[^>]*>[\s\S]*?<\/active_subagents>\s*/i, "")
    .trim()
  return (
    <div className="overflow-hidden rounded-lg border border-warning/30 bg-warning/5">
      <div className="flex items-center gap-2 border-b border-warning/20 px-3 py-2">
        <Icon icon="lucide:circle-alert" width="14" className="text-warning" aria-hidden="true" />
        <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
          Blocked Finalization
        </span>
      </div>
      <div className="px-3 py-2.5 text-sm text-muted-foreground">
        <MarkdownContent>{content}</MarkdownContent>
      </div>
    </div>
  )
}
/** <challenge_context> 卡片：题目概览 */
function ChallengeContextCard({
  parsed,
}: {
  parsed: ReturnType<typeof parseXmlContent>
}): React.ReactElement {
  const c = parsed.children
  const title = c.title ?? c.name ?? ""
  const category = c.category ?? ""
  const score = c.score ?? c.points ?? ""
  const description = c.description ?? c.details ?? c.summary ?? ""
  const files =
    c.attachments ??
    c.files ??
    Object.entries(c)
      .filter(([k]) => k.toLowerCase().includes("file") || k === "attachment")
      .map(([, v]) => v)
      .join(", ")

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border bg-muted/50 px-3 py-2">
        <Icon icon="lucide:target" width="14" className="text-primary" aria-hidden="true" />
        <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
          Challenge Context
        </span>
        {category ? <Badge className="ml-auto text-[9px]">{category}</Badge> : null}
      </div>
      <div className="space-y-2 p-3">
        {title ? <h4 className="text-sm font-semibold text-foreground">{title}</h4> : null}
        {score ? (
          <span className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-2 py-0.5 font-mono text-xs font-medium text-primary">
            <Icon icon="lucide:star" width="11" aria-hidden="true" />
            {score} pts
          </span>
        ) : null}
        {description ? (
          <p className="text-xs leading-relaxed text-muted-foreground">
            {description.length > 300 ? `${description.slice(0, 300)}…` : description}
          </p>
        ) : null}
        {files ? (
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Icon icon="lucide:paperclip" width="12" aria-hidden="true" />
            {files}
          </div>
        ) : null}
      </div>
    </div>
  )
}

/** <challenge_announcements> 卡片：公告列表 */
function AnnouncementsCard({
  parsed,
}: {
  parsed: ReturnType<typeof parseXmlContent>
}): React.ReactElement {
  // 公告以 <announcement> 子元素形式出现，从原始内容用正则提取完整块
  const raw = parsed.content
  const annRegex =
    /<announcement\b[^>]*key="([^"]*)"[^>]*published_at="([^"]*)"[^>]*kind="([^"]*)"[^>]*>[\s\S]*?<title>([\s\S]*?)<\/title>[\s\S]*?<content>([\s\S]*?)<\/content>[\s\S]*?<\/announcement>/g
  const entries: Array<{
    key: string
    publishedAt: string
    kind: string
    title: string
    content: string
  }> = []
  let m = annRegex.exec(raw)
  while (m !== null) {
    const key = m[1]
    const publishedAt = m[2]
    const kind = m[3]
    const title = m[4]
    const content = m[5]
    if (!key || !publishedAt || !kind || !title || !content) {
      m = annRegex.exec(raw)
      continue
    }
    entries.push({
      key,
      publishedAt,
      kind,
      title: title.trim(),
      content: content.trim(),
    })
    m = annRegex.exec(raw)
  }

  if (entries.length === 0) {
    return (
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <div className="flex items-center gap-2 border-b border-border bg-muted/50 px-3 py-2">
          <Icon
            icon="lucide:megaphone"
            width="14"
            className="text-muted-foreground"
            aria-hidden="true"
          />
          <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
            Announcements
          </span>
        </div>
        <p className="px-3 py-4 text-center text-xs text-muted-foreground">暂无公告</p>
      </div>
    )
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border bg-muted/50 px-3 py-2">
        <Icon icon="lucide:megaphone" width="14" className="text-info" aria-hidden="true" />
        <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
          Announcements
        </span>
        <Badge className="ml-auto text-[9px]">{entries.length}</Badge>
      </div>
      <div className="divide-y divide-border/50">
        {entries.map((ann) => (
          <div key={ann.key} className="space-y-1 px-3 py-2.5">
            <div className="flex items-center gap-2">
              <Badge className="text-[9px]">{ann.kind}</Badge>
              <span className="text-xs font-medium text-foreground">{ann.title}</span>
              <time
                dateTime={ann.publishedAt}
                className="ml-auto text-[10px] text-muted-foreground"
              >
                {absoluteTime(ann.publishedAt)}
              </time>
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {ann.content.length > 200 ? `${ann.content.slice(0, 200)}…` : ann.content}
            </p>
          </div>
        ))}
      </div>
    </div>
  )
}

/** JSON 编码的 XML 块（blackboard、subagents、旧 task-notification） */
function JsonCard({
  parsed,
  icon,
  iconColor,
  title,
}: {
  parsed: ReturnType<typeof parseXmlContent>
  icon: string
  iconColor: string
  title: string
}): React.ReactElement {
  // 尝试解析 JSON 内容
  const innerText = parsed.content.replace(/<[^>]+>/g, "").trim()
  let jsonContent: string | null = null
  try {
    const parsed = JSON.parse(innerText)
    jsonContent = JSON.stringify(parsed, null, 2)
  } catch {
    jsonContent = innerText || null
  }

  return (
    <Collapsible className="overflow-hidden rounded-lg border border-border bg-card">
      <CollapsibleTrigger className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-xs font-semibold text-muted-foreground hover:text-foreground">
        <Icon icon={icon} width="15" className={iconColor} aria-hidden="true" />
        <span className="min-w-0 flex-1 text-left">{title}</span>
        <Icon icon="lucide:chevron-down" className="shrink-0" width="14" aria-hidden="true" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre className="overflow-x-auto border-t border-border px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground">
          {jsonContent ?? "（无法解析内容）"}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  )
}

function SubagentNotificationCard({
  parsed,
  onSelectSubagent,
}: {
  parsed: ReturnType<typeof parseXmlContent>
  onSelectSubagent?: (id: string) => void
}): React.ReactElement {
  const raw = parsed.children
  const {
    id = "",
    role = "SubAgent",
    status = "",
    output = "",
  } = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, decodeXmlText(value)]))
  return (
    <div className="overflow-hidden rounded-lg border border-primary/25 bg-primary/[0.035]">
      <div className="flex items-center gap-2 border-b border-primary/15 px-3 py-2">
        <span className="flex size-6 items-center justify-center rounded-md border border-primary/20 bg-primary/10 text-primary">
          <Icon icon="lucide:radio-tower" width="13" aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-xs font-semibold text-foreground">SubAgent 已回报</span>
          <span className="block truncate font-mono text-[10px] text-muted-foreground">
            {role} · {shortId(id)} {status ? `· ${status}` : ""}
          </span>
        </span>
        {id && onSelectSubagent ? (
          <button
            type="button"
            onClick={() => onSelectSubagent(id)}
            className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-primary outline-none transition-colors hover:bg-primary/10 focus-visible:ring-2 focus-visible:ring-ring"
          >
            打开对话
            <Icon icon="lucide:arrow-up-right" width="12" aria-hidden="true" />
          </button>
        ) : null}
      </div>
      <p className="px-3 py-2.5 text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground">
        {output || "SubAgent 未返回文本结果。"}
      </p>
    </div>
  )
}

function decodeXmlText(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&")
}

/** 通用 XML 卡片：带缩进美化的代码块 */
function GenericXmlCard({
  tag,
  content,
}: {
  tag: string | null
  content: string
}): React.ReactElement {
  let indent = 0
  const formatted = content
    .replace(/>\s*</g, ">\n<")
    .split("\n")
    .map((line) => {
      const t = line.trim()
      if (!t) return ""
      if (t.startsWith("</") || t.endsWith("/>") || t.startsWith("<?")) {
        if (t.startsWith("</")) indent = Math.max(0, indent - 1)
        return "  ".repeat(Math.max(0, indent)) + t
      }
      if (t.startsWith("<")) {
        const result = "  ".repeat(indent) + t
        if (!t.endsWith("/>") && !t.includes("</")) indent++
        return result
      }
      return "  ".repeat(indent) + t
    })
    .join("\n")

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-muted">
      <div className="flex items-center gap-1.5 border-b border-border px-3 py-1.5">
        <Icon
          icon="lucide:file-code-2"
          width="13"
          className="text-muted-foreground"
          aria-hidden="true"
        />
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {tag ?? "XML"}
        </span>
      </div>
      <pre className="overflow-x-auto px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre text-muted-foreground">
        {formatted}
      </pre>
    </div>
  )
}
