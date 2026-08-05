import type { DashboardChallenge, DashboardChallengeStatus } from "../types.ts"

export const STATUS_LABELS: Record<DashboardChallengeStatus | string, string> =
  {
    queued: "队列中",
    pending: "未调度",
    preparing: "准备中",
    running: "执行中",
    solved: "已解出",
    failed: "失败",
    timed_out: "已超时",
    cancelled: "已取消",
    interrupted: "已中断",
    closed: "已关闭",
    completed: "已完成",
    aborted: "已终止",
  }

export const EVENT_LABELS: Record<string, string> = {
  run_created: "已创建本次尝试",
  run_started: "Agent 开始工作",
  agent_started: "模型开始推理",
  agent_thinking: "💭 思考",
  agent_usage: "本轮用量",
  thinking_level_update: "已切换思考强度",
  agent_message: "Agent 回复",
  human_message: "人工消息",
  tool_started: "开始执行工具",
  tool_finished: "工具执行完成",
  flag_submitted: "Flag 提交结果",
  run_finished: "本次尝试结束",
  run_interrupted: "运行异常中断",
  run_updated: "运行状态更新",
  subagent_created: "SubAgent 已创建",
  subagent_started: "SubAgent 开始工作",
  subagent_progress: "SubAgent 进度更新",
  subagent_completed: "SubAgent 已完成",
  subagent_failed: "SubAgent 执行失败",
  subagent_cancelled: "SubAgent 已取消",
  subagent_aborted: "SubAgent 已终止",
  subagent_steered: "已引导 SubAgent",
}

export const TOOL_LABELS: Record<string, string> = {
  bash: "终端命令",
  read: "读取文件",
  write: "写入文件",
  edit: "编辑文件",
  list: "浏览目录",
  ctf_submit_flag: "提交 Flag",
  ctf_instance_start: "启动远程环境",
  ctf_instance_destroy: "关闭远程环境",
  ctf_blackboard_read: "读取协作黑板",
  ctf_blackboard_record: "更新协作黑板",
  Agent: "派发 SubAgent",
  get_subagent_result: "读取 SubAgent 结果",
  steer_subagent: "引导 SubAgent",
  cancel_subagent: "取消 SubAgent",
  list_subagents: "列出 SubAgent",
}

export const SOURCE_LABELS: Record<string, string> = {
  direct: "直接调用",
  auto: "自主调度",
  manual: "人工调度",
  retry: "自动重试",
  test: "专项测试",
}

export async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const data = (await response.json()) as { message?: string; error?: string }
  if (!response.ok) {
    throw new Error(data.message || data.error || `HTTP ${response.status}`)
  }
  return data as T
}

export function controlPost<T>(url: string, body: unknown = {}): Promise<T> {
  return getJson<T>(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

export function relativeTime(value: string | null | undefined): string {
  if (!value) return "暂无"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "时间未知"
  const seconds = Math.round((date.getTime() - Date.now()) / 1_000)
  const absolute = Math.abs(seconds)
  const formatter = new Intl.RelativeTimeFormat("zh-CN", { numeric: "auto" })
  if (absolute < 60) return formatter.format(seconds, "second")
  if (absolute < 3_600)
    return formatter.format(Math.round(seconds / 60), "minute")
  if (absolute < 86_400)
    return formatter.format(Math.round(seconds / 3_600), "hour")
  return formatter.format(Math.round(seconds / 86_400), "day")
}

export function absoluteTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "时间未知"
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date)
}

export function objectData(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {}
}

export function matchesStatus(
  actual: DashboardChallengeStatus,
  filter: string,
): boolean {
  if (filter === "active") return actual === "preparing" || actual === "running"
  if (filter === "failed") {
    return ["failed", "timed_out", "cancelled", "interrupted"].includes(actual)
  }
  return actual === filter
}

export function sortChallenges(
  challenges: DashboardChallenge[],
  mode: string,
): DashboardChallenge[] {
  const order: Record<DashboardChallengeStatus, number> = {
    running: 0,
    preparing: 1,
    queued: 2,
    failed: 3,
    timed_out: 3,
    interrupted: 3,
    cancelled: 3,
    pending: 4,
    closed: 5,
    solved: 6,
  }
  const title = (left: DashboardChallenge, right: DashboardChallenge) =>
    left.title.localeCompare(right.title, "zh-CN")
  const timestamp = (value: string | null) => {
    const parsed = value ? Date.parse(value) : 0
    return Number.isNaN(parsed) ? 0 : parsed
  }
  return [...challenges].sort((left, right) => {
    if (mode === "score-desc")
      return right.score - left.score || title(left, right)
    if (mode === "score-asc")
      return left.score - right.score || title(left, right)
    if (mode === "title") return title(left, right)
    if (mode === "status") {
      return order[left.status] - order[right.status] || title(left, right)
    }
    return (
      timestamp(right.lastActivityAt) - timestamp(left.lastActivityAt) ||
      order[left.status] - order[right.status] ||
      title(left, right)
    )
  })
}

export function shortId(value: string): string {
  return value.length <= 12 ? value : `${value.slice(0, 8)}…`
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
