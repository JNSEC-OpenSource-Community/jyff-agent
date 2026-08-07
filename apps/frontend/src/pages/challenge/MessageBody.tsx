import type { AgentMessage } from "@earendil-works/pi-agent-core"
import { Icon } from "@iconify/react"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../../components/index.ts"
import { roleLabel, textContent, toolLabel } from "../../lib/conversation.ts"

function ToolBlock({
  label,
  detail,
  error,
}: {
  label: string
  detail: string
  error?: boolean
}): React.ReactElement {
  return (
    <Collapsible
      className={
        error
          ? "border-danger/30 bg-danger/5 rounded-md border"
          : "border-border rounded-md border"
      }
    >
      <CollapsibleTrigger className="text-muted-foreground hover:text-foreground flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-xs font-semibold">
        <Icon icon={error ? "lucide:circle-x" : "lucide:terminal"} width="16" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <Icon icon="lucide:chevron-down" className="shrink-0" width="15" />
      </CollapsibleTrigger>
      <CollapsibleContent className="border-border/60 border-t">
        <pre className="text-muted-foreground overflow-x-auto px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap">
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
    <Collapsible className="bg-muted/40 rounded-md">
      <CollapsibleTrigger className="text-muted-foreground hover:text-foreground flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-xs font-semibold">
        <Icon icon="lucide:brain" width="15" /> 推理记录
        <Icon
          icon="lucide:chevron-down"
          className="ml-auto shrink-0"
          width="14"
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="text-muted-foreground px-3 pb-2 text-sm whitespace-pre-wrap">
        {redacted ? "推理内容已由模型提供方隐藏。" : content}
      </CollapsibleContent>
    </Collapsible>
  )
}

/** 单条 Agent 消息体：文本、推理、工具调用与结果的分段渲染。 */
export function MessageBody({
  message,
}: {
  message: AgentMessage
}): React.ReactElement {
  if (message.role === "user") {
    return (
      <div className="text-sm whitespace-pre-wrap">
        {textContent(message.content)}
      </div>
    )
  }
  if (message.role === "assistant") {
    return (
      <div className="flex flex-col gap-2">
        {message.content.map((part, index) => {
          if (part.type === "text")
            return (
              <div
                className="text-sm whitespace-pre-wrap"
                key={`text-${index}`}
              >
                {part.text}
              </div>
            )
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
              />
            )
          return null
        })}
        {message.errorMessage ? (
          <div className="text-danger rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm">
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
    return (
      <ToolBlock
        label="终端命令"
        detail={`$ ${String(custom.command ?? "")}\n${String(custom.output ?? "")}`}
        error={typeof custom.exitCode === "number" && custom.exitCode !== 0}
      />
    )
  }
  return (
    <div className="text-sm whitespace-pre-wrap">
      {textContent(custom.content) || String(custom.summary ?? "系统消息")}
    </div>
  )
}

/** 消息元信息（角色标签 + 时间）。 */
export function MessageMeta({
  role,
  timestamp,
}: {
  role: AgentMessage["role"]
  timestamp: string
}): React.ReactElement {
  return (
    <div className="text-muted-foreground mb-1 flex items-center gap-2 text-[11px]">
      <span className="font-bold tracking-wider">{roleLabel(role)}</span>
      <time>{timestamp}</time>
    </div>
  )
}
