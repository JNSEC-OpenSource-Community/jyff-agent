import type { AgentMessage } from "@earendil-works/pi-agent-core"
import { Icon } from "@iconify/react"
import {
  Badge,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../../components/index.ts"
import { roleLabel, textContent, toolLabel } from "../../lib/conversation.ts"
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
  const innerMatch = trimmed.match(
    new RegExp(`<${escaped}[^>]*>([\\s\\S]*)<\\/${escaped}>`),
  )
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
        const cmd = String(a.command ?? a.cmd ?? "")
        return cmd.length > 60 ? `${cmd.slice(0, 60)}…` : cmd || null
      }
      case "read":
      case "edit": {
        const fp = String(a.path ?? a.file_path ?? a.filePath ?? "")
        if (!fp) return null
        // 只显示文件名
        const name = fp.split(/[/\\]/).pop() ?? fp
        return name.length > 40 ? `${name.slice(0, 40)}…` : name
      }
      case "write": {
        const fp = String(a.path ?? a.file_path ?? a.filePath ?? "")
        if (!fp) return null
        const name = fp.split(/[/\\]/).pop() ?? fp
        return name.length > 40 ? `${name.slice(0, 40)}…` : name
      }
      case "list": {
        const dir = String(a.path ?? a.directory ?? a.dir ?? "")
        return dir || null
      }
      case "ctf_submit_flag": {
        const flag = String(a.flag ?? "")
        return flag ? `🚩 ${flag.slice(0, 24)}…` : null
      }
      case "Agent": {
        const role = String(a.role ?? a.subagent ?? "")
        return role || null
      }
      default:
        return null
    }
  } catch {
    return null
  }
}

function ToolBlock({
  label,
  detail,
  error,
  extra,
}: {
  label: string
  detail: string
  error?: boolean
  extra?: string | null
}): React.ReactElement {
  return (
    <Collapsible
      className={cn(
        "overflow-hidden rounded-lg border transition-colors",
        error ? "border-danger/30 bg-danger/5" : "border-border bg-muted",
      )}
    >
      <CollapsibleTrigger className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-xs font-semibold text-muted-foreground hover:text-foreground">
        <Icon icon={error ? "lucide:circle-x" : "lucide:terminal"} width="16" />
        <span className="min-w-0 flex-1 truncate text-left">
          {label}
          {extra ? (
            <span className="ml-1.5 font-normal text-muted-foreground/70">
              {extra}
            </span>
          ) : null}
        </span>
        <Icon icon="lucide:chevron-down" className="shrink-0" width="15" />
      </CollapsibleTrigger>
      <CollapsibleContent className="border-t border-border">
        <pre className="overflow-x-auto px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground">
          {detail || "（无输出）"}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  )
}

function ThinkingBlock({
  redacted,
  content,
}: {
  redacted: boolean
  content: string
}): React.ReactElement {
  return (
    <Collapsible className="overflow-hidden rounded-lg bg-muted">
      <CollapsibleTrigger className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-xs font-semibold text-muted-foreground hover:text-foreground">
        <Icon icon="lucide:brain" width="15" /> 推理记录
        <Icon
          icon="lucide:chevron-down"
          className="ml-auto shrink-0"
          width="14"
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="px-3 pb-2 text-sm whitespace-pre-wrap text-muted-foreground">
        {redacted ? "推理内容已由模型提供方隐藏。" : content}
      </CollapsibleContent>
    </Collapsible>
  )
}

