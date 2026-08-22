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
import { useEffect, useState } from "react"
import { Badge, Button, Card } from "../../components/index.ts"
import { ApiError, apiMutation, projectApi } from "../../lib/api.ts"
import { cn } from "../../lib/utils.ts"
import type { DashboardChallenge, DashboardSnapshot } from "../../types.ts"

interface SchedulerWorkbenchProps {
  projectId: string
  snapshot: DashboardSnapshot
  challenges: ReadonlyMap<string, DashboardChallenge>
  operationsAvailable: boolean
  stageableCount: number
  busy: boolean
  onStageAll: () => void
  onSnapshot: (snapshot: DashboardSnapshot) => void
  onReload: () => Promise<void>
  onBusyChange: (busy: boolean) => void
  onError: (message: string) => void
}

function queueStateLabel(snapshot: DashboardSnapshot): {
  label: string
  tone: "neutral" | "positive" | "warning"
} {
  const scheduler = snapshot.scheduler
  if (!scheduler) return { label: "未就绪", tone: "neutral" }
  if (scheduler.state === "suspended") return { label: "系统暂停", tone: "warning" }
  if (scheduler?.mode === "automatic") return { label: "自动执行", tone: "positive" }
  if (scheduler?.mode === "manual") return { label: "正在执行", tone: "positive" }
  return { label: "已暂停", tone: "neutral" }
}

function QueueRow({
  entry,
  challenge,
  disabled,
  removable = false,
  removing = false,
  onRemove,
}: {
  entry: SchedulerQueueEntry
  challenge?: DashboardChallenge
  disabled: boolean
  removable?: boolean
  removing?: boolean
  onRemove?: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: entry.challengeId,
    disabled,
  })
  return (
    <div
      ref={setNodeRef}
      data-queue-id={entry.challengeId}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "group grid grid-cols-[auto_auto_minmax(0,1fr)_auto] items-center gap-2.5 px-3 py-2.5 transition-colors",
        !disabled && "hover:bg-muted",
        isDragging && "relative z-10 bg-muted opacity-70 shadow-sm",
      )}
    >
      <button
        type="button"
        className={cn(
          "flex size-7 items-center justify-center rounded-sm text-muted-foreground outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40",
          disabled
            ? "cursor-default opacity-35"
            : "cursor-grab hover:bg-background active:cursor-grabbing",
        )}
        disabled={disabled}
        aria-label={`拖动排序：${challenge?.title ?? entry.challengeId}`}
        {...attributes}
        {...listeners}
      >
        <Icon icon="lucide:grip-vertical" width="14" aria-hidden="true" />
      </button>
      <span className="w-5 text-center font-mono text-[10px] tabular-nums text-quiet">
        {entry.position}
      </span>
      <div className="min-w-0">
        <p className="truncate text-xs font-medium">{challenge?.title ?? entry.challengeId}</p>
        <p className="truncate text-[10px] text-muted-foreground">
          {challenge?.category ?? entry.source} · {challenge?.score ?? 0} pts
        </p>
      </div>
      {entry.lane === "blocked" ? (
        <Badge tone="danger" className="text-[9px]">
          Blocked
        </Badge>
      ) : removable ? (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-7 opacity-70 group-hover:opacity-100"
          disabled={removing || disabled}
          aria-label={`从空闲队列移除：${challenge?.title ?? entry.challengeId}`}
          onClick={onRemove}
        >
          <Icon
            icon={removing ? "lucide:loader-circle" : "lucide:x"}
            className={removing ? "animate-spin" : undefined}
            width="13"
            aria-hidden="true"
          />
        </Button>
      ) : (
        <span className="font-mono text-[9px] uppercase tracking-wide text-quiet">
          {entry.source === "retry" ? "retry" : "ready"}
        </span>
      )}
    </div>
  )
}

function QueueEmpty({
  kind,
  planning,
  canStageAll,
  busy,
  onStageAll,
}: {
  kind: "idle" | "execution"
  planning: boolean
  canStageAll: boolean
  busy: boolean
  onStageAll: () => void
}) {
  return (
    <div className="flex min-h-44 flex-col items-center justify-center px-5 py-8 text-center">
      <Icon
        icon={kind === "idle" ? "lucide:rows-3" : "lucide:circle-dashed"}
        width="20"
        className="text-quiet"
        aria-hidden="true"
      />
      <p className="mt-3! text-xs font-medium">
        {kind === "idle" ? "还没有安排题目" : "没有等待执行的题目"}
      </p>
      <p className="mt-1! max-w-60 text-[11px] leading-5 text-muted-foreground">
        {kind === "idle"
          ? planning
            ? "从题目列表选择后加入，启动前可以调整顺序。"
            : "调度运行期间不会改动计划；暂停后可继续安排。"
          : "启动调度后，空闲队列会按顺序进入这里。"}
      </p>
      {kind === "idle" && canStageAll ? (
        <Button className="mt-3" size="sm" variant="secondary" disabled={busy} onClick={onStageAll}>
          加入全部可调度题
        </Button>
      ) : null}
    </div>
  )
}

