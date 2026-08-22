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
import {
  Button,
  Card,
  CompactEmptyState,
  Tooltip,
  TooltipProvider,
} from "../../components/index.ts"
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

function queueStateHint(snapshot: DashboardSnapshot): string {
  const scheduler = snapshot.scheduler
  if (!scheduler) return "比赛与 Solver 模型就绪后可编排题目"
  if (scheduler.state === "suspended") return "系统已停止领取任务；当前顺序会保留到恢复后"
  if (scheduler.mode === "automatic") return "自动发现并执行可调度题目"
  if (scheduler.mode === "manual") return "按执行队列顺序创建 Solver；暂停后可重新编排"
  return "可调整空闲队列与执行顺序"
}

function QueueLaneHeader({
  id,
  icon,
  title,
  count,
  controlIcon,
  controlLabel,
  controlBusy = false,
}: {
  id: string
  icon: string
  title: string
  count: number
  controlIcon: string
  controlLabel: string
  controlBusy?: boolean
}) {
  return (
    <header className="flex min-h-13 items-center justify-between gap-3 border-b border-border/70 px-3">
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-sm bg-muted/60 text-muted-foreground">
          <Icon icon={icon} width="14" aria-hidden="true" />
        </span>
        <h3 id={id} className="truncate text-xs font-semibold">
          {title}
        </h3>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <span
          className="min-w-6 rounded-sm bg-muted/60 px-1.5 py-0.5 text-center font-mono text-[10px] tabular-nums text-muted-foreground"
          aria-label={`${title} ${count} 道题`}
        >
          {count}
        </span>
        <Tooltip label={controlLabel}>
          <span
            tabIndex={0}
            role="img"
            aria-label={controlLabel}
            className="flex size-7 items-center justify-center rounded-sm text-quiet outline-none transition-colors hover:bg-muted hover:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            <Icon
              icon={controlIcon}
              width="13"
              className={controlBusy ? "animate-spin" : undefined}
              aria-hidden="true"
            />
          </span>
        </Tooltip>
      </div>
    </header>
  )
}

