import { Icon } from "@iconify/react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { Link, useParams } from "react-router-dom"
import {
  Badge,
  Button,
  Card,
  Checkbox,
  ConfirmDialog,
  ErrorNotice,
  Input,
  PageHeader,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
} from "../components/index.ts"
import { apiMutation, apiRequest, projectApi } from "../lib/api.ts"
import { filterChallenges, sortChallenges, toneForStatus } from "../lib/challenge.ts"
import { STATUS_LABELS } from "../lib/labels.ts"
import { absoluteTime, relativeTime } from "../lib/time.ts"
import { cn } from "../lib/utils.ts"
import type { DashboardChallenge, DashboardSnapshot } from "../types.ts"
import { SchedulerWorkbench } from "./project/SchedulerWorkbench.tsx"

/* ── 解题进度 ── */

function ProgressOverview({
  solved,
  total,
  active,
  queued,
  failed,
}: {
  solved: number
  total: number
  active: number
  queued: number
  failed: number
}) {
  const progress = total > 0 ? Math.round((solved / total) * 100) : 0
  return (
    <Card className="mb-4 p-0">
      <div className="grid md:grid-cols-[minmax(18rem,1fr)_auto] md:items-stretch">
        <div className="min-w-0 px-4 pt-3 pb-4 sm:px-4">
          <div className="flex items-baseline gap-3">
            <h2 className="text-sm font-semibold tracking-tight">解题进度</h2>
            <span className="font-mono text-xs tabular-nums text-muted-foreground">
              {solved} / {total}
            </span>
            <strong className="ml-auto font-mono text-sm font-semibold tabular-nums text-primary">
              {progress}%
            </strong>
          </div>
          <div
            className="challenge-progress-track relative mt-3 h-2 overflow-hidden"
            role="progressbar"
            aria-label="解题进度"
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={solved}
          >
            <div
              className="challenge-progress-fill absolute inset-0 origin-left transition-transform duration-300"
              style={{ transform: `scaleX(${progress / 100})` }}
            />
          </div>
          <p className="mt-2! text-[11px] text-muted-foreground">
            已解出 {solved} 题，剩余 {Math.max(0, total - solved)} 题
          </p>
        </div>
        <dl className="grid grid-cols-3 border-t border-border md:min-w-108 md:border-t-0 md:border-l">
          <ProgressMetric label="正在解题" value={active} />
          <ProgressMetric label="等待处理" value={queued} />
          <ProgressMetric label="需要处理" value={failed} tone="danger" />
        </dl>
      </div>
    </Card>
  )
}

function ProgressMetric({ label, value, tone }: { label: string; value: number; tone?: "danger" }) {
  return (
    <div className="flex min-w-0 flex-col justify-center border-l border-border px-3 py-2.5 first:border-l-0 md:px-4">
      <dd
        className={cn(
          "font-mono text-lg font-semibold leading-none tabular-nums",
          tone === "danger" ? "text-danger" : "text-foreground",
        )}
      >
        {value}
      </dd>
      <dt className="mt-2 text-[11px] leading-none text-muted-foreground">{label}</dt>
    </div>
  )
}

