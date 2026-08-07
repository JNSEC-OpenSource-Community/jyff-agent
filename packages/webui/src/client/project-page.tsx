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
import type { DashboardChallenge, DashboardSnapshot } from "../types.ts"
import { apiMutation, apiRequest, projectApi } from "./api.ts"
import { relativeTime, STATUS_LABELS } from "./lib.ts"
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  PageHeader,
  Spinner,
} from "./ui.tsx"

function statusTone(
  status: string,
): "neutral" | "positive" | "warning" | "danger" | "info" {
  if (status === "solved") return "positive"
  if (["running", "preparing", "writing_writeup", "blocking"].includes(status))
    return "info"
  if (["failed", "timed_out", "blocked", "interrupted"].includes(status))
    return "danger"
  if (status === "queued") return "warning"
  return "neutral"
}

function SortableQueueItem({
  entry,
  challenge,
}: {
  entry: SchedulerQueueEntry
  challenge?: DashboardChallenge
}): React.ReactElement {
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
      className={isDragging ? "queue-item is-dragging" : "queue-item"}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <button
        type="button"
        className="drag-handle"
        aria-label={`拖动 ${challenge?.title ?? entry.challengeId}`}
        {...attributes}
        {...listeners}
      >
        <Icon icon="lucide:grip-vertical" width="18" />
      </button>
      <span className="queue-position">
        {String(entry.position).padStart(2, "0")}
      </span>
      <div className="queue-copy">
        <strong>{challenge?.title ?? entry.challengeId}</strong>
        <small>
          {challenge?.category ?? entry.source} · {challenge?.score ?? 0} pts
        </small>
      </div>
      {entry.lane === "blocked" ? (
        <Badge tone="danger">Blocked lane</Badge>
      ) : null}
    </div>
  )
}