function QueueEntryState({ entry }: { entry: SchedulerQueueEntry }) {
  const visual =
    entry.lane === "blocked"
      ? {
          icon: "lucide:triangle-alert",
          label: "Blocked 队列",
          className: "bg-danger/10 text-danger",
        }
      : entry.source === "retry"
        ? {
            icon: "lucide:rotate-ccw",
            label: "失败后重试",
            className: "bg-warning/10 text-warning",
          }
        : entry.source === "revival"
          ? {
              icon: "lucide:heart-pulse",
              label: "恢复 Blocked 任务",
              className: "bg-warning/10 text-warning",
            }
          : entry.stage === "idle"
            ? {
                icon: "lucide:circle-pause",
                label: "等待启动",
                className: "text-quiet",
              }
            : entry.source === "auto"
              ? {
                  icon: "lucide:repeat-2",
                  label: "自动入队",
                  className: "text-quiet",
                }
              : {
                  icon: "lucide:clock-3",
                  label: "等待 Solver 名额",
                  className: "text-quiet",
                }
  return (
    <Tooltip label={visual.label}>
      <span
        tabIndex={0}
        role="img"
        aria-label={visual.label}
        className={cn(
          "flex size-7 items-center justify-center rounded-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40",
          visual.className,
        )}
      >
        <Icon icon={visual.icon} width="13" aria-hidden="true" />
      </span>
    </Tooltip>
  )
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
  const title = challenge?.title ?? entry.challengeId
  return (
    <div
      ref={setNodeRef}
      data-queue-id={entry.challengeId}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "group grid min-h-14 grid-cols-[2rem_1.5rem_minmax(0,1fr)_2rem] items-center gap-2 px-2.5 transition-colors",
        !disabled && "hover:bg-muted",
        isDragging && "relative z-10 bg-muted opacity-70 shadow-sm",
      )}
    >
      <button
        type="button"
        className={cn(
          "flex size-8 items-center justify-center rounded-sm text-muted-foreground outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40",
          disabled
            ? "cursor-default opacity-30"
            : "cursor-grab hover:bg-background active:cursor-grabbing",
        )}
        disabled={disabled}
        aria-label={`拖动排序：${title}`}
        title={disabled ? "当前队列不可排序" : "拖动排序；键盘按空格后使用方向键"}
        {...attributes}
        {...listeners}
      >
        <Icon icon="lucide:grip-vertical" width="14" aria-hidden="true" />
      </button>
      <span className="text-center font-mono text-[10px] tabular-nums text-quiet">
        {String(entry.position).padStart(2, "0")}
      </span>
      <div className="min-w-0">
        <p className="truncate text-xs font-medium">{title}</p>
        <p className="mt-0.5! flex items-center gap-1.5 truncate text-[10px] text-muted-foreground">
          <span className="truncate">{challenge?.category ?? entry.source}</span>
          {challenge ? (
            <>
              <span className="text-quiet" aria-hidden="true">
                ·
              </span>
              <Icon
                icon="lucide:gem"
                width="10"
                className="shrink-0 text-quiet"
                aria-hidden="true"
              />
              <span className="font-mono tabular-nums">{challenge.score}</span>
            </>
          ) : null}
        </p>
      </div>
      {removable && entry.lane !== "blocked" ? (
        <Tooltip label="移出空闲队列">
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-7 opacity-65 group-hover:opacity-100"
            disabled={removing || disabled}
            aria-label={`从空闲队列移除：${title}`}
            onClick={onRemove}
          >
            <Icon
              icon={removing ? "lucide:loader-circle" : "lucide:x"}
              className={removing ? "animate-spin" : undefined}
              width="13"
              aria-hidden="true"
            />
          </Button>
        </Tooltip>
      ) : (
        <QueueEntryState entry={entry} />
      )}
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
  const stateHint = queueStateHint(snapshot)
  const queueControl = queueBusy
    ? { icon: "lucide:loader-circle", label: "正在更新队列", busy: true }
    : reorderEnabled
      ? { icon: "lucide:grip", label: "可拖动或使用键盘排序", busy: false }
      : planning
        ? { icon: "lucide:eye", label: "当前为只读状态", busy: false }
        : { icon: "lucide:lock-keyhole", label: "暂停调度后可排序", busy: false }

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
    <TooltipProvider>
      <Card className="min-h-0 p-0">
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground">
              调度计划
            </p>
            <h2 className="mt-0.5 font-semibold">调度队列</h2>
            <span className="sr-only">{stateHint}</span>
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
            {planning && operationsAvailable && stageableCount > 0 ? (
              <Tooltip label={`加入全部 ${stageableCount} 道可调度题`}>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={queueBusy}
                  aria-label={`加入全部 ${stageableCount} 道可调度题`}
                  onClick={onStageAll}
                >
                  <Icon icon="lucide:list-plus" width="13" aria-hidden="true" />
                  批量入队
                  <span className="font-mono tabular-nums opacity-70">{stageableCount}</span>
                </Button>
              </Tooltip>
            ) : null}
          </div>
        </header>

        {notice ? (
          <div
            role="status"
            className="flex items-center gap-2 border-b border-warning/20 bg-warning/5 px-4 py-2 text-[11px] text-warning"
          >
            <Icon icon="lucide:info" width="13" className="shrink-0" aria-hidden="true" />
            {notice}
          </div>
        ) : null}

        <div className="grid min-h-0 md:grid-cols-2 md:divide-x md:divide-border/70">
          <section className="flex min-w-0 flex-col" aria-labelledby="idle-queue-heading">
            <QueueLaneHeader
              id="idle-queue-heading"
              icon="lucide:inbox"
              title="空闲队列"
              count={idle.length}
              controlIcon={queueControl.icon}
              controlLabel={queueControl.label}
              controlBusy={queueControl.busy}
            />
            {idle.length > 0 ? (
              <DndContext sensors={sensors} onDragEnd={(event) => void reorderIdle(event)}>
                <SortableContext
                  items={idle.map((item) => item.challengeId)}
                  strategy={verticalListSortingStrategy}
                >
                  <div className="min-h-full max-h-112 flex-1 divide-y divide-border/60 overflow-y-auto overscroll-contain">
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
              <CompactEmptyState icon="lucide:inbox" label="暂无题目" />
            )}
          </section>

          <section
            className="flex min-w-0 flex-col border-t border-border/60 md:border-t-0"
            aria-labelledby="execution-queue-heading"
          >
            <QueueLaneHeader
              id="execution-queue-heading"
              icon="lucide:list-start"
              title="执行队列"
              count={execution.length}
              controlIcon={queueControl.icon}
              controlLabel={queueControl.label}
              controlBusy={queueControl.busy}
            />
            {execution.length > 0 ? (
              <DndContext sensors={sensors} onDragEnd={(event) => void reorderExecution(event)}>
                <SortableContext
                  items={execution.map((item) => item.challengeId)}
                  strategy={verticalListSortingStrategy}
                >
                  <div className="min-h-full max-h-112 flex-1 divide-y divide-border/60 overflow-y-auto overscroll-contain">
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
              <CompactEmptyState icon="lucide:circle-dashed" label="无等待项" />
            )}
          </section>
        </div>
      </Card>
    </TooltipProvider>
  )
}
