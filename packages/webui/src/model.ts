import type { RunEvent, RunRecord } from "@ctf-agent/core"
import type {
  ChallengeDetails,
  DashboardChallenge,
  DashboardChallengeStatus,
  DashboardControlPlane,
  DashboardProject,
  DashboardScheduler,
  DashboardSnapshot,
  DashboardStats,
} from "./types.ts"

const ACTIVE = new Set<RunRecord["status"]>(["preparing", "running"])
const FAILED = new Set<DashboardChallengeStatus>([
  "failed",
  "timed_out",
  "cancelled",
  "interrupted",
])

export async function buildDashboardSnapshot(
  project: DashboardProject,
  scheduler?: DashboardScheduler,
  controlPlane?: DashboardControlPlane,
): Promise<DashboardSnapshot> {
  const [overview, listed, announcements, environments] = await Promise.all([
    project.overview(),
    project.challenges(),
    project.announcements(),
    project.environments(),
  ])
  const runs = project.runs()
  const schedulerSnapshot = scheduler?.snapshot() ?? null
  const queuedByChallenge = new Map(
    schedulerSnapshot?.queued.map((item) => [item.challengeId, item]) ?? [],
  )
  const activeByChallenge = new Map(
    schedulerSnapshot?.active.map((item) => [item.challengeId, item]) ?? [],
  )
  const runsByChallenge = groupRuns(runs)
  const blackboardByChallenge = new Map(
    project.blackboardStats().map((stats) => [stats.challengeId, stats]),
  )

  const challenges = listed.map((challenge): DashboardChallenge => {
    const challengeRuns = runsByChallenge.get(challenge.id) ?? []
    const latest = challengeRuns.at(-1)
    const active = [...challengeRuns]
      .reverse()
      .find((run) => ACTIVE.has(run.status))
    const queued = queuedByChallenge.get(challenge.id)
    const schedulerActive = activeByChallenge.get(challenge.id)
    const lastEvent = latest ? project.latestRunEvent(latest.id) : undefined
    const blackboard = blackboardByChallenge.get(challenge.id)
    const status = challengeStatus(
      challenge.solved === true,
      challengeRuns,
      active,
      queued !== undefined,
      schedulerActive?.phase,
    )
    return {
      id: challenge.id,
      title: challenge.title,
      category: challenge.category,
      score: challenge.score,
      status,
      platformSolved: challenge.solved === true,
      needsEnv: challenge.needsEnv === true,
      attempts: challengeRuns.length,
      latestRunId: latest?.id ?? null,
      latestRunStatus: latest?.status ?? null,
      lastActivityAt: lastEvent?.createdAt ?? latest?.updatedAt ?? null,
      progress: progressLabel(status, lastEvent),
      queuePosition: queued?.position ?? null,
      dispatchSource:
        schedulerActive?.source ?? queued?.source ?? latest?.source ?? null,
      schedulerAttempts: project.schedulerAttemptCount(challenge.id),
      evidence: blackboard?.evidence ?? 0,
      openOpportunities: blackboard?.openOpportunities ?? 0,
      concludedOpportunities: blackboard?.concludedOpportunities ?? 0,
    }
  })

  return {
    generatedAt: new Date().toISOString(),
    overview,
    stats: dashboardStats(challenges),
    challenges,
    categories: [
      ...new Set(challenges.map((challenge) => challenge.category)),
    ].sort((left, right) => left.localeCompare(right)),
    announcements: [...announcements].sort((left, right) =>
      right.publishedAt.localeCompare(left.publishedAt),
    ),
    environments,
    scheduler: schedulerSnapshot,
    controlPlane: controlPlane?.snapshot() ?? null,
  }
}

export function buildEmptyDashboardSnapshot(
  controlPlane: DashboardControlPlane,
): DashboardSnapshot {
  const state = controlPlane.snapshot()
  return {
    generatedAt: new Date().toISOString(),
    overview: {
      id: state.projectId ?? "setup",
      name:
        state.projectName ??
        (state.phase === "degraded" ? "平台连接失败" : "尚未配置比赛"),
      challenges: 0,
      announcements: 0,
    },
    stats: {
      total: 0,
      solved: 0,
      active: 0,
      failed: 0,
      pending: 0,
      attempts: 0,
      queued: 0,
    },
    challenges: [],
    categories: [],
    announcements: [],
    environments: [],
    scheduler: null,
    controlPlane: state,
  }
}

export async function buildChallengeDetails(
  project: DashboardProject,
  challengeId: string,
  scheduler?: DashboardScheduler,
  currentSnapshot?: DashboardSnapshot,
): Promise<ChallengeDetails | undefined> {
  const snapshot =
    currentSnapshot ?? (await buildDashboardSnapshot(project, scheduler))
  const challenge = snapshot.challenges.find(
    (candidate) => candidate.id === challengeId,
  )
  if (!challenge) return undefined
  const runs = project.runs({ challengeId }).map((run) => ({
    ...run,
    events: compactTimelineEvents(project.runEvents(run.id)),
    subagents: project.subagents(run.id),
  }))
  return {
    generatedAt: new Date().toISOString(),
    challenge,
    runs: [...runs].reverse(),
    blackboard: project.blackboard(challengeId),
    environment:
      snapshot.environments.find(
        (environment) =>
          environment.challengeId === challengeId &&
          environment.status !== "stopped",
      ) ?? null,
  }
}