export function ProjectPage(): React.ReactElement {
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
    const next = await apiRequest<DashboardSnapshot>(
      projectApi(projectId, "/api/snapshot"),
    )
    setSnapshot(next)
    setQueue(next.scheduler?.queued ?? [])
  }, [projectId])

  useEffect(() => {
    setError("")
    void load().catch((cause) =>
      setError(cause instanceof Error ? cause.message : String(cause)),
    )
    const events = new EventSource(projectApi(projectId, "/api/events"))
    events.addEventListener("snapshot", (event) => {
      const next = JSON.parse(
        (event as MessageEvent<string>).data,
      ) as DashboardSnapshot
      setSnapshot(next)
      setQueue(next.scheduler?.queued ?? [])
    })
    return () => events.close()
  }, [load, projectId])

  const challengeById = useMemo(
    () =>
      new Map(
        snapshot?.challenges.map((challenge) => [challenge.id, challenge]) ??
          [],
      ),
    [snapshot],
  )

  async function schedulerAction(path: string): Promise<void> {
    setBusy(true)
    setError("")
    try {
      const next = await apiMutation<DashboardSnapshot>(
        projectApi(projectId, path),
        "POST",
      )
      setSnapshot(next)
      setQueue(next.scheduler?.queued ?? [])
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  async function onDragEnd(event: DragEndEvent): Promise<void> {
    if (!event.over || event.active.id === event.over.id) return
    const oldIndex = queue.findIndex(
      (item) => item.challengeId === event.active.id,
    )
    const newIndex = queue.findIndex(
      (item) => item.challengeId === event.over?.id,
    )
    if (oldIndex < 0 || newIndex < 0) return
    const moving = queue[oldIndex]
    if (!moving) return
    const optimistic = arrayMove(queue, oldIndex, newIndex).map(
      (item, index) => ({ ...item, position: index + 1 }),
    )
    setQueue(optimistic)
    try {
      const next = await apiMutation<DashboardSnapshot>(
        projectApi(
          projectId,
          `/api/scheduler/queue/${encodeURIComponent(moving.challengeId)}`,
        ),
        "PATCH",
        {
          position: newIndex + 1,
          expectedVersion: moving.version,
          overrideBlockedLane: false,
        },
      )
      setSnapshot(next)
      setQueue(next.scheduler?.queued ?? [])
    } catch (cause) {
      setQueue(snapshot?.scheduler?.queued ?? [])
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  if (!snapshot) return <Spinner label="正在同步比赛状态" />

  const recent = [...snapshot.challenges]
    .sort(
      (left, right) =>
        Date.parse(right.lastActivityAt ?? "0") -
        Date.parse(left.lastActivityAt ?? "0"),
    )
    .slice(0, 8)
  const visibleChallenges = snapshot.challenges
    .filter((challenge) => {
      if (statusFilter === "all") return true
      if (statusFilter === "active") {
        return ["preparing", "running", "blocking", "writing_writeup"].includes(
          challenge.status,
        )
      }
      if (statusFilter === "attention") {
        return ["failed", "timed_out", "blocked", "interrupted"].includes(
          challenge.status,
        )
      }
      return challenge.status === statusFilter
    })
    .filter((challenge) => {
      const normalized = query.trim().toLocaleLowerCase("zh-CN")
      return (
        !normalized ||
        challenge.title.toLocaleLowerCase("zh-CN").includes(normalized) ||
        challenge.category.toLocaleLowerCase("zh-CN").includes(normalized)
      )
    })
    .sort((left, right) => {
      if (left.status === "running" && right.status !== "running") return -1
      if (right.status === "running" && left.status !== "running") return 1
      return (
        right.score - left.score ||
        left.title.localeCompare(right.title, "zh-CN")
      )
    })

  return (
    <div className="page project-dashboard">
      <PageHeader
        eyebrow={`${snapshot.overview.id} · LIVE CONTROL`}
        title={snapshot.overview.name}
        description={`${snapshot.overview.challenges} 道题目，最近同步于 ${relativeTime(snapshot.generatedAt)}。`}
        actions={
          <>
            <Button
              variant="secondary"
              onClick={() => void schedulerAction("/api/refresh")}
              disabled={busy}
            >
              <Icon
                icon="lucide:refresh-cw"
                className={busy ? "spin" : ""}
                width="16"
              />{" "}
              同步
            </Button>
            <Button
              onClick={() =>
                void schedulerAction(
                  snapshot.scheduler?.autoEnabled
                    ? "/api/scheduler/auto/pause"
                    : "/api/scheduler/auto/start",
                )
              }
              disabled={busy || !snapshot.scheduler?.available}
            >
              <Icon
                icon={
                  snapshot.scheduler?.autoEnabled
                    ? "lucide:pause"
                    : "lucide:play"
                }
                width="16"
              />
              {snapshot.scheduler?.autoEnabled
                ? "暂停自动调度"
                : "启动自动调度"}
            </Button>
          </>
        }
      />
      {error ? <ErrorNotice message={error} /> : null}
      <div className="metric-grid">
        {[
          ["已解出", snapshot.stats.solved, "lucide:flag", "positive"],
          ["执行中", snapshot.stats.active, "lucide:activity", "info"],
          ["队列中", snapshot.stats.queued, "lucide:list-ordered", "warning"],
          ["需处理", snapshot.stats.failed, "lucide:triangle-alert", "danger"],
        ].map(([label, value, icon, tone]) => (
          <Card className="metric-card" key={String(label)}>
            <div className={`metric-icon metric-${tone}`}>
              <Icon icon={String(icon)} width="19" />
            </div>
            <strong>{value}</strong>
            <span>{label}</span>
          </Card>
        ))}
      </div>
      <div className="dashboard-columns">
        <Card className="panel queue-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">SCHEDULER</p>
              <h2>待执行队列</h2>
            </div>
            <Badge
              tone={snapshot.scheduler?.autoEnabled ? "positive" : "neutral"}
            >
              {snapshot.scheduler?.autoEnabled ? "AUTO ON" : "AUTO OFF"}
            </Badge>
          </div>
          {queue.length ? (
            <DndContext
              sensors={sensors}
              onDragEnd={(event) => void onDragEnd(event)}
            >
              <SortableContext
                items={queue.map((item) => item.challengeId)}
                strategy={verticalListSortingStrategy}
              >
                <div className="queue-list">
                  {queue.map((entry) => (
                    <SortableQueueItem
                      key={entry.challengeId}
                      entry={entry}
                      challenge={challengeById.get(entry.challengeId)}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          ) : (
            <EmptyState
              icon="lucide:list-checks"
              title="队列为空"
              description="启动自动调度，或从题目列表手动派发 Solver。"
            />
          )}
        </Card>
        <Card className="panel activity-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">CHALLENGES</p>
              <h2>最近题目</h2>
            </div>
            <span className="panel-count">{snapshot.stats.total}</span>
          </div>
          <div className="challenge-list">
            {recent.map((challenge) => (
              <Link
                key={challenge.id}
                to={`/projects/${encodeURIComponent(projectId)}/challenges/${encodeURIComponent(challenge.id)}`}
                className="challenge-row"
              >
                <div className="challenge-category">
                  {challenge.category.slice(0, 3).toUpperCase()}
                </div>
                <div className="challenge-copy">
                  <strong>{challenge.title}</strong>
                  <small>
                    {challenge.score} pts · {challenge.progress}
                  </small>
                </div>
                <Badge tone={statusTone(challenge.status)}>
                  {STATUS_LABELS[challenge.status] ?? challenge.status}
                </Badge>
                <Icon icon="lucide:chevron-right" width="16" />
              </Link>
            ))}
          </div>
        </Card>
      </div>
      <Card className="panel all-challenges-panel">
        <div className="challenge-browser-heading">
          <div>
            <p className="eyebrow">ALL TARGETS</p>
            <h2>全部题目</h2>
          </div>
          <div className="challenge-filters">
            <label className="search-field">
              <Icon icon="lucide:search" width="15" />
              <span className="sr-only">搜索题目</span>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索名称或分类"
              />
            </label>
            <select
              aria-label="状态筛选"
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
            >
              <option value="all">全部状态</option>
              <option value="active">执行中</option>
              <option value="queued">队列中</option>
              <option value="pending">未调度</option>
              <option value="solved">已解出</option>
              <option value="attention">需处理</option>
            </select>
          </div>
        </div>
        <div className="challenge-table">
          <div className="challenge-table-header">
            <span>题目</span>
            <span>分类</span>
            <span>分值</span>
            <span>尝试</span>
            <span>状态</span>
            <span />
          </div>
          {visibleChallenges.map((challenge) => (
            <Link
              key={challenge.id}
              to={`/projects/${encodeURIComponent(projectId)}/challenges/${encodeURIComponent(challenge.id)}`}
              className="challenge-table-row"
            >
              <span>
                <strong>{challenge.title}</strong>
                <small>{challenge.progress}</small>
              </span>
              <span>{challenge.category}</span>
              <span>{challenge.score}</span>
              <span>{challenge.attempts}</span>
              <span>
                <Badge tone={statusTone(challenge.status)}>
                  {STATUS_LABELS[challenge.status] ?? challenge.status}
                </Badge>
              </span>
              <span>
                <Icon icon="lucide:arrow-up-right" width="15" />
              </span>
            </Link>
          ))}
          {visibleChallenges.length === 0 ? (
            <EmptyState
              icon="lucide:search-x"
              title="没有匹配的题目"
              description="调整关键词或状态筛选后重试。"
            />
          ) : null}
        </div>
      </Card>
    </div>
  )
}
