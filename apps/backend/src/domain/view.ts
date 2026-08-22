import type {
  ChallengeSummary,
  ContestSchedulerSnapshot,
  RunEvent,
  RunRecord,
  SchedulerPhase,
  SchedulerQueueEntry,
} from "@ctf-agent/core"
import type {
  AgentCacheStats,
  ChallengeDetails,
  DashboardChallenge,
  DashboardChallengeStatus,
  DashboardControlPlane,
  DashboardProject,
  DashboardScheduler,
  DashboardSnapshot,
  DashboardSolverLogEntry,
  DashboardStats,
} from "../types.ts"

const ACTIVE = new Set<RunRecord["status"]>(["preparing", "running", "blocking", "writing_writeup"])
const FAILED = new Set<DashboardChallengeStatus>([
  "failed",
  "timed_out",
  "cancelled",
  "interrupted",
  "blocked",
])

export async function buildDashboardSnapshot(
  project: DashboardProject,
  scheduler?: DashboardScheduler,
  controlPlane?: DashboardControlPlane,
  projectId?: string,
): Promise<DashboardSnapshot> {
  const runs = project.runs()
  const reads = await Promise.allSettled([
    project.overview(),
    project.challenges(),
    project.announcements(),
    project.environments(),
  ] as const)
  const failed = reads.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  )
  if (failed) controlPlane?.reportPlatformFailure?.(projectId, failed.reason)
  else controlPlane?.reportPlatformSuccess?.(projectId)

  const cached = project.cachedPlatformView?.() ?? {}
  const challengeIds = [...new Set(runs.map((run) => run.challengeId))]
  const fallbackChallenges: ChallengeSummary[] = challengeIds.map((challengeId) => ({
    id: challengeId,
    title: challengeId,
    category: "本地记录",
    score: 0,
    solved: runs.some((run) => run.challengeId === challengeId && run.status === "solved"),
  }))
  const overview = settledValue(reads[0]) ??
    cached.overview ?? {
      id: controlPlane?.snapshot(projectId).projectId ?? "local",
      name: controlPlane?.snapshot(projectId).projectName ?? "本地记录",
      challenges: cached.challenges?.length ?? challengeIds.length,
      announcements: cached.announcements?.length ?? 0,
    }
  const listed = settledValue(reads[1]) ?? cached.challenges ?? fallbackChallenges
  const announcements = settledValue(reads[2]) ?? cached.announcements ?? []
  const announcementCandidates = project.announcementCandidates()
  const environments = settledValue(reads[3]) ?? cached.environments ?? []
  const schedulerSnapshot = scheduler?.snapshot() ?? readOnlySchedulerSnapshot(project)
  const idleByChallenge = new Map(
    schedulerSnapshot?.idle.map((item) => [item.challengeId, item]) ?? [],
  )
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
    const active = [...challengeRuns].reverse().find((run) => ACTIVE.has(run.status))
    const solvedRun = [...challengeRuns]
      .reverse()
      .find((run) => run.status === "solved" && run.finishedAt)
    const solveDurationMs = solvedRun
      ? durationBetween(solvedRun.startedAt ?? solvedRun.createdAt, solvedRun.finishedAt)
      : null
    const idle = idleByChallenge.get(challenge.id)
    const queued = queuedByChallenge.get(challenge.id)
    const schedulerActive = activeByChallenge.get(challenge.id)
    const lastEvent = latest ? project.latestRunEvent(latest.id) : undefined
    const blackboard = blackboardByChallenge.get(challenge.id)
    const schedulingDisposition = project.challengeSchedulingDisposition(challenge.id)
    const status = challengeStatus(
      challenge.solved === true,
      schedulingDisposition,
      challengeRuns,
      active,
      idle !== undefined,
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
      ...(schedulingDisposition ? { schedulingDisposition } : {}),
      ...(challenge.needsEnv === undefined ? {} : { needsEnv: challenge.needsEnv }),
      attempts: challengeRuns.length,
      latestRunId: latest?.id ?? null,
      latestRunStatus: latest?.status ?? null,
      solveDurationMs,
      lastActivityAt: lastEvent?.createdAt ?? latest?.updatedAt ?? null,
      progress: progressLabel(status, lastEvent),
      queuePosition: queued?.position ?? idle?.position ?? null,
      dispatchSource:
        schedulerActive?.source ?? queued?.source ?? idle?.source ?? latest?.source ?? null,
      schedulerAttempts: project.schedulerAttemptCount(challenge.id),
      sessionInterruptions: project.sessionInterruptionCount(challenge.id),
      evidence: blackboard?.evidence ?? 0,
      openOpportunities: blackboard?.openOpportunities ?? 0,
      concludedOpportunities: blackboard?.concludedOpportunities ?? 0,
    }
  })

  const challengeTitleById = new Map(challenges.map((challenge) => [challenge.id, challenge.title]))
  const runById = new Map(runs.map((run) => [run.id, run]))
  const solverLogs = (project.recentRunEvents?.(80) ?? [])
    .flatMap((event): DashboardSolverLogEntry[] => {
      const run = runById.get(event.runId)
      if (!run) return []
      return [
        {
          id: event.id,
          runId: event.runId,
          challengeId: run.challengeId,
          challengeTitle: challengeTitleById.get(run.challengeId) ?? run.challengeId,
          type: event.type,
          summary: solverLogSummary(event),
          createdAt: event.createdAt,
          tone: solverLogTone(event.type),
        },
      ]
    })
    .slice(0, 80)
  const remoteEnvironment = project.remoteEnvironmentSnapshot?.() ?? {
    capacity: { maximum: 0, occupied: 0, available: 0 },
    leases: [],
  }

  return {
    generatedAt: new Date().toISOString(),
    overview,
    stats: dashboardStats(challenges),
    challenges,
    categories: [...new Set(challenges.map((challenge) => challenge.category))].sort(
      (left, right) => left.localeCompare(right),
    ),
    announcements: [...announcements].sort((left, right) =>
      right.publishedAt.localeCompare(left.publishedAt),
    ),
    announcementCandidates,
    environments,
    remoteEnvironment,
    solverLogs,
    scheduler: schedulerSnapshot,
    controlPlane: controlPlane?.snapshot(projectId) ?? null,
  }
}

