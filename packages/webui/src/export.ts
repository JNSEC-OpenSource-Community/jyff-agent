import type { RunEvent, RunRecord } from "@ctf-agent/project"
import type { DashboardProject } from "./types.ts"

export interface SessionExportOptions {
  /** 只导出指定 run;缺省导出该题全部 run(按 created_at 升序)。 */
  runId?: string
  /** true 时保留明文敏感信息(flag、完整工具参数/结果);缺省脱敏。 */
  full?: boolean
}

/** 脱敏时 bash 命令与工具结果的截断长度(文档级;存储层另有 8000 截断)。 */
const REDACTED_TRUNCATE = 500

/** 常见 flag 包裹格式(大小写不敏感),文档级脱敏用。 */
const FLAG_PATTERN = /\b(?:myctf|flag|ctf|ltctf|mock|gctf)\{[^}\n]{1,400}\}/gi

/**
 * 构建某题会话复盘 Markdown:元信息 + token 汇总 + 按事件序的时间线。
 * 思维链(agent_thinking)按事件 id 序拼接为完整文本;token 消耗来自 agent_usage
 * 事件(历史 run 无此数据时标注)。默认脱敏,full=true 保留明文。
 */
export function buildSessionMarkdown(
  project: DashboardProject,
  challengeId: string,
  options: SessionExportOptions = {},
): string {
  const { runId, full = false } = options
  const runs = project.runs({ challengeId })
  const selected = runId ? runs.filter((run) => run.id === runId) : runs

  const lines: string[] = [
    `# CTF Agent 会话复盘：${challengeId}`,
    "",
    `- 导出时间：${new Date().toISOString()}`,
    `- Run 数：${selected.length}${runId ? `（指定 ${runId}）` : ""}`,
    `- 脱敏：${full ? "否（含明文敏感信息）" : "是（flag 已替换、bash 命令已截断）"}`,
    "",
  ]
  for (const run of selected) {
    lines.push(...renderRun(project, run, full))
  }

  let markdown = lines.join("\n")
  if (!full) markdown = redactFlags(markdown)
  return markdown
}

function renderRun(project: DashboardProject, run: RunRecord, full: boolean): string[] {
  const events = project.runEvents(run.id)
  const parts: string[] = [
    `## Run ${shortId(run.id)}（attempt ${run.attempt} · ${run.status}）`,
    "",
    "| 字段 | 值 |",
    "|---|---|",
    `| Run ID | \`${run.id}\` |`,
    `| 题目 | ${run.challengeId} |`,
    `| 来源 | ${run.source} |`,
    `| 状态 | ${run.status}${run.closeReason ? `（${run.closeReason}）` : ""} |`,
    `| 错误 | ${run.error ? escapeMarkdownCell(run.error) : "—"} |`,
    `| 创建 | ${run.createdAt} |`,
    `| 开始 | ${run.startedAt ?? "—"} |`,
    `| 结束 | ${run.finishedAt ?? "—"} |`,
    `| 耗时 | ${duration(run.startedAt, run.finishedAt)} |`,
    "",
    "### Token 消耗",
    "",
    ...usageSection(events),
    "### 时间线",
    "",
    ...timelineSection(events, full),
  ]
  return parts
}

function usageSection(events: RunEvent[]): string[] {
  const usages = events
    .filter((event) => event.type === "agent_usage")
    .map((event) => event.data as UsageData | undefined)
    .filter((data): data is UsageData => data !== undefined)

  if (usages.length === 0) {
    return ["（无记录——该 run 运行于用量记录功能之前，或 provider 未返回 usage）", ""]
  }

  const total = {
    input: sum(usages, (u) => u.input),
    output: sum(usages, (u) => u.output),
    cacheRead: sum(usages, (u) => u.cacheRead),
    cacheWrite: sum(usages, (u) => u.cacheWrite),
    reasoning: sum(usages, (u) => u.reasoning ?? 0),
    totalTokens: sum(usages, (u) => u.totalTokens),
    cost: sum(usages, (u) => u.cost.total),
  }

  const lines: string[] = [
    "| 轮次 | input | output | cacheRead | cacheWrite | reasoning | tokens | cost |",
    "|---|---|---|---|---|---|---|---|",
  ]
  usages.forEach((usage, index) => {
    lines.push(`| ${index + 1} | ${usage.input} | ${usage.output} | ${usage.cacheRead} | ${usage.cacheWrite} | ${usage.reasoning ?? "—"} | ${usage.totalTokens} | $${formatCost(usage.cost.total)} |`)
  })
  lines.push(
    `| **合计** | **${total.input}** | **${total.output}** | **${total.cacheRead}** | **${total.cacheWrite}** | **${total.reasoning}** | **${total.totalTokens}** | **$${formatCost(total.cost)}** |`,
    "",
  )
  return lines
}

