import type { SchedulerQueueEntry } from "@ctf-agent/core"
import {
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core"
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { Icon } from "@iconify/react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { Link, useParams } from "react-router-dom"
import {
  Badge,
  Button,
  Card,
  ErrorNotice,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
} from "../components/index.ts"
import { apiMutation, apiRequest, projectApi } from "../lib/api.ts"
import {
  filterChallenges,
  recentChallenges,
  sortChallenges,
  toneForStatus,
} from "../lib/challenge.ts"
import { STATUS_LABELS } from "../lib/labels.ts"
import { absoluteTime, relativeTime } from "../lib/time.ts"
import { cn } from "../lib/utils.ts"
import type { DashboardChallenge, DashboardSnapshot } from "../types.ts"

/* ── Sortable queue item ── */

function QueueItem({
  entry,
  challenge,
}: {
  entry: SchedulerQueueEntry
  challenge?: DashboardChallenge
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: entry.challengeId })
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      {...attributes}
      {...listeners}
      className={cn(
        "flex cursor-grab items-center gap-2 rounded-lg border border-border bg-card px-3 py-2.5 text-sm transition-all hover:border-primary/30 hover:cursor-grab active:cursor-grabbing",
        isDragging &&
          "cursor-grabbing border-dashed border-primary/40 opacity-60 shadow-lg",
      )}
    >
      <Icon
        icon="lucide:grip-vertical"
        width="14"
        className="shrink-0 text-muted-foreground"
      />
      <span className="w-5 text-center font-mono text-[11px] text-muted-foreground tabular-nums">
        {entry.position}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">
          {challenge?.title ?? entry.challengeId}
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {challenge?.category ?? entry.source} · {challenge?.score ?? 0} pts
        </p>
      </div>
      {entry.lane === "blocked" && (
        <Badge tone="danger" className="shrink-0 text-[10px]">
          Blocked
        </Badge>
      )}
    </div>
  )
}

/* ── Stat card ── */

const statColors: Record<string, { icon: string; tone: string; text: string }> =
  {
    green: {
      icon: "text-green",
      tone: "bg-green/10",
      text: "text-green",
    },
    cyan: {
      icon: "text-info",
      tone: "bg-info/10",
      text: "text-info",
    },
    amber: {
      icon: "text-warning",
      tone: "bg-warning/10",
      text: "text-warning",
    },
    danger: {
      icon: "text-danger",
      tone: "bg-danger/10",
      text: "text-danger",
    },
  }

function StatCard({
  label,
  value,
  icon,
  color,
}: {
  label: string
  value: number | string
  icon: string
  color: string
}) {
  const c =
    statColors[color] ??
    ({
      icon: "text-green",
      tone: "bg-green/10",
      text: "text-green",
    } as {
      icon: string
      tone: string
      text: string
    })
  return (
    <Card className="surface-hover relative overflow-hidden p-0">
      <div className="flex items-center gap-4 p-5">
        <div
          className={cn(
            "flex size-11 shrink-0 items-center justify-center rounded-lg",
            c.tone,
          )}
        >
          <Icon icon={icon} width="21" className={c.icon} />
        </div>
        <div>
          <p
            className={cn(
              "text-3xl font-bold tabular-nums tracking-tight font-mono",
              c.text,
            )}
          >
            {value}
          </p>
          <p className="mt-0.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            {label}
          </p>
        </div>
      </div>
    </Card>
  )
}

/* ── Page ── */