export function SchedulerWorkbench({
  projectId,
  snapshot,
  challenges,
  operationsAvailable,
  stageableCount,
  busy,
  onStageAll,
  onSnapshot,
  onReload,
  onBusyChange,
  onError,
}: SchedulerWorkbenchProps) {
  const scheduler = snapshot.scheduler
  const [idle, setIdle] = useState(scheduler?.idle ?? [])
  const [execution, setExecution] = useState(scheduler?.queued ?? [])
  const [removing, setRemoving] = useState("")
  const [reordering, setReordering] = useState(false)
  const [notice, setNotice] = useState("")
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  useEffect(() => setIdle(scheduler?.idle ?? []), [scheduler?.idle])
  useEffect(() => setExecution(scheduler?.queued ?? []), [scheduler?.queued])

  const planning = scheduler?.mode === "stopped"
  const queueBusy = busy || reordering || removing.length > 0
  const reorderEnabled = operationsAvailable && planning && !queueBusy
  const state = queueStateLabel(snapshot)
  const guidance = !scheduler
    ? "比赛与 Solver 模型就绪后，可在这里编排题目。"
    : scheduler.state === "suspended"
      ? "系统暂时停止领取任务；当前顺序已保留，恢复后继续。"
      : planning
        ? "先安排顺序；启动后整批提交，未选择的题目不会运行。"
        : "执行队列正在按顺序创建 Solver；暂停后才能重新编排。"

  async function recoverReorder(cause: unknown) {
    const conflict =
      (cause instanceof ApiError && cause.code === "queue_version_conflict") ||
      (cause instanceof Error && cause.message.includes("version conflict"))
    const conflictData =
      cause instanceof ApiError && typeof cause.data === "object" && cause.data !== null
        ? (cause.data as { snapshot?: DashboardSnapshot })
        : undefined
    if (conflict && conflictData?.snapshot) {
      onSnapshot(conflictData.snapshot)
      setNotice("队列已在其他页面更新，当前顺序已恢复为最新版本。")
      return
    }
    try {
      await onReload()
      if (conflict) {
        setNotice("队列已在其他页面更新，当前顺序已恢复为最新版本。")
      } else {
        onError(cause instanceof Error ? cause.message : String(cause))
      }
    } catch {
      onError(
        conflict
          ? "队列版本已变化，自动刷新失败，请手动同步后重试。"
          : cause instanceof Error
            ? cause.message
            : String(cause),
      )
    }
  }

  async function reorderIdle(event: DragEndEvent) {
    if (!event.over || event.active.id === event.over.id || !scheduler) return
    const from = idle.findIndex((item) => item.challengeId === event.active.id)
    const to = idle.findIndex((item) => item.challengeId === event.over?.id)
    if (from < 0 || to < 0) return
    const next = arrayMove(idle, from, to).map((item, index) => ({
      ...item,
      position: index + 1,
    }))
    setIdle(next)
    setNotice("")
    onError("")
    setReordering(true)
    onBusyChange(true)
    try {
      const updated = await apiMutation<DashboardSnapshot>(
        projectApi(projectId, "/api/scheduler/idle/order"),
        "PUT",
        {
          challengeIds: next.map((item) => item.challengeId),
          expectedVersion: scheduler.idleVersion,
        },
      )
      onSnapshot(updated)
    } catch (cause) {
      await recoverReorder(cause)
    } finally {
      setReordering(false)
      onBusyChange(false)
    }
  }

  async function reorderExecution(event: DragEndEvent) {
    if (!event.over || event.active.id === event.over.id) return
    const from = execution.findIndex((item) => item.challengeId === event.active.id)
    const to = execution.findIndex((item) => item.challengeId === event.over?.id)
    const moved = execution[from]
    const target = execution[to]
    if (from < 0 || to < 0 || !moved || !target) return
    if (moved.lane !== target.lane) {
      setNotice("Blocked 项使用独立优先级，不能与普通执行项交叉排序。")
      return
    }
    setExecution(
      arrayMove(execution, from, to).map((item, index) => ({ ...item, position: index + 1 })),
    )
    setNotice("")
    onError("")
    setReordering(true)
    onBusyChange(true)
    try {
      const updated = await apiMutation<DashboardSnapshot>(
        projectApi(projectId, `/api/scheduler/queue/${encodeURIComponent(moved.challengeId)}`),
        "PATCH",
        {
          position: to + 1,
          expectedVersion: moved.version,
          overrideBlockedLane: false,
        },
      )
      onSnapshot(updated)
    } catch (cause) {
      await recoverReorder(cause)
    } finally {
      setReordering(false)
      onBusyChange(false)
    }
  }

  async function removeIdle(challengeId: string) {
    setRemoving(challengeId)
    onBusyChange(true)
    onError("")
    try {
      const updated = await apiMutation<DashboardSnapshot>(
        projectApi(projectId, "/api/scheduler/idle"),
        "DELETE",
        { challengeIds: [challengeId] },
      )
      onSnapshot(updated)
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setRemoving("")
      onBusyChange(false)
    }
  }

  return (
    <Card className="min-h-0 p-0">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground">
            调度计划
          </p>
          <h2 className="mt-0.5 font-semibold">从准备到执行</h2>
          <p className="mt-1! text-[11px] text-muted-foreground">{guidance}</p>
        </div>
        <div className="flex items-center gap-2">
          {snapshot.scheduler?.active?.length ? (
            <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
              {snapshot.scheduler.active.length} 个运行中
            </span>
          ) : null}
          <Badge tone={state.tone}>{state.label}</Badge>
        </div>
      </div>

      {notice ? (
        <div
          role="status"
          className="flex items-center gap-2 border-b border-warning/20 bg-warning/5 px-4 py-2 text-[11px] text-warning"
        >
          <Icon icon="lucide:info" width="13" className="shrink-0" aria-hidden="true" />
          {notice}
        </div>
      ) : null}

      <div className="grid min-h-0 md:grid-cols-[minmax(0,1fr)_2rem_minmax(0,1fr)]">
        <section className="min-w-0" aria-labelledby="idle-queue-heading">
          <div className="flex items-center justify-between border-b border-border/70 px-3 py-2.5">
            <div>
              <h3 id="idle-queue-heading" className="text-xs font-semibold">
                空闲队列
              </h3>
              <p className="mt-0.5! text-[10px] text-muted-foreground">
                {planning ? "启动前可拖动排序" : "暂停后可继续编排"}
              </p>
            </div>
            <Badge tone="neutral">{idle.length}</Badge>
          </div>
          {idle.length > 0 ? (
            <DndContext sensors={sensors} onDragEnd={(event) => void reorderIdle(event)}>
              <SortableContext
                items={idle.map((item) => item.challengeId)}
                strategy={verticalListSortingStrategy}
              >
                <div className="max-h-112 divide-y divide-border/60 overflow-y-auto overscroll-contain">
                  {idle.map((item) => (
                    <QueueRow
                      key={item.challengeId}
                      entry={item}
                      challenge={challenges.get(item.challengeId)}
                      disabled={!reorderEnabled}
                      removable={planning && operationsAvailable}
                      removing={removing === item.challengeId}
                      onRemove={() => void removeIdle(item.challengeId)}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          ) : (
            <QueueEmpty
              kind="idle"
              planning={planning}
              canStageAll={planning && operationsAvailable && stageableCount > 0}
              busy={busy}
              onStageAll={onStageAll}
            />
          )}
        </section>

        <div className="relative hidden items-center justify-center md:flex" aria-hidden="true">
          <span className="absolute inset-y-0 left-1/2 w-px bg-border/70" />
          <span className="relative flex size-6 items-center justify-center rounded-full border border-border bg-card font-mono text-[11px] text-muted-foreground">
            →
          </span>
        </div>

        <section
          className="min-w-0 border-t border-border md:border-t-0"
          aria-labelledby="execution-queue-heading"
        >
          <div className="flex items-center justify-between border-b border-border/70 px-3 py-2.5">
            <div>
              <h3 id="execution-queue-heading" className="text-xs font-semibold">
                执行队列
              </h3>
              <p className="mt-0.5! text-[10px] text-muted-foreground">按顺序等待 Solver 名额</p>
            </div>
            <Badge tone="neutral">{execution.length}</Badge>
          </div>
          {execution.length > 0 ? (
            <DndContext sensors={sensors} onDragEnd={(event) => void reorderExecution(event)}>
              <SortableContext
                items={execution.map((item) => item.challengeId)}
                strategy={verticalListSortingStrategy}
              >
                <div className="max-h-112 divide-y divide-border/60 overflow-y-auto overscroll-contain">
                  {execution.map((item) => (
                    <QueueRow
                      key={item.challengeId}
                      entry={item}
                      challenge={challenges.get(item.challengeId)}
                      disabled={!reorderEnabled || item.lane === "blocked"}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          ) : (
            <QueueEmpty
              kind="execution"
              planning={planning}
              canStageAll={false}
              busy={busy}
              onStageAll={onStageAll}
            />
          )}
        </section>
      </div>
    </Card>
  )
}
