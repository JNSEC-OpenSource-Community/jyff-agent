import type { AgentMessage } from "@earendil-works/pi-agent-core"
import { TOOL_LABELS } from "./labels.ts"

export type TextPart = { type: "text"; text: string }

/** 把 Pi AgentMessage 的 content（字符串或 parts 数组）折叠为纯文本。 */
export function textContent(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .filter((part): part is TextPart =>
      Boolean(
        part &&
          typeof part === "object" &&
          (part as { type?: unknown }).type === "text" &&
          typeof (part as { text?: unknown }).text === "string",
      ),
    )
    .map((part) => part.text)
    .join("\n")
}

/** 消息气泡里显示的角色标签。 */
export function roleLabel(role: AgentMessage["role"]): string {
  if (role === "assistant") return "AGENT"
  if (role === "user") return "YOU / SYSTEM"
  return "TOOL"
}

/** 工具名称 -> 中文标签；未知工具原样返回。 */
export function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name
}