function settledValue<T>(result: PromiseSettledResult<T>): T | undefined {
  return result.status === "fulfilled" ? result.value : undefined
}

function readOnlySchedulerSnapshot(project: DashboardProject): ContestSchedulerSnapshot {
  const validSources = new Set<SchedulerQueueEntry["source"]>([
    "auto",
    "manual",
    "retry",
    "revival",
  ])
  const state = project.schedulerState?.() ?? {
    mode: "stopped" as const,
    idleVersion: 1,
    executionVersion: 1,
  }
  const entries = (project.schedulerQueue?.() ?? []).flatMap((item) =>
    validSources.has(item.source as SchedulerQueueEntry["source"])
      ? [
          {
            challengeId: item.challengeId,
            source: item.source as SchedulerQueueEntry["source"],
            stage: item.stage,
            lane: item.lane,
            manualOverride: item.manualOverride,
            enqueuedAt: item.enqueuedAt,
            position: item.position,
            version: item.version,
          },
        ]
      : [],
  )
  return {
    available: false,
    unavailableReason: "平台当前不可用，只能查看本地记录",
    autoEnabled: state.mode !== "stopped",
    state: state.mode === "stopped" ? "stopped" : "suspended",
    mode: state.mode,
    idleVersion: state.idleVersion,
    executionVersion: state.executionVersion,
    maxConcurrent: 0,
    maxAttempts: 0,
    maxSessionInterruptions: 0,
    idle: entries.filter((item) => item.stage === "idle"),
    queued: entries.filter((item) => item.stage === "execution"),
    active: [],
  }
}