const TIMELINE_THINKING_MAX_CHARACTERS = 8_000

/**
 * Older builds persisted every reasoning delta as one row. Collapse adjacent
 * deltas per turn and bound their UI payload; raw events remain untouched for
 * full session export.
 */
function compactTimelineEvents(events: RunEvent[]): RunEvent[] {
  const compacted: RunEvent[] = []
  for (const event of events) {
    const text = event.type === "agent_thinking" ? eventText(event) : undefined
    const previous = compacted.at(-1)
    if (
      text !== undefined &&
      previous?.type === "agent_thinking" &&
      eventText(previous) !== undefined
    ) {
      const previousText = eventText(previous) ?? ""
      const combined = previousText + text
      previous.data = {
        ...(isRecord(previous.data) ? previous.data : {}),
        text: combined.slice(0, TIMELINE_THINKING_MAX_CHARACTERS),
        ...(combined.length > TIMELINE_THINKING_MAX_CHARACTERS
          ? { truncated: true }
          : {}),
      }
      continue
    }
    compacted.push({ ...event })
  }
  return compacted
}

function eventText(event: RunEvent): string | undefined {
  if (!isRecord(event.data)) return undefined
  return typeof event.data.text === "string" ? event.data.text : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function groupRuns(runs: RunRecord[]): Map<string, RunRecord[]> {
  const grouped = new Map<string, RunRecord[]>()
  for (const run of runs) {
    const existing = grouped.get(run.challengeId)
    if (existing) existing.push(run)
    else grouped.set(run.challengeId, [run])
  }
  for (const challengeRuns of grouped.values()) {
    challengeRuns.sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        left.id.localeCompare(right.id),
    )
  }
  return grouped
}

function challengeStatus(
  platformSolved: boolean,
  runs: RunRecord[],
  active: RunRecord | undefined,
  queued: boolean,
  schedulerPhase: "preparing" | "running" | "cancelling" | undefined,
): DashboardChallengeStatus {
  if (schedulerPhase)
    return schedulerPhase === "preparing" ? "preparing" : "running"
  if (active) return active.status
  if (queued) return "queued"
  if (platformSolved || runs.some((run) => run.status === "solved"))
    return "solved"
  return runs.at(-1)?.status ?? "pending"
}

function dashboardStats(challenges: DashboardChallenge[]): DashboardStats {
  return {
    total: challenges.length,
    solved: challenges.filter((challenge) => challenge.status === "solved")
      .length,
    active: challenges.filter(
      (challenge) =>
        challenge.status === "preparing" || challenge.status === "running",
    ).length,
    failed: challenges.filter((challenge) => FAILED.has(challenge.status))
      .length,
    pending: challenges.filter(
      (challenge) =>
        challenge.status === "pending" || challenge.status === "closed",
    ).length,
    attempts: challenges.reduce(
      (sum, challenge) => sum + challenge.attempts,
      0,
    ),
    queued: challenges.filter((challenge) => challenge.status === "queued")
      .length,
  }
}

function progressLabel(
  status: DashboardChallengeStatus,
  event: RunEvent | undefined,
): string {
  if (event?.type === "tool_started") {
    const tool = eventField(event, "toolName")
    return tool ? `正在执行 ${humanToolName(tool)}` : "正在执行工具"
  }
  if (event?.type === "tool_finished") {
    const tool = eventField(event, "toolName")
    const failed = eventField(event, "isError") === "true"
    return `${failed ? "工具失败" : "已完成"}${tool ? ` · ${humanToolName(tool)}` : ""}`
  }
  if (event?.type === "agent_message") return "Agent 正在回复"
  if (event?.type === "agent_usage") return "已记录本轮用量"
  if (event?.type === "thinking_level_update") return "已切换思考强度"
  if (event?.type === "human_message") return "已发送人工消息"
  switch (status) {
    case "queued":
      return "已进入调度队列"
    case "pending":
      return "尚未入队"
    case "preparing":
      return "正在准备沙箱"
    case "running":
      return "Agent 正在分析"
    case "solved":
      return "Flag 已确认"
    case "failed":
      return "最近一次尝试失败"
    case "timed_out":
      return "最近一次尝试超时"
    case "cancelled":
      return "任务已取消"
    case "interrupted":
      return "进程异常中断"
    case "closed":
      return "尝试已手动关闭"
  }
}

function eventField(event: RunEvent, key: string): string | undefined {
  if (typeof event.data !== "object" || event.data === null) return undefined
  const value = (event.data as Record<string, unknown>)[key]
  return value === undefined ? undefined : String(value)
}

function humanToolName(tool: string): string {
  const labels: Record<string, string> = {
    bash: "终端命令",
    read: "读取文件",
    write: "写入文件",
    edit: "编辑文件",
    list: "浏览目录",
    ctf_submit_flag: "提交 Flag",
    ctf_instance_start: "启动远程环境",
    ctf_instance_destroy: "关闭远程环境",
    ctf_blackboard_read: "读取黑板",
    ctf_blackboard_record: "更新黑板",
  }
  return labels[tool] ?? tool
}