function elapsedTime(from: string | undefined, now: string): string {
  if (!from) return "尚未开始"
  const seconds = Math.max(0, Math.floor((Date.parse(now) - Date.parse(from)) / 1_000))
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`
  const hours = Math.floor(minutes / 60)
  return `${hours} 小时 ${minutes % 60} 分`
}

const ENVIRONMENT_PHASE_LABELS = {
  waiting: "等待名额",
  starting: "正在启动",
  ready: "已就绪",
  releasing: "正在释放",
} as const

function EnvironmentLedger({
  snapshot,
  projectId,
  challengeTitle,
  releasing,
  onRelease,
}: {
  snapshot: DashboardSnapshot
  projectId: string
  challengeTitle: (challengeId: string) => string
  releasing: string
  onRelease: (environmentId: string) => void
}) {
  const managedIds = new Set(
    snapshot.remoteEnvironment.leases.flatMap((lease) =>
      lease.environmentId ? [lease.environmentId] : [],
    ),
  )
  const unmanaged = snapshot.environments.filter(
    (environment) => environment.status !== "stopped" && !managedIds.has(environment.id),
  )
  const { capacity } = snapshot.remoteEnvironment
  const rows = snapshot.remoteEnvironment.leases.length + unmanaged.length
  const [open, setOpen] = useState(rows > 0)

  return (
    <details
      className="surface group mb-4 overflow-hidden"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="disclosure-summary flex cursor-pointer list-none flex-wrap items-center justify-between gap-3 px-4 py-3 outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground">
            远程环境
          </p>
          <h2 className="mt-0.5 font-semibold">实例占用</h2>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-baseline gap-2 font-mono tabular-nums">
            <strong className="text-lg">{capacity.occupied}</strong>
            <span className="text-xs text-muted-foreground">/ {capacity.maximum} 个名额</span>
          </div>
          <Icon
            icon="lucide:chevron-down"
            width="15"
            className="text-muted-foreground transition-transform group-open:rotate-180"
            aria-hidden="true"
          />
        </div>
      </summary>
      {rows === 0 ? (
        <div className="px-4 py-7 text-sm text-muted-foreground">
          当前没有 Solver 占用或等待远程环境。
        </div>
      ) : (
        <div className="divide-y divide-border/60">
          {snapshot.remoteEnvironment.leases.map((lease) => {
            const since = lease.acquiredAt ?? lease.startedAt ?? lease.requestedAt
            return (
              <div
                key={`${lease.runId}:${lease.environmentId ?? lease.phase}`}
                className="grid gap-3 px-4 py-3 sm:grid-cols-[minmax(0,1.5fr)_minmax(8rem,0.8fr)_auto] sm:items-center"
              >
                <div className="min-w-0">
                  <Link
                    to={`/projects/${encodeURIComponent(projectId)}/challenges/${encodeURIComponent(lease.challengeId)}`}
                    className="truncate text-sm font-medium hover:text-primary"
                  >
                    {challengeTitle(lease.challengeId)}
                  </Link>
                  <p className="truncate font-mono text-[10px] text-muted-foreground">
                    {lease.environmentId ?? lease.runId}
                  </p>
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        "size-1.5 rounded-full",
                        lease.phase === "ready" ? "bg-success" : "bg-warning",
                      )}
                    />
                    <span className="text-xs font-medium">
                      {ENVIRONMENT_PHASE_LABELS[lease.phase]}
                    </span>
                  </div>
                  <p className="mt-1! font-mono text-[10px] tabular-nums text-muted-foreground">
                    已持续 {elapsedTime(since, snapshot.generatedAt)}
                    {lease.expiresAt ? ` · ${relativeTime(lease.expiresAt)}到期` : ""}
                  </p>
                </div>
                {lease.environmentId ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={releasing === lease.environmentId}
                    onClick={() => onRelease(lease.environmentId as string)}
                  >
                    <Icon
                      icon={
                        releasing === lease.environmentId
                          ? "lucide:loader-circle"
                          : "lucide:circle-stop"
                      }
                      className={releasing === lease.environmentId ? "animate-spin" : ""}
                      width="13"
                    />
                    释放
                  </Button>
                ) : (
                  <span className="text-xs text-muted-foreground">{lease.priority}</span>
                )}
              </div>
            )
          })}
          {unmanaged.map((environment) => (
            <div
              key={environment.id}
              className="grid gap-3 px-4 py-3 sm:grid-cols-[minmax(0,1.5fr)_minmax(8rem,0.8fr)_auto] sm:items-center"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">
                  {challengeTitle(environment.challengeId)}
                </p>
                <p className="truncate font-mono text-[10px] text-muted-foreground">
                  {environment.id} · 平台外部实例
                </p>
              </div>
              <span className="text-xs text-muted-foreground">{environment.status}</span>
              <Button
                size="sm"
                variant="secondary"
                disabled={releasing === environment.id}
                onClick={() => onRelease(environment.id)}
              >
                释放
              </Button>
            </div>
          ))}
        </div>
      )}
    </details>
  )
}

const STAGEABLE_STATUSES = new Set<DashboardChallenge["status"]>([
  "pending",
  "failed",
  "timed_out",
  "cancelled",
  "interrupted",
  "closed",
])

function canStageChallenge(challenge: DashboardChallenge): boolean {
  return (
    STAGEABLE_STATUSES.has(challenge.status) &&
    challenge.schedulingDisposition === undefined &&
    !challenge.platformSolved
  )
}

function canEditIdleQueue(challenge: DashboardChallenge): boolean {
  return canStageChallenge(challenge) || challenge.status === "idle"
}

/* ── Page ── */

export function ProjectPage() {
  const { projectId = "" } = useParams()
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState("")
  const [statusFilter, setStatusFilter] = useState("all")
  const [schedulingBusy, setSchedulingBusy] = useState("")
  const [releasingEnvironment, setReleasingEnvironment] = useState("")
  const [stopAllOpen, setStopAllOpen] = useState(false)
  const [stoppingAll, setStoppingAll] = useState(false)
  const [queueBusy, setQueueBusy] = useState(false)
  const [selectedChallengeIds, setSelectedChallengeIds] = useState<string[]>([])

  const load = useCallback(async () => {
    setError("")
    const s = await apiRequest<DashboardSnapshot>(projectApi(projectId, "/api/snapshot"))
    setSnapshot(s)
  }, [projectId])

  useEffect(() => {
    void load().catch((e) => setError(String(e instanceof Error ? e.message : e)))
    const es = new EventSource(projectApi(projectId, "/api/events"))
    es.addEventListener("snapshot", (ev) => {
      const s = JSON.parse((ev as MessageEvent<string>).data) as DashboardSnapshot
      setSnapshot(s)
    })
    return () => es.close()
  }, [load, projectId])

  const byId = useMemo(() => new Map(snapshot?.challenges.map((c) => [c.id, c]) ?? []), [snapshot])

  async function startContest() {
    setBusy(true)
    setError("")
    try {
      const result = await apiMutation<{ snapshot: DashboardSnapshot }>(
        projectApi(projectId, "/api/start"),
        "POST",
      )
      setSnapshot(result.snapshot)
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e))
    } finally {
      setBusy(false)
    }
  }

  async function action(path: string) {
    setBusy(true)
    setError("")
    try {
      const s = await apiMutation<DashboardSnapshot>(projectApi(projectId, path), "POST")
      setSnapshot(s)
      if (path === "/api/scheduler/start") setSelectedChallengeIds([])
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e))
    } finally {
      setBusy(false)
    }
  }

  async function stopAllSolvers() {
    setStoppingAll(true)
    setError("")
    try {
      const next = await apiMutation<DashboardSnapshot>(
        projectApi(projectId, "/api/scheduler/active/stop"),
        "POST",
      )
      setSnapshot(next)
      setStopAllOpen(false)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      await load().catch(() => undefined)
      setError(message)
    } finally {
      setStoppingAll(false)
    }
  }

  async function reviewAnnouncements(
    candidates: DashboardSnapshot["announcementCandidates"],
    status: "approved" | "rejected",
  ) {
    setBusy(true)
    setError("")
    try {
      await Promise.all(
        candidates.map((candidate) =>
          apiMutation(projectApi(projectId, "/api/announcements/review"), "POST", {
            challengeId: candidate.challengeId,
            announcementKey: candidate.key,
            status,
          }),
        ),
      )
      await load()
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e))
      await load().catch(() => undefined)
    } finally {
      setBusy(false)
    }
  }

  async function releaseEnvironment(environmentId: string) {
    setReleasingEnvironment(environmentId)
    setError("")
    try {
      const next = await apiMutation<DashboardSnapshot>(
        projectApi(projectId, `/api/environments/${encodeURIComponent(environmentId)}`),
        "DELETE",
      )
      setSnapshot(next)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setReleasingEnvironment("")
    }
  }

  async function stageChallenges(challengeIds: readonly string[]) {
    if (challengeIds.length === 0) return
    setQueueBusy(true)
    setError("")
    try {
      const next = await apiMutation<DashboardSnapshot>(
        projectApi(projectId, "/api/scheduler/idle"),
        "POST",
        { challengeIds },
      )
      setSnapshot(next)
      const staged = new Set(challengeIds)
      setSelectedChallengeIds((current) => current.filter((id) => !staged.has(id)))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setQueueBusy(false)
    }
  }

  async function unstageChallenges(challengeIds: readonly string[]) {
    if (challengeIds.length === 0) return
    setQueueBusy(true)
    setError("")
    try {
      const next = await apiMutation<DashboardSnapshot>(
        projectApi(projectId, "/api/scheduler/idle"),
        "DELETE",
        { challengeIds },
      )
      setSnapshot(next)
      const unstaged = new Set(challengeIds)
      setSelectedChallengeIds((current) => current.filter((id) => !unstaged.has(id)))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setQueueBusy(false)
    }
  }

  async function setSchedulingDisposition(
    challengeId: string,
    disposition: "default" | "excluded" | "solved",
  ) {
    setSchedulingBusy(challengeId)
    setError("")
    try {
      const next = await apiMutation<DashboardSnapshot>(
        projectApi(projectId, `/api/challenges/${encodeURIComponent(challengeId)}/scheduling`),
        "PATCH",
        { disposition },
      )
      setSnapshot(next)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSchedulingBusy("")
    }
  }

  if (!snapshot) {
    if (error) {
      return (
        <div className="page-container">
          <ErrorNotice message={error} />
          <Button className="mt-4" onClick={() => void load()}>
            重试
          </Button>
        </div>
      )
    }
    return <Spinner label="同步比赛数据" />
  }

  const pendingAnnouncements = snapshot.announcementCandidates.filter(
    (candidate) => candidate.approvalStatus === "pending",
  )
  const operationsAvailable =
    snapshot.scheduler?.available === true &&
    (!snapshot.controlPlane || snapshot.controlPlane.phase === "ready")
  const contestPending = snapshot.controlPlane?.activation?.state === "pending"
  const scheduledStartAt = snapshot.controlPlane?.activation?.scheduledStartAt
  const scheduler = snapshot.scheduler
  const schedulerRunning = scheduler?.mode !== undefined && scheduler.mode !== "stopped"
  const activeSolverCount = scheduler?.active?.length ?? 0
  const waitingCount = (scheduler?.idle?.length ?? 0) + (scheduler?.queued?.length ?? 0)

  const ordered = sortChallenges(snapshot.challenges)
  const visible = sortChallenges(filterChallenges(snapshot.challenges, { query, statusFilter }))
  const stageable = ordered.filter(canStageChallenge)
  const removableFromIdle = ordered.filter((challenge) => challenge.status === "idle")
  const visibleEditable = visible.filter(canEditIdleQueue)
  const requestedIds = new Set(selectedChallengeIds)
  const selectedStageableIds = stageable
    .filter((challenge) => requestedIds.has(challenge.id))
    .map((challenge) => challenge.id)
  const selectedIdleIds = removableFromIdle
    .filter((challenge) => requestedIds.has(challenge.id))
    .map((challenge) => challenge.id)
  const selectedEditableIds = ordered
    .filter((challenge) => canEditIdleQueue(challenge) && requestedIds.has(challenge.id))
    .map((challenge) => challenge.id)
  const selectedIds = new Set(selectedEditableIds)
  const allVisibleSelected =
    visibleEditable.length > 0 &&
    visibleEditable.every((challenge) => selectedIds.has(challenge.id))

  function toggleChallengeSelection(challengeId: string, checked: boolean) {
    setSelectedChallengeIds((current) =>
      checked
        ? current.includes(challengeId)
          ? current
          : [...current, challengeId]
        : current.filter((id) => id !== challengeId),
    )
  }

  function toggleVisibleSelection(checked: boolean) {
    const visibleIds = new Set(visibleEditable.map((challenge) => challenge.id))
    setSelectedChallengeIds((current) => {
      if (!checked) return current.filter((id) => !visibleIds.has(id))
      return [...new Set([...current, ...visibleIds])]
    })
  }

  return (
    <div className="page-container">
      <PageHeader
        eyebrow={`${snapshot.overview.id} · ${operationsAvailable ? "可调度" : "只读"}`}
        title={snapshot.overview.name}
        description={`${snapshot.overview.challenges} 题 · ${relativeTime(snapshot.generatedAt)}`}
        actions={
          <>
            <Button asChild variant="secondary" size="sm">
              <a
                href={projectApi(projectId, "/api/writeups/export")}
                download="challenge-writeups.md"
              >
                <Icon icon="lucide:download" width="14" />
                导出全部 WP
              </a>
            </Button>
            {contestPending && !scheduledStartAt ? (
              <Button size="sm" onClick={() => void startContest()} disabled={busy}>
                <Icon
                  icon={busy ? "lucide:loader-circle" : "lucide:play"}
                  className={busy ? "animate-spin" : undefined}
                  width="14"
                />
                开始比赛
              </Button>
            ) : null}
            <Button
              variant="secondary"
              onClick={() => void action("/api/refresh")}
              disabled={busy || queueBusy || !operationsAvailable}
              size="sm"
            >
              <Icon icon="lucide:refresh-cw" className={busy ? "animate-spin" : ""} width="14" />
              同步
            </Button>
            {!schedulerRunning && activeSolverCount > 0 ? (
              <Button
                variant="danger"
                size="sm"
                disabled={busy || queueBusy || stoppingAll}
                onClick={() => setStopAllOpen(true)}
              >
                <Icon icon="lucide:circle-stop" width="14" />
                停止全部 Solver
                <span className="font-mono tabular-nums">{activeSolverCount}</span>
              </Button>
            ) : null}
            <Button
              size="sm"
              onClick={() =>
                void action(schedulerRunning ? "/api/scheduler/auto/pause" : "/api/scheduler/start")
              }
              disabled={
                busy ||
                queueBusy ||
                stoppingAll ||
                (!schedulerRunning && (!scheduler?.available || waitingCount === 0))
              }
            >
              <Icon
                icon={
                  busy ? "lucide:loader-circle" : schedulerRunning ? "lucide:pause" : "lucide:play"
                }
                className={busy ? "animate-spin" : undefined}
                width="14"
              />
              {schedulerRunning
                ? "暂停调度"
                : scheduler?.queued?.length && !scheduler.idle?.length
                  ? "继续调度"
                  : "启动调度"}
              {!schedulerRunning && waitingCount > 0 ? (
                <span className="font-mono tabular-nums opacity-70">{waitingCount}</span>
              ) : null}
            </Button>
          </>
        }
      />

      {error ? <ErrorNotice message={error} className="mb-4" /> : null}

      {contestPending ? (
        <Card className="mb-4 border-amber/30 bg-amber/5">
          <div className="flex items-start gap-3">
            <Icon icon="lucide:timer" width="18" className="mt-0.5 shrink-0 text-amber" />
            <div>
              <h2 className="font-semibold">比赛尚未开始</h2>
              <p className="mt-1! text-sm text-muted-foreground">
                {scheduledStartAt
                  ? `计划开始时间：${absoluteTime(scheduledStartAt)}。开始前不会请求平台。`
                  : "点击“开始比赛”后才会连接平台并同步题目。"}
              </p>
            </div>
          </div>
        </Card>
      ) : null}

      <ProgressOverview {...snapshot.stats} />

      <EnvironmentLedger
        snapshot={snapshot}
        projectId={projectId}
        challengeTitle={(challengeId) => byId.get(challengeId)?.title ?? challengeId}
        releasing={releasingEnvironment}
        onRelease={(environmentId) => void releaseEnvironment(environmentId)}
      />

      {/* ── Announcement candidates ── */}
      {pendingAnnouncements.length > 0 ? (
        <Card className="mb-4 p-0">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground">
                公告审核
              </p>
              <h2 className="mt-0.5 font-semibold">待审核公告</h2>
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                disabled={busy || !operationsAvailable}
                onClick={() => void reviewAnnouncements(pendingAnnouncements, "approved")}
              >
                <Icon icon="lucide:check-check" width="13" />
                全部批准
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={busy || !operationsAvailable}
                onClick={() => void reviewAnnouncements(pendingAnnouncements, "rejected")}
              >
                <Icon icon="lucide:x" width="13" />
                全部拒绝
              </Button>
            </div>
          </div>
          <div className="divide-y divide-border/60">
            {pendingAnnouncements.map((candidate) => (
              <div
                key={`${candidate.challengeId}:${candidate.key}`}
                className="flex flex-wrap items-start justify-between gap-3 px-4 py-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[11px] text-muted-foreground">
                      {candidate.challengeId}
                    </span>
                    <Badge className="text-[9px]">{candidate.kind}</Badge>
                  </div>
                  <p className="mt-1! text-sm font-medium">{candidate.title}</p>
                  <p className="mt-0.5! text-xs text-muted-foreground line-clamp-2">
                    {candidate.content}
                  </p>
                  <time
                    dateTime={candidate.publishedAt}
                    className="mt-1 block text-[10px] text-muted-foreground"
                  >
                    {absoluteTime(candidate.publishedAt)}
                  </time>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={busy || !operationsAvailable}
                    onClick={() => void reviewAnnouncements([candidate], "approved")}
                  >
                    <Icon icon="lucide:check" width="14" />
                    批准
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy || !operationsAvailable}
                    onClick={() => void reviewAnnouncements([candidate], "rejected")}
                  >
                    <Icon icon="lucide:x" width="14" />
                    拒绝
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      {/* ── Scheduler + recent activity ── */}
      <div className="mb-4 grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(20rem,1fr)]">
        <SchedulerWorkbench
          projectId={projectId}
          snapshot={snapshot}
          challenges={byId}
          operationsAvailable={operationsAvailable}
          stageableCount={stageable.length}
          busy={busy || queueBusy}
          onStageAll={() => void stageChallenges(stageable.map((challenge) => challenge.id))}
          onSnapshot={setSnapshot}
          onReload={load}
          onBusyChange={setQueueBusy}
          onError={setError}
        />

        <Card className="flex min-h-0 flex-col p-0">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground">
                运行记录
              </p>
              <h2 className="mt-0.5 font-semibold">近期 Solver</h2>
            </div>
            <Badge tone="neutral">{snapshot.solverLogs.length} 条</Badge>
          </div>
          <div className="max-h-128 flex-1 divide-y divide-border/60 overflow-y-auto overscroll-contain">
            {snapshot.solverLogs.length > 0 ? (
              snapshot.solverLogs.map((entry) => (
                <Link
                  key={entry.id}
                  to={`/projects/${encodeURIComponent(projectId)}/challenges/${encodeURIComponent(entry.challengeId)}`}
                  className="group grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 px-4 py-2.5 transition-colors hover:bg-muted"
                >
                  <span
                    className={cn(
                      "mt-1.5 size-1.5 rounded-full",
                      entry.tone === "danger"
                        ? "bg-danger"
                        : entry.tone === "warning"
                          ? "bg-warning"
                          : entry.tone === "positive"
                            ? "bg-success"
                            : "bg-muted-foreground/50",
                    )}
                  />
                  <div className="min-w-0">
                    <p className="truncate text-xs font-medium group-hover:text-primary">
                      {entry.challengeTitle}
                    </p>
                    <p className="truncate text-[11px] text-muted-foreground">{entry.summary}</p>
                  </div>
                  <time
                    dateTime={entry.createdAt}
                    title={absoluteTime(entry.createdAt)}
                    className="font-mono text-[10px] tabular-nums text-muted-foreground"
                  >
                    {relativeTime(entry.createdAt)}
                  </time>
                </Link>
              ))
            ) : (
              <p className="px-4 py-10 text-center text-sm text-muted-foreground">暂无运行记录。</p>
            )}
          </div>
        </Card>
      </div>

      {/* ── All challenges table ── */}
      <Card id="all" className="p-0">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground">
              题目列表
            </p>
            <h2 className="mt-0.5 font-semibold">全部题目</h2>
          </div>
          <div className="flex w-full items-center gap-1 rounded-md border border-border bg-background p-0.5 sm:w-auto">
            <div className="flex min-w-0 flex-1 items-center gap-2 px-2 sm:w-52">
              <Icon icon="lucide:search" width="14" className="text-muted-foreground" />
              <label htmlFor="challenge-search" className="sr-only">
                搜索题目
              </label>
              <Input
                id="challenge-search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索题目"
                className="h-8 min-w-0 border-0 bg-transparent px-0 text-sm shadow-none focus-visible:bg-transparent focus-visible:ring-0"
              />
            </div>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="h-8 w-28 shrink-0 border-0 bg-muted/70 text-xs shadow-none">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部</SelectItem>
                <SelectItem value="active">执行中</SelectItem>
                <SelectItem value="idle">空闲队列</SelectItem>
                <SelectItem value="queued">执行队列</SelectItem>
                <SelectItem value="pending">未调度</SelectItem>
                <SelectItem value="excluded">不调度</SelectItem>
                <SelectItem value="solved">已解出</SelectItem>
                <SelectItem value="attention">需处理</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        {!schedulerRunning && selectedEditableIds.length > 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-muted/35 px-4 py-2.5">
            <p className="text-xs">
              已选 <strong className="font-mono tabular-nums">{selectedEditableIds.length}</strong>{" "}
              题
              <span className="ml-2 text-muted-foreground">
                可加入 {selectedStageableIds.length} · 可移出 {selectedIdleIds.length}
              </span>
            </p>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button
                size="sm"
                variant="ghost"
                disabled={queueBusy}
                onClick={() => setSelectedChallengeIds([])}
              >
                清除选择
              </Button>
              {selectedIdleIds.length > 0 ? (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={queueBusy || !operationsAvailable}
                  onClick={() => void unstageChallenges(selectedIdleIds)}
                >
                  <Icon icon="lucide:list-minus" width="13" aria-hidden="true" />
                  移出空闲队列
                </Button>
              ) : null}
              {selectedStageableIds.length > 0 ? (
                <Button
                  size="sm"
                  disabled={queueBusy || !operationsAvailable}
                  onClick={() => void stageChallenges(selectedStageableIds)}
                >
                  <Icon
                    icon={queueBusy ? "lucide:loader-circle" : "lucide:list-plus"}
                    className={queueBusy ? "animate-spin" : undefined}
                    width="13"
                    aria-hidden="true"
                  />
                  加入空闲队列
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
        {visible.length === 0 ? (
          <div className="flex flex-col items-center py-16 text-center">
            <Icon icon="lucide:search-x" width="28" className="text-muted-foreground/40" />
            <p className="mt-3! text-sm text-muted-foreground">无匹配题目</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border text-left text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                  {!schedulerRunning ? (
                    <th scope="col" className="w-11 py-3 pl-4 pr-1 font-medium">
                      <Checkbox
                        checked={
                          allVisibleSelected
                            ? true
                            : visibleEditable.some((challenge) => selectedIds.has(challenge.id))
                              ? "indeterminate"
                              : false
                        }
                        disabled={queueBusy || !operationsAvailable || visibleEditable.length === 0}
                        aria-label="选择当前筛选结果中可调整队列的题目"
                        onCheckedChange={(checked) => toggleVisibleSelection(checked === true)}
                      />
                    </th>
                  ) : null}
                  <th
                    scope="col"
                    className={cn("py-3 pr-3 font-medium", schedulerRunning ? "pl-5" : "pl-2")}
                  >
                    题目
                  </th>
                  <th scope="col" className="hidden py-3 px-3 font-medium md:table-cell">
                    分类
                  </th>
                  <th scope="col" className="hidden py-3 px-3 font-medium sm:table-cell">
                    分值
                  </th>
                  <th scope="col" className="hidden py-3 px-3 font-medium lg:table-cell">
                    尝试
                  </th>
                  <th scope="col" className="py-3 px-3 font-medium">
                    状态
                  </th>
                  <th scope="col" className="py-3 pr-5">
                    <span className="sr-only">操作</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {visible.map((c) => (
                  <tr key={c.id} className="transition-colors hover:bg-muted">
                    {!schedulerRunning ? (
                      <td className="w-11 py-3 pl-4 pr-1">
                        <Checkbox
                          checked={selectedIds.has(c.id)}
                          disabled={queueBusy || !operationsAvailable || !canEditIdleQueue(c)}
                          aria-label={`${
                            c.status === "idle" ? "选择移出空闲队列" : "选择加入空闲队列"
                          }：${c.title}`}
                          title={canEditIdleQueue(c) ? undefined : "当前状态不能调整空闲队列"}
                          onCheckedChange={(checked) =>
                            toggleChallengeSelection(c.id, checked === true)
                          }
                        />
                      </td>
                    ) : null}
                    <td className={cn("py-3 pr-3", schedulerRunning ? "pl-5" : "pl-2")}>
                      <Link
                        to={`/projects/${encodeURIComponent(projectId)}/challenges/${encodeURIComponent(c.id)}`}
                        className="block rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                      >
                        <p className="text-sm font-medium hover:text-primary">{c.title}</p>
                        <p className="text-xs text-muted-foreground">
                          {c.status === "solved" && c.lastActivityAt
                            ? `解出于 ${relativeTime(c.lastActivityAt)}`
                            : c.progress}
                        </p>
                      </Link>
                    </td>
                    <td className="hidden py-3 px-3 text-sm text-muted-foreground md:table-cell">
                      {c.category}
                    </td>
                    <td className="hidden py-3 px-3 font-mono text-sm tabular-nums text-muted-foreground sm:table-cell">
                      {c.score}
                    </td>
                    <td className="hidden py-3 px-3 font-mono text-sm tabular-nums text-muted-foreground lg:table-cell">
                      {c.attempts}
                    </td>
                    <td className="py-3 px-3">
                      <Badge tone={toneForStatus(c.status)}>
                        {STATUS_LABELS[c.status] ?? c.status}
                      </Badge>
                    </td>
                    <td
                      className="py-3 pr-5"
                      onClick={(event) => event.stopPropagation()}
                      onKeyDown={(event) => event.stopPropagation()}
                    >
                      <div className="flex items-center justify-end gap-1">
                        <Select
                          value={c.schedulingDisposition ?? "default"}
                          disabled={queueBusy || schedulingBusy === c.id || !operationsAvailable}
                          onValueChange={(value) =>
                            void setSchedulingDisposition(
                              c.id,
                              value as "default" | "excluded" | "solved",
                            )
                          }
                        >
                          <SelectTrigger
                            hideIcon
                            className="size-8 justify-center border-0 bg-transparent p-0 shadow-none hover:bg-muted"
                            aria-label={`设置 ${c.title} 的调度状态`}
                          >
                            <Icon
                              icon={
                                schedulingBusy === c.id ? "lucide:loader-circle" : "lucide:ellipsis"
                              }
                              className={schedulingBusy === c.id ? "animate-spin" : ""}
                              width="15"
                              aria-hidden="true"
                            />
                          </SelectTrigger>
                          <SelectContent align="end">
                            <SelectItem value="default">跟随调度</SelectItem>
                            <SelectItem value="excluded">不调度</SelectItem>
                            <SelectItem value="solved">已解出</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <ConfirmDialog
        open={stopAllOpen && activeSolverCount > 0}
        onOpenChange={setStopAllOpen}
        title="停止全部正在执行的 Solver？"
        description={`将正常中止 ${activeSolverCount} 个 Solver，并依次回收其 SubAgent、远程环境和 Docker Sandbox。调度将保持暂停。`}
        confirmLabel="停止全部 Solver"
        busy={stoppingAll}
        busyLabel="正在停止…"
        onConfirm={() => void stopAllSolvers()}
      />
    </div>
  )
}