export function MessageBody({
  message,
}: {
  message: AgentMessage
}): React.ReactElement {
  if (message.role === "user") {
    const raw = textContent(message.content)
    const xml = classifyXml(raw)
    if (xml.isXml) {
      return <XmlContent tag={xml.tag} content={xml.content} />
    }
    return <div className="whitespace-pre-wrap text-sm">{raw}</div>
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
                />
              )
            }
            return (
              <div
                className="whitespace-pre-wrap text-sm"
                key={`text-${index}`}
              >
                {part.text}
              </div>
            )
          }
          if (part.type === "thinking")
            return (
              <ThinkingBlock
                key={`thinking-${index}`}
                redacted={part.redacted === true}
                content={part.thinking}
              />
            )
          if (part.type === "toolCall")
            return (
              <ToolBlock
                key={part.id}
                label={toolLabel(part.name)}
                detail={JSON.stringify(part.arguments, null, 2)}
                extra={toolDetail(part.name, part.arguments)}
              />
            )
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
    return (
      <ToolBlock
        label={`${toolLabel(message.toolName)} · 返回`}
        detail={textContent(message.content)}
        error={message.isError}
      />
    )
  }

  const custom = message as unknown as Record<string, unknown>
  if (message.role === "bashExecution") {
    const cmd = String(custom.command ?? "")
    return (
      <ToolBlock
        label="终端命令"
        detail={`$ ${cmd}\n${String(custom.output ?? "")}`}
        error={typeof custom.exitCode === "number" && custom.exitCode !== 0}
        extra={cmd.length > 50 ? `${cmd.slice(0, 50)}…` : cmd || null}
      />
    )
  }
  return (
    <div className="whitespace-pre-wrap text-sm">
      {textContent(custom.content) || String(custom.summary ?? "系统消息")}
    </div>
  )
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
      <span className="font-bold tracking-wider uppercase">
        {roleLabel(role)}
      </span>
      <time>{timestamp}</time>
    </div>
  )
}

/** XML/HTML 内容按标签语义化展示。 */
function XmlContent({
  tag,
  content,
}: {
  tag: string | null
  content: string
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
    case "task-notification":
      return (
        <JsonCard
          parsed={parsed}
          icon="lucide:bell"
          iconColor="text-warning"
          title="SubAgent Notification"
        />
      )
    default:
      return <GenericXmlCard tag={tag} content={content} />
  }
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
    [...Object.entries(c)]
      .filter(([k]) => k.toLowerCase().includes("file") || k === "attachment")
      .map(([, v]) => v)
      .join(", ")

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border bg-muted/50 px-3 py-2">
        <Icon icon="lucide:target" width="14" className="text-primary" />
        <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
          Challenge Context
        </span>
        {category ? (
          <Badge className="ml-auto text-[9px]">{category}</Badge>
        ) : null}
      </div>
      <div className="space-y-2 p-3">
        {title ? (
          <h4 className="text-sm font-semibold text-foreground">{title}</h4>
        ) : null}
        {score ? (
          <span className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-2 py-0.5 font-mono text-xs font-medium text-primary">
            <Icon icon="lucide:star" width="11" />
            {score} pts
          </span>
        ) : null}
        {description ? (
          <p className="text-xs leading-relaxed text-muted-foreground">
            {description.length > 300
              ? `${description.slice(0, 300)}…`
              : description}
          </p>
        ) : null}
        {files ? (
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Icon icon="lucide:paperclip" width="12" />
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
          />
          <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
            Announcements
          </span>
        </div>
        <p className="px-3 py-4 text-center text-xs text-muted-foreground">
          暂无公告
        </p>
      </div>
    )
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border bg-muted/50 px-3 py-2">
        <Icon icon="lucide:megaphone" width="14" className="text-info" />
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
              <span className="text-xs font-medium text-foreground">
                {ann.title}
              </span>
              <time className="ml-auto text-[10px] text-muted-foreground">
                {ann.publishedAt}
              </time>
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {ann.content.length > 200
                ? `${ann.content.slice(0, 200)}…`
                : ann.content}
            </p>
          </div>
        ))}
      </div>
    </div>
  )
}

/** JSON 编码的 XML 块（blackboard、subagents、task-notification） */
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
        <Icon icon={icon} width="15" className={iconColor} />
        <span className="min-w-0 flex-1 text-left">{title}</span>
        <Icon icon="lucide:chevron-down" className="shrink-0" width="14" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre className="overflow-x-auto border-t border-border px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground">
          {jsonContent ?? "（无法解析内容）"}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  )
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
