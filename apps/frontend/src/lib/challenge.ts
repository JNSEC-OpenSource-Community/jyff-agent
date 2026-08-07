import type { DashboardChallenge, DashboardChallengeStatus } from "../types.ts"

export type StatusTone = "neutral" | "positive" | "warning" | "danger" | "info"

/** 处于运行链路、可被终止的状态。 */
export const ACTIVE_STATUSES: readonly DashboardChallengeStatus[] = [
  "preparing",
  "running",
  "blocking",
  "writing_writeup",
]

/** 需要人工关注的状态。 */
export const ATTENTION_STATUSES: readonly DashboardChallengeStatus[] = [
  "failed",
  "timed_out",
  "blocked",
  "interrupted",
]

/** 状态 -> Badge 语义色。 */
export function toneForStatus(
  status: DashboardChallengeStatus | string,
): StatusTone {
  if (["solved", "completed"].includes(status)) return "positive"
  if (ACTIVE_STATUSES.includes(status as DashboardChallengeStatus))
    return "info"
  if (ATTENTION_STATUSES.includes(status as DashboardChallengeStatus))
    return "danger"
  if (["queued", "pending"].includes(status)) return "warning"
  return "neutral"
}

export interface ChallengeFilter {
  /** 标题/分类关键词；空白表示不过滤。 */
  query?: string
  /** all | active | queued | pending | solved | attention，或具体状态。 */
  statusFilter?: string
}

/** 按关键词与状态筛选题目。 */
export function filterChallenges(
  challenges: DashboardChallenge[],
  { query = "", statusFilter = "all" }: ChallengeFilter,
): DashboardChallenge[] {
  return challenges.filter((challenge) => {
    if (statusFilter !== "all") {
      if (
        statusFilter === "active" &&
        !ACTIVE_STATUSES.includes(challenge.status)
      )
        return false
      if (
        statusFilter === "attention" &&
        !ATTENTION_STATUSES.includes(challenge.status)
      )
        return false
      if (
        !["active", "attention"].includes(statusFilter) &&
        challenge.status !== statusFilter
      )
        return false
    }
    const normalized = query.trim().toLocaleLowerCase("zh-CN")
    if (!normalized) return true
    return (
      challenge.title.toLocaleLowerCase("zh-CN").includes(normalized) ||
      challenge.category.toLocaleLowerCase("zh-CN").includes(normalized)
    )
  })
}

/** 题目列表排序：执行中的置顶，再按分值降序、标题升序。 */
export function sortChallenges(
  challenges: DashboardChallenge[],
): DashboardChallenge[] {
  return [...challenges].sort((left, right) => {
    const leftActive = left.status === "running"
    const rightActive = right.status === "running"
    if (leftActive !== rightActive) return leftActive ? -1 : 1
    return (
      right.score - left.score || left.title.localeCompare(right.title, "zh-CN")
    )
  })
}

/** 最近有活动的题目（按 lastActivityAt 降序，无活动的排最后）。 */
export function recentChallenges(
  challenges: DashboardChallenge[],
  limit = 8,
): DashboardChallenge[] {
  return [...challenges]
    .sort(
      (left, right) =>
        Date.parse(right.lastActivityAt ?? "0") -
        Date.parse(left.lastActivityAt ?? "0"),
    )
    .slice(0, limit)
}
