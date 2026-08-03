// 工具需求收集器(确定性接收 agent):汇总 solver 上报的缺失工具,去重合并后
// 持久化为 .ctf-agent/toolsneed.json,供 WebUI 查看/下载 Markdown/清空。
//
// 设计约束:
// - 无 LLM 调用:record 同步更新内存态并立即返回状态,模型感知零延迟;
// - 持久化必须写串行化(writeChain):并发上报的 read-modify-write 若各自
//   tmp+rename 会互相覆盖丢失更新;内存态是唯一事实源,磁盘写只负责落盘;
// - 落盘失败静默(与 thinking/进度遥测同策略),不得影响 agent 生命周期。

import { readFile, rename, writeFile } from "node:fs/promises"

export interface ToolNeedReport {
  tool: string
  reason: string
}

export interface ToolNeedContext {
  challengeId: string
  title: string
  category: string
}

export interface ToolsNeedChallengeRef {
  challengeId: string
  title: string
  reportedAt: string
}

export interface ToolsNeedEntry {
  /** 规范化后的工具名(trim + 小写),同时是去重键。 */
  tool: string
  /** 首次上报该工具的题目分类(平台原始值,不规范化)。 */
  category: string
  firstReportedAt: string
  lastReportedAt: string
  reportCount: number
  /** 需求原因(按内容去重,最多保留 MAX_REASONS 条)。 */
  reasons: string[]
  /** 涉及题目(按 challengeId 去重)。 */
  challenges: ToolsNeedChallengeRef[]
}

export interface ToolsNeedView {
  updatedAt: string
  totalReports: number
  entries: ToolsNeedEntry[]
}

const MAX_REASONS = 10
const MAX_REASON_CHARS = 2_000
const FILE_VERSION = 1

interface ToolsNeedFile {
  version?: number
  updatedAt?: string
  entries?: unknown
}

export class ToolsNeedRegistry {
  private readonly path: string
  private entries: ToolsNeedEntry[] = []
  private updatedAt = ""
  private writeChain: Promise<void> = Promise.resolve()

  private constructor(path: string) {
    this.path = path
  }