function timelineSection(events: RunEvent[], full: boolean): string[] {
  const out: string[] = []
  let thinking: string[] = []

  const flushThinking = (): void => {
    if (thinking.length === 0) return
    out.push("**思维链：**", "", thinking.join(""), "")
    thinking = []
  }

  for (const event of events) {
    const data = event.data as Record<string, unknown> | undefined
    switch (event.type) {
      case "agent_thinking":
        thinking.push(typeof data?.text === "string" ? data.text : "")
        break
      case "agent_message": {
        flushThinking()
        const text = typeof data?.text === "string" ? data.text : ""
        if (text) out.push("**Agent 回复：**", "", text, "")
        break
      }
      case "human_message": {
        flushThinking()
        const text = typeof data?.text === "string" ? data.text : ""
        out.push(`- 👤 **人工消息**：${text}`, "")
        break
      }
      case "tool_started": {
        flushThinking()
        const toolName = typeof data?.toolName === "string" ? data.toolName : "unknown"
        out.push(`- 🔧 **${toolName}** — ${renderArgs(data?.args, toolName, full)}`, "")
        break
      }
      case "tool_finished": {
        flushThinking()
        const toolName = typeof data?.toolName === "string" ? data.toolName : "unknown"
        const isError = data?.isError === true
        const result = typeof data?.result === "string" ? data.result : undefined
        const rendered = result === undefined
          ? "（结果未记录，遥测级别非 full）"
          : renderToolResult(result, toolName, full)
        out.push(`  → ${isError ? "✗" : "✓"} ${rendered}`, "")
        break
      }
      case "flag_submitted": {
        flushThinking()
        const flag = typeof data?.flag === "string" ? data.flag : "?"
        const status = typeof data?.status === "string" ? data.status : "unknown"
        const message = typeof data?.message === "string" && data.message ? `（${data.message}）` : ""
        out.push(`- 🏁 **提交 Flag**：\`${flag}\` — ${status}${message}`, "")
        break
      }
      case "agent_usage": {
        flushThinking()
        const usage = data as UsageData | undefined
        if (usage) {
          out.push(
            `- 📊 **用量**：input ${usage.input} / output ${usage.output} / cache ${usage.cacheRead}+${usage.cacheWrite} / reasoning ${usage.reasoning ?? "—"} / $${formatCost(usage.cost.total)}`,
            "",
          )
        }
        break
      }
      default:
        // run_created/run_started/run_finished/agent_started 等元信息已由表格覆盖,跳过。
        break
    }
  }
  flushThinking()
  return out
}

interface UsageData {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning?: number
  totalTokens: number
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }
}

function renderArgs(args: unknown, toolName: string, full: boolean): string {
  if (args === undefined) return "—"
  let text = JSON.stringify(args)
  if (!full && toolName === "bash" && text.length > REDACTED_TRUNCATE) {
    text = text.slice(0, REDACTED_TRUNCATE) + "…[截断]"
  }
  return "`" + text.slice(0, 2_000) + "`"
}

function renderToolResult(result: string, _toolName: string, full: boolean): string {
  let text = result
  if (!full && text.length > REDACTED_TRUNCATE) {
    text = text.slice(0, REDACTED_TRUNCATE) + "…[截断]"
  }
  const lines = text.split("\n")
  return lines.length <= 6 ? text : `${lines.slice(0, 6).join("\n")}\n…（共 ${lines.length} 行）`
}

/** 文档级 flag 脱敏:full=0 时覆盖所有位置(思维链/消息/工具结果)。 */
function redactFlags(markdown: string): string {
  return markdown.replace(FLAG_PATTERN, "[redacted]")
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id
}

function duration(startedAt: string | undefined, finishedAt: string | undefined): string {
  if (!startedAt || !finishedAt) return "—"
  const ms = Date.parse(finishedAt) - Date.parse(startedAt)
  if (Number.isNaN(ms) || ms < 0) return "—"
  const seconds = Math.round(ms / 1000)
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = seconds % 60
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`
  return `${minutes}:${String(rest).padStart(2, "0")}`
}

function formatCost(value: number): string {
  if (!Number.isFinite(value)) return "—"
  if (value === 0) return "0"
  return value < 0.0001 ? value.toExponential(2) : value.toFixed(4)
}

function escapeMarkdownCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ")
}

function sum(usages: UsageData[], pick: (usage: UsageData) => number): number {
  return usages.reduce((acc, usage) => acc + pick(usage), 0)
}