export function buildEmptyDashboardSnapshot(
  controlPlane: DashboardControlPlane,
  projectId?: string,
): DashboardSnapshot {
  const state = controlPlane.snapshot(projectId)
  return {
    generatedAt: new Date().toISOString(),
    overview: {
      id: state.projectId ?? "setup",
      name: state.projectName ?? (state.phase === "degraded" ? "平台连接失败" : "尚未配置比赛"),
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
    announcementCandidates: [],
    environments: [],
    remoteEnvironment: {
      capacity: { maximum: 0, occupied: 0, available: 0 },
      leases: [],
    },
    solverLogs: [],
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
  const snapshot = currentSnapshot ?? (await buildDashboardSnapshot(project, scheduler))
  const challenge = snapshot.challenges.find((candidate) => candidate.id === challengeId)
  if (!challenge) return undefined
  const runs = project.runs({ challengeId }).map((run) => {
    const events = project.runEvents(run.id)
    return {
      ...run,
      events: compactTimelineEvents(events),
      subagents: project.subagents(run.id).map((subagent) => ({
        ...subagent,
        hasConversation:
          subagent.turns > 0 ||
          subagent.toolUses > 0 ||
          subagent.totalTokens > 0 ||
          Boolean(subagent.result),
      })),
      cache: agentCacheStats(events),
      hasConversation: events.some((event) =>
        ["agent_message", "agent_usage", "tool_started"].includes(event.type),
      ),
    }
  })
  return {
    generatedAt: new Date().toISOString(),
    solverAvailable: scheduler !== undefined,
    challenge,
    runs: [...runs].reverse(),
    blackboard: project.blackboard(challengeId),
    environment:
      snapshot.environments.find(
        (environment) =>
          environment.challengeId === challengeId && environment.status !== "stopped",
      ) ?? null,
    writeup: await project.challengeWriteup(challengeId),
    tldr: project.tldr(challengeId) ?? null,
  }
}

export function agentCacheStats(events: readonly RunEvent[]): AgentCacheStats {
  let inputTokens = 0
  let cacheReadTokens = 0
  let cacheWriteTokens = 0
  for (const event of events) {
    if (event.type !== "agent_usage" || !isRecord(event.data)) continue
    inputTokens += nonNegativeNumber(event.data.input)
    cacheReadTokens += nonNegativeNumber(event.data.cacheRead)
    cacheWriteTokens += nonNegativeNumber(event.data.cacheWrite)
  }
  const eligibleTokens = inputTokens + cacheReadTokens
  return {
    inputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    cacheRate: eligibleTokens > 0 ? cacheReadTokens / eligibleTokens : null,
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
        ...(combined.length > TIMELINE_THINKING_MAX_CHARACTERS ? { truncated: true } : {}),
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

function nonNegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function durationBetween(start: string | undefined, end: string | undefined): number | null {
  if (!start || !end) return null
  const duration = Date.parse(end) - Date.parse(start)
  return Number.isFinite(duration) ? Math.max(0, duration) : null
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
        left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
    )
  }
  return grouped
}

function challengeStatus(
  platformSolved: boolean,
  schedulingDisposition: "excluded" | "solved" | null,
  runs: RunRecord[],
  active: RunRecord | undefined,
  idle: boolean,
  queued: boolean,
  schedulerPhase: SchedulerPhase | undefined,
): DashboardChallengeStatus {
  if (schedulingDisposition === "solved") return "solved"
  if (schedulingDisposition === "excluded") return "excluded"
  if (schedulerPhase) return schedulerPhase === "preparing" ? "preparing" : "running"
  if (active) return active.status
  if (queued) return "queued"
  if (idle) return "idle"
  if (platformSolved || runs.some((run) => run.status === "solved")) return "solved"
  return runs.at(-1)?.status ?? "pending"
}

function dashboardStats(challenges: DashboardChallenge[]): DashboardStats {
  return {
    total: challenges.length,
    solved: challenges.filter((challenge) => challenge.status === "solved").length,
    active: challenges.filter(
      (challenge) =>
        challenge.status === "preparing" ||
        challenge.status === "running" ||
        challenge.status === "blocking" ||
        challenge.status === "writing_writeup",
    ).length,
    failed: challenges.filter((challenge) => FAILED.has(challenge.status)).length,
    pending: challenges.filter(
      (challenge) => challenge.status === "pending" || challenge.status === "closed",
    ).length,
    attempts: challenges.reduce((sum, challenge) => sum + challenge.attempts, 0),
    queued: challenges.filter(
      (challenge) => challenge.status === "idle" || challenge.status === "queued",
    ).length,
  }
}

function progressLabel(status: DashboardChallengeStatus, event: RunEvent | undefined): string {
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
    case "idle":
      return "已加入空闲队列"
    case "queued":
      return "已进入调度队列"
    case "pending":
      return "尚未入队"
    case "excluded":
      return "已标记为不调度"
    case "preparing":
      return "正在准备沙箱"
    case "running":
      return "Agent 正在分析"
    case "blocking":
      return "正在收集进度并执行 Blocked 收尾"
    case "writing_writeup":
      return "Flag 已确认，正在编写 Writeup"
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
    case "blocked":
      return "连续中断，等待人工介入"
    case "closed":
      return "尝试已手动关闭"
  }
}

function solverLogSummary(event: RunEvent): string {
  const tool = eventField(event, "toolName")
  switch (event.type) {
    case "run_created":
      return "已创建 Solver"
    case "run_started":
      return "Solver 开始运行"
    case "run_finished":
      return "Solver 已结束"
    case "run_interrupted":
      return "Solver 因进程重启中断"
    case "tool_started":
      return tool ? `开始执行 ${humanToolName(tool)}` : "开始执行工具"
    case "tool_finished":
      return tool ? `完成 ${humanToolName(tool)}` : "工具执行结束"
    case "flag_submitted":
      return `Flag 提交：${eventField(event, "status") ?? "未知结果"}`
    case "environment_waiting":
      return "等待远程环境名额"
    case "environment_starting":
      return "正在启动远程环境"
    case "environment_acquired":
      return "远程环境已就绪"
    case "environment_updated":
      return "远程环境地址或到期时间已更新"
    case "environment_expired":
      return "远程环境已过期，可原子重开"
    case "environment_released":
      return "远程环境已释放"
    case "environment_start_failed":
    case "environment_release_failed":
      return "远程环境操作失败"
    case "subagent_started":
      return `SubAgent 已启动${eventField(event, "role") ? ` · ${eventField(event, "role")}` : ""}`
    case "subagent_completed":
      return `SubAgent 已完成${eventField(event, "role") ? ` · ${eventField(event, "role")}` : ""}`
    case "agent_message":
      return "Solver 返回了一条消息"
    default:
      return event.type.replaceAll("_", " ")
  }
}

function solverLogTone(type: string): DashboardSolverLogEntry["tone"] {
  if (type.includes("failed") || type === "run_interrupted") return "danger"
  if (type.includes("expired") || type.includes("waiting")) return "warning"
  if (
    type.includes("acquired") ||
    type.includes("completed") ||
    type.includes("submitted") ||
    type === "run_finished"
  ) {
    return "positive"
  }
  return "neutral"
}

function eventField(event: RunEvent, key: string): string | undefined {
  if (typeof event.data !== "object" || event.data === null) return undefined
  const value = (event.data as Record<string, unknown>)[key]
  if (value === undefined) return undefined
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value)
  }
  try {
    return JSON.stringify(value)
  } catch {
    return "[unserializable]"
  }
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
    blackboard_read: "读取黑板",
    blackboard_record: "更新黑板",
    blackboard_manage: "管理黑板条目",
  }
  return labels[tool] ?? tool
}