  /** 读取既有文档;文件缺失/损坏一律退化为空表(收集链路不阻塞控制面启动)。 */
  static async open(filePath: string): Promise<ToolsNeedRegistry> {
    const registry = new ToolsNeedRegistry(filePath)
    try {
      const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const file = parsed as ToolsNeedFile
        if (Array.isArray(file.entries)) {
          registry.entries = file.entries
            .map((entry) => normalizeEntry(entry))
            .filter((entry): entry is ToolsNeedEntry => entry !== null)
        }
        if (typeof file.updatedAt === "string") registry.updatedAt = file.updatedAt
      }
    } catch {
      // 文件不存在或内容损坏 → 空表
    }
    return registry
  }

  /**
   * 记录一次上报。同题同工具重复上报返回 "duplicate" 且不产生任何更新;
   * 同工具跨题上报合并进同一条目。
   */
  record(report: ToolNeedReport, context: ToolNeedContext): "recorded" | "duplicate" {
    const tool = normalizeTool(report.tool)
    if (!tool) return "duplicate"
    const reason = normalizeReason(report.reason)
    const now = new Date().toISOString()
    const existing = this.entries.find((entry) => entry.tool === tool)
    if (existing) {
      if (existing.challenges.some((ref) => ref.challengeId === context.challengeId)) {
        return "duplicate"
      }
      existing.challenges.push({
        challengeId: context.challengeId,
        title: context.title,
        reportedAt: now,
      })
      existing.lastReportedAt = now
      existing.reportCount += 1
      if (reason && !existing.reasons.includes(reason)) {
        existing.reasons.push(reason)
        if (existing.reasons.length > MAX_REASONS) existing.reasons.shift()
      }
    } else {
      this.entries.push({
        tool,
        category: context.category,
        firstReportedAt: now,
        lastReportedAt: now,
        reportCount: 1,
        reasons: reason ? [reason] : [],
        challenges: [{ challengeId: context.challengeId, title: context.title, reportedAt: now }],
      })
    }
    this.updatedAt = now
    this.persist()
    return "recorded"
  }

  view(): ToolsNeedView {
    return {
      updatedAt: this.updatedAt,
      totalReports: this.entries.reduce((sum, entry) => sum + entry.reportCount, 0),
      entries: [...this.entries],
    }
  }

  /** 渲染为人类可读 Markdown 表格(下载/查看用)。 */
  markdown(): string {
    const lines = [
      "# 工具需求清单 (toolsneed)",
      "",
      `更新于：${this.updatedAt || "—"} · 累计上报 ${this.view().totalReports} 次 · ${this.entries.length} 个工具`,
      "",
      "| 工具 | 分类 | 上报次数 | 首次上报 | 最近上报 | 涉及题目 | 需求原因 |",
      "|---|---|---|---|---|---|---|",
    ]
    for (const entry of this.entries) {
      const challenges = entry.challenges
        .map((ref) => `${ref.title}(${ref.challengeId})`)
        .join("、")
      lines.push([
        escapeCell(entry.tool),
        escapeCell(entry.category),
        String(entry.reportCount),
        shortTime(entry.firstReportedAt),
        shortTime(entry.lastReportedAt),
        escapeCell(challenges),
        escapeCell(entry.reasons.join("；")),
      ].join(" | "))
    }
    if (this.entries.length === 0) {
      lines.push("暂无工具需求上报。", "")
    }
    return `${lines.join("\n")}\n`
  }

  /** 清空全部条目(手动清空入口)。 */
  async clear(): Promise<void> {
    this.entries = []
    this.updatedAt = new Date().toISOString()
    this.persist()
    await this.writeChain
  }

  /** 等待已排队的落盘全部完成(测试/同步入口;读取路径读内存态,无需等待)。 */
  async flush(): Promise<void> {
    await this.writeChain
  }

  /** 落盘:写串行化 + tmp+rename 原子替换(仿 persistRecord)。失败静默。 */
  private persist(): void {
    const snapshot = JSON.stringify({
      version: FILE_VERSION,
      updatedAt: this.updatedAt,
      entries: this.entries,
    }, null, 2)
    this.writeChain = this.writeChain
      .then(async () => {
        const temporary = `${this.path}.${process.pid}.tmp`
        await writeFile(temporary, `${snapshot}\n`, "utf8")
        await rename(temporary, this.path)
      })
      .catch(() => {
        // 收集链路落盘失败不阻塞 agent/控制面
      })
  }
}

function normalizeTool(tool: string): string {
  return tool.trim().toLowerCase().replace(/\s+/g, " ")
}

function normalizeReason(reason: string): string {
  const trimmed = reason.trim()
  if (!trimmed) return ""
  return trimmed.length > MAX_REASON_CHARS ? trimmed.slice(0, MAX_REASON_CHARS) : trimmed
}

function normalizeEntry(value: unknown): ToolsNeedEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const entry = value as Partial<ToolsNeedEntry>
  if (typeof entry.tool !== "string" || !entry.tool) return null
  return {
    tool: entry.tool,
    category: typeof entry.category === "string" ? entry.category : "",
    firstReportedAt: typeof entry.firstReportedAt === "string" ? entry.firstReportedAt : "",
    lastReportedAt: typeof entry.lastReportedAt === "string" ? entry.lastReportedAt : "",
    reportCount: Number.isInteger(entry.reportCount) && Number(entry.reportCount) > 0
      ? Number(entry.reportCount)
      : 1,
    reasons: Array.isArray(entry.reasons)
      ? entry.reasons.filter((reason): reason is string => typeof reason === "string").slice(0, MAX_REASONS)
      : [],
    challenges: Array.isArray(entry.challenges)
      ? entry.challenges
          .filter((ref): ref is ToolsNeedChallengeRef =>
            Boolean(ref && typeof ref === "object" && typeof (ref as ToolsNeedChallengeRef).challengeId === "string"))
          .map((ref) => ({
            challengeId: ref.challengeId,
            title: typeof ref.title === "string" ? ref.title : "",
            reportedAt: typeof ref.reportedAt === "string" ? ref.reportedAt : "",
          }))
      : [],
  }
}

function escapeCell(text: string): string {
  return text.replaceAll("|", "\\|").replaceAll("\n", " ")
}

function shortTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso || "—"
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