export function ProjectPage() {
  const { projectId = "" } = useParams()
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null)
  const [queue, setQueue] = useState<SchedulerQueueEntry[]>([])
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState("")
  const [statusFilter, setStatusFilter] = useState("all")

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  )

  const load = useCallback(async () => {
    setError("")
    const s = await apiRequest<DashboardSnapshot>(
      projectApi(projectId, "/api/snapshot"),
    )
    setSnapshot(s)
    setQueue(s.scheduler?.queued ?? [])
  }, [projectId])

  useEffect(() => {
    void load().catch((e) =>
      setError(String(e instanceof Error ? e.message : e)),
    )
    const es = new EventSource(projectApi(projectId, "/api/events"))
    es.addEventListener("snapshot", (ev) => {
      const s = JSON.parse(
        (ev as MessageEvent<string>).data,
      ) as DashboardSnapshot
      setSnapshot(s)
      setQueue(s.scheduler?.queued ?? [])
    })
    return () => es.close()
  }, [load, projectId])

  const byId = useMemo(
    () => new Map(snapshot?.challenges.map((c) => [c.id, c]) ?? []),
    [snapshot],
  )

  async function action(path: string) {
    setBusy(true)
    setError("")
    try {
      const s = await apiMutation<DashboardSnapshot>(
        projectApi(projectId, path),
        "POST",
      )
      setSnapshot(s)
      setQueue(s.scheduler?.queued ?? [])
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e))
    } finally {
      setBusy(false)
    }
  }

  async function onDragEnd(event: DragEndEvent) {
    if (!event.over || event.active.id === event.over.id) return
    const oi = queue.findIndex((i) => i.challengeId === event.active.id)
    const ni = queue.findIndex((i) => i.challengeId === event.over?.id)
    if (oi < 0 || ni < 0) return
    const m = queue[oi]
    if (!m) return
    // 先乐观更新本地顺序，避免拖拽后闪烁
    setQueue(
      arrayMove(queue, oi, ni).map((i, idx) => ({ ...i, position: idx + 1 })),
    )
    try {
      const s = await apiMutation<DashboardSnapshot>(
        projectApi(
          projectId,
          `/api/scheduler/queue/${encodeURIComponent(m.challengeId)}`,
        ),
        "PATCH",
        {
          position: ni + 1,
          expectedVersion: m.version,
          overrideBlockedLane: false,
        },
      )
      setSnapshot(s)
      setQueue(s.scheduler?.queued ?? [])
    } catch (e) {
      // version conflict 静默回退到服务端权威状态，不显示错误
      void load().catch(() => {
        setQueue(snapshot?.scheduler?.queued ?? [])
      })
      const msg = String(e instanceof Error ? e.message : e)
      if (!msg.includes("version conflict")) {
        setError(msg)
      }
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

  const recent = recentChallenges(snapshot.challenges, 5)
  const visible = sortChallenges(
    filterChallenges(snapshot.challenges, { query, statusFilter }),
  )

  return (
    <div className="page-container">
      {/* Header */}
      <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="hero-eyebrow text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">
            {snapshot.overview.id} · Live
          </p>
          <h1 className="hero-title mt-3 text-3xl font-bold tracking-tight">
            {snapshot.overview.name}
          </h1>
          <p className="hero-desc mt-3 text-sm text-muted-foreground">
            {snapshot.overview.challenges} 题 ·{" "}
            {relativeTime(snapshot.generatedAt)}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            onClick={() => void action("/api/refresh")}
            disabled={busy}
            size="sm"
          >
            <Icon
              icon="lucide:refresh-cw"
              className={busy ? "animate-spin" : ""}
              width="14"
            />
            同步
          </Button>
          <Button
            size="sm"
            onClick={() =>
              void action(
                snapshot.scheduler?.autoEnabled
                  ? "/api/scheduler/auto/pause"
                  : "/api/scheduler/auto/start",
              )
            }
            disabled={busy || !snapshot.scheduler?.available}
          >
            <Icon
              icon={
                snapshot.scheduler?.autoEnabled ? "lucide:pause" : "lucide:play"
              }
              width="14"
            />
            {snapshot.scheduler?.autoEnabled ? "暂停调度" : "启动调度"}
          </Button>
        </div>
      </header>

      {error ? <ErrorNotice message={error} className="mb-6" /> : null}

      {/* ── Stat cards ── */}
      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="解题情况"
          value={`${snapshot.stats.solved}/${snapshot.stats.total}`}
          icon="lucide:flag"
          color="green"
        />
        <StatCard
          label="执行中"
          value={snapshot.stats.active}
          icon="lucide:activity"
          color="cyan"
        />
        <StatCard
          label="队列中"
          value={snapshot.stats.queued}
          icon="lucide:list-ordered"
          color="amber"
        />
        <StatCard
          label="需处理"
          value={snapshot.stats.failed}
          icon="lucide:triangle-alert"
          color="danger"
        />
      </div>

      {/* ── Announcement candidates ── */}
      {pendingAnnouncements.length > 0 ? (
        <Card className="mb-6 p-0">
          <div className="flex items-center justify-between border-b border-border px-5 py-3">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground">
                Review
              </p>
              <h2 className="mt-0.5 font-semibold">待审核公告</h2>
            </div>
            <Badge tone="warning" className="text-[10px]">
              {pendingAnnouncements.length}
            </Badge>
          </div>
          <div className="divide-y divide-border/60">
            {pendingAnnouncements.map((candidate) => (
              <div
                key={`${candidate.challengeId}:${candidate.key}`}
                className="flex flex-wrap items-start justify-between gap-3 px-5 py-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[11px] text-muted-foreground">
                      {candidate.challengeId}
                    </span>
                    <Badge className="text-[9px]">{candidate.kind}</Badge>
                  </div>
                  <p className="mt-1 text-sm font-medium">{candidate.title}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground line-clamp-2">
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
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true)
                      setError("")
                      try {
                        await apiMutation(
                          projectApi(projectId, "/api/announcements/review"),
                          "POST",
                          {
                            challengeId: candidate.challengeId,
                            announcementKey: candidate.key,
                            status: "approved",
                          },
                        )
                        await load()
                      } catch (e) {
                        setError(String(e instanceof Error ? e.message : e))
                      } finally {
                        setBusy(false)
                      }
                    }}
                  >
                    <Icon icon="lucide:check" width="14" />
                    批准
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true)
                      setError("")
                      try {
                        await apiMutation(
                          projectApi(projectId, "/api/announcements/review"),
                          "POST",
                          {
                            challengeId: candidate.challengeId,
                            announcementKey: candidate.key,
                            status: "rejected",
                          },
                        )
                        await load()
                      } catch (e) {
                        setError(String(e instanceof Error ? e.message : e))
                      } finally {
                        setBusy(false)
                      }
                    }}
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

      {/* ── Two columns ── */}
      <div className="mb-6 grid gap-5 lg:grid-cols-[1fr_1.5fr]">
        {/* Queue */}
        <Card className="flex min-h-0 flex-col p-0">
          <div className="flex items-center justify-between border-b border-border px-5 py-4">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground">
                Scheduler
              </p>
              <h2 className="mt-0.5 font-semibold">待执行队列</h2>
            </div>
            <Badge
              tone={snapshot.scheduler?.autoEnabled ? "positive" : "neutral"}
              className="text-[10px]"
            >
              {snapshot.scheduler?.autoEnabled ? "AUTO" : "MANUAL"}
            </Badge>
          </div>
          <div className="flex flex-1 flex-col p-3">
            {queue.length > 0 ? (
              <DndContext
                sensors={sensors}
                onDragEnd={(event) => void onDragEnd(event)}
              >
                <SortableContext
                  items={queue.map((i) => i.challengeId)}
                  strategy={verticalListSortingStrategy}
                >
                  <div className="flex flex-col gap-1.5">
                    {queue.map((e) => (
                      <QueueItem
                        key={e.challengeId}
                        entry={e}
                        challenge={byId.get(e.challengeId)}
                      />
                    ))}
                  </div>
                </SortableContext>
              </DndContext>
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center py-12 text-center">
                <div className="flex size-12 items-center justify-center rounded-full border border-border bg-muted/50">
                  <Icon
                    icon="lucide:list-checks"
                    width="22"
                    className="text-muted-foreground"
                  />
                </div>
                <p className="mt-3 text-sm font-medium text-muted-foreground">
                  队列为空
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  启动调度或手动派发题目
                </p>
              </div>
            )}
          </div>
        </Card>

        {/* Recent */}
        <Card className="flex min-h-0 flex-col p-0">
          <div className="flex items-center justify-between border-b border-border px-5 py-4">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground">
                Recent
              </p>
              <h2 className="mt-0.5 font-semibold">最近活跃</h2>
            </div>
            <span className="font-mono text-lg font-semibold tabular-nums text-muted-foreground">
              {snapshot.stats.total}
            </span>
          </div>
          <div className="flex-1 divide-y divide-border/60">
            {recent.map((c) => (
              <Link
                key={c.id}
                to={`/projects/${encodeURIComponent(projectId)}/challenges/${encodeURIComponent(c.id)}`}
                className="group flex items-center gap-3 px-5 py-3 transition-colors hover:bg-muted"
              >
                <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border font-mono text-[10px] font-bold text-muted-foreground">
                  {c.category.slice(0, 3).toUpperCase()}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium group-hover:text-primary transition-colors">
                    {c.title}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {c.score} pts
                    {c.status === "solved" && c.lastActivityAt
                      ? ` · 解出 ${relativeTime(c.lastActivityAt)}`
                      : ` · ${c.progress}`}
                  </p>
                </div>
                <Badge
                  tone={toneForStatus(c.status)}
                  className="shrink-0 text-[10px]"
                >
                  {STATUS_LABELS[c.status] ?? c.status}
                </Badge>
                <Icon
                  icon="lucide:chevron-right"
                  width="13"
                  className="shrink-0 text-muted-foreground/40"
                />
              </Link>
            ))}
            {snapshot.challenges.length > 5 && (
              <a
                href="#all"
                className="flex items-center justify-center gap-1.5 px-5 py-3 text-sm text-muted-foreground transition-colors hover:text-foreground"
              >
                全部 {snapshot.challenges.length} 题{" "}
                <Icon icon="lucide:arrow-down" width="13" />
              </a>
            )}
          </div>
        </Card>
      </div>

      {/* ── All challenges table ── */}
      <Card id="all" className="p-0">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground">
              All Targets
            </p>
            <h2 className="mt-0.5 font-semibold">全部题目</h2>
          </div>
          <div className="flex w-full items-center gap-1 rounded-lg border border-border bg-background/40 p-1 sm:w-auto">
            <div className="flex min-w-0 flex-1 items-center gap-2 px-2 sm:w-52">
              <Icon
                icon="lucide:search"
                width="14"
                className="text-muted-foreground"
              />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索..."
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
                <SelectItem value="queued">队列中</SelectItem>
                <SelectItem value="pending">未调度</SelectItem>
                <SelectItem value="solved">已解出</SelectItem>
                <SelectItem value="attention">需处理</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        {visible.length === 0 ? (
          <div className="flex flex-col items-center py-16 text-center">
            <Icon
              icon="lucide:search-x"
              width="28"
              className="text-muted-foreground/40"
            />
            <p className="mt-3! text-sm text-muted-foreground">无匹配题目</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border text-left text-[10px] font-bold uppercase tracking-[0.1em] text-muted-foreground">
                  <th className="py-3 pl-5 pr-3 font-medium">题目</th>
                  <th className="hidden py-3 px-3 font-medium md:table-cell">
                    分类
                  </th>
                  <th className="hidden py-3 px-3 font-medium sm:table-cell">
                    分值
                  </th>
                  <th className="hidden py-3 px-3 font-medium lg:table-cell">
                    尝试
                  </th>
                  <th className="py-3 px-3 font-medium">状态</th>
                  <th className="py-3 pr-5"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {visible.map((c) => (
                  <tr
                    key={c.id}
                    className="cursor-pointer transition-colors hover:bg-muted"
                    onClick={() => {
                      window.location.href = `/projects/${encodeURIComponent(projectId)}/challenges/${encodeURIComponent(c.id)}`
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        window.location.href = `/projects/${encodeURIComponent(projectId)}/challenges/${encodeURIComponent(c.id)}`
                      }
                    }}
                    tabIndex={0}
                    role="link"
                  >
                    <td className="py-3 pl-5 pr-3">
                      <p className="text-sm font-medium">{c.title}</p>
                      <p className="text-xs text-muted-foreground">
                        {c.status === "solved" && c.lastActivityAt
                          ? `解出于 ${relativeTime(c.lastActivityAt)}`
                          : c.progress}
                      </p>
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
                      <Badge
                        tone={toneForStatus(c.status)}
                        className="text-[10px]"
                      >
                        {STATUS_LABELS[c.status] ?? c.status}
                      </Badge>
                    </td>
                    <td className="py-3 pr-5">
                      <Icon
                        icon="lucide:chevron-right"
                        width="14"
                        className="text-muted-foreground/40"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  )
}
