import type { AgentMessage, AgentState, ThinkingLevel } from "@earendil-works/pi-agent-core"
import { completeSimple, type Message, type Model, type TextContent } from "@earendil-works/pi-ai/compat"

export interface CompactionMessage {
  role: "ctf_compaction"
  summary: string
  tokensBefore: number
  timestamp: number
}

declare module "@earendil-works/pi-agent-core" {
  interface CustomAgentMessages {
    ctf_compaction: CompactionMessage
  }
}

export interface CompactionOptions {
  enabled?: boolean
  reserveTokens?: number
  keepRecentTokens?: number
  /** 测试或特殊部署可替换摘要器；正常情况下使用当前 Pi model。 */
  summarize?: (conversation: string, signal?: AbortSignal) => Promise<string>
}

const DEFAULT_RESERVE = 16_384
const DEFAULT_KEEP_RECENT = 20_000
const TOOL_RESULT_LIMIT = 2_000

function textContent(content: Array<{ type: string; text?: string }>): string {
  return content.filter((item) => item.type === "text").map((item) => item.text ?? "").join("\n")
}

export function estimateMessageTokens(message: AgentMessage): number {
  let characters = 0
  switch (message.role) {
    case "user":
      characters = typeof message.content === "string" ? message.content.length : textContent(message.content)
        .length + message.content.filter((item) => item.type === "image").length * 4_800
      break
    case "assistant":
      for (const item of message.content) {
        if (item.type === "text") characters += item.text.length
        else if (item.type === "thinking") characters += item.thinking.length
        else if (item.type === "toolCall") characters += item.name.length + JSON.stringify(item.arguments).length
      }
      break
    case "toolResult":
      characters = textContent(message.content).length
      break
    case "ctf_compaction":
      characters = message.summary.length
      break
  }
  return Math.ceil(characters / 4)
}

export function estimateContextTokens(messages: readonly AgentMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0)
}

function budgets(model: Model<any> | undefined, options: CompactionOptions): { reserve: number; keepRecent: number } {
  const contextWindow = model?.contextWindow ?? 128_000
  // 小上下文模型不能直接使用 Pi 的 16k/20k 默认值，否则会永远触发 compact。
  const reserve = Math.min(options.reserveTokens ?? DEFAULT_RESERVE, Math.max(1, Math.floor(contextWindow * 0.2)))
  const keepRecent = Math.min(options.keepRecentTokens ?? DEFAULT_KEEP_RECENT, Math.max(1, contextWindow - reserve))
  return { reserve, keepRecent }
}

export function shouldCompact(state: Pick<AgentState, "model" | "messages">, options: CompactionOptions = {}): boolean {
  if (options.enabled === false) return false
  const { reserve } = budgets(state.model, options)
  return estimateContextTokens(state.messages) > state.model.contextWindow - reserve
}

/** 只在 user message 前截断，绝不把 toolResult 与发起它的 turn 分开。 */
export function findCompactionCut(messages: readonly AgentMessage[], keepRecentTokens: number): number {
  let keptTokens = 0
  let safeCut = messages.length
  for (let index = messages.length - 1; index >= 0; index--) {
    const next = keptTokens + estimateMessageTokens(messages[index]!)
    if (next > keepRecentTokens) return safeCut
    keptTokens = next
    if (messages[index]!.role === "user" && index > 0) safeCut = index
  }
  return messages.length
}

function truncate(value: string): string {
  return value.length <= TOOL_RESULT_LIMIT ? value : `${value.slice(0, TOOL_RESULT_LIMIT)}\n[truncated ${value.length - TOOL_RESULT_LIMIT} chars]`
}

export function serializeForCompaction(messages: readonly AgentMessage[]): string {
  return messages.map((message) => {
    switch (message.role) {
      case "user": return `[User]: ${typeof message.content === "string" ? message.content : textContent(message.content)}`
      case "assistant": return message.content.map((item) => {
        if (item.type === "text") return `[Assistant]: ${item.text}`
        if (item.type === "thinking") return `[Assistant thinking]: ${item.thinking}`
        if (item.type === "toolCall") return `[Assistant tool call]: ${item.name}(${JSON.stringify(item.arguments)})`
        return ""
      }).filter(Boolean).join("\n")
      case "toolResult": return `[Tool result:${message.toolName}]: ${truncate(textContent(message.content))}`
      case "ctf_compaction": return `[Previous summary]: ${message.summary}`
    }
  }).join("\n\n")
}

function prompt(conversation: string, customInstructions?: string): string {
  return [
    "Summarize this CTF-solving conversation. Do not continue the conversation.",
    "Preserve the current goal, challenge facts, discovered flags, downloaded files, commands/results, unresolved hypotheses, and next steps.",
    "Use headings: Goal, Progress, Key Findings, Workspace, Next Steps.",
    customInstructions ? `Additional focus: ${customInstructions}` : "",
    "Conversation:",
    conversation,
  ].filter(Boolean).join("\n\n")
}

export async function compactMessages(
  state: Pick<AgentState, "model" | "thinkingLevel" | "messages">,
  options: CompactionOptions = {},
  signal?: AbortSignal,
  customInstructions?: string,
  force = false,
): Promise<AgentMessage[] | undefined> {
  const { keepRecent } = budgets(state.model, options)
  // 手动压缩优先保留最新完整 user turn；只有一个 turn 时允许把全部历史变成摘要。
  const latestTurn = [...state.messages].map((message, index) => ({ message, index })).reverse()
    .find(({ message, index }) => message.role === "user" && index > 0)?.index
  const cut = force ? (latestTurn ?? state.messages.length) : findCompactionCut(state.messages, keepRecent)
  if (cut === 0 || (!force && cut === state.messages.length)) return undefined
  const conversation = serializeForCompaction(state.messages.slice(0, cut))
  if (!conversation.trim()) return undefined

  let summary: string
  if (options.summarize) {
    summary = await options.summarize(conversation, signal)
  } else {
    const response = await completeSimple(state.model, {
      systemPrompt: "You are a precise conversation summarizer.",
      messages: [{ role: "user", content: prompt(conversation, customInstructions), timestamp: Date.now() }],
    }, {
      signal,
      reasoning: state.thinkingLevel === "off" ? "low" : state.thinkingLevel as Exclude<ThinkingLevel, "off">,
    })
    summary = response.content.filter((item: unknown): item is TextContent => typeof item === "object" && item !== null && (item as { type?: unknown }).type === "text").map((item) => item.text).join("\n")
  }
  if (!summary.trim()) throw new Error("上下文压缩没有生成摘要")

  const compacted: CompactionMessage = {
    role: "ctf_compaction",
    summary,
    tokensBefore: estimateContextTokens(state.messages),
    timestamp: Date.now(),
  }
  return [compacted, ...state.messages.slice(cut)]
}

export function convertSolverMessages(messages: AgentMessage[]): Message[] {
  return messages.flatMap((message): Message[] => {
    if (message.role === "ctf_compaction") {
      return [{ role: "user", content: `<summary>Previous conversation summary (${message.tokensBefore} tokens):\n${message.summary}</summary>`, timestamp: message.timestamp }]
    }
    return [message as Message]
  })
}
