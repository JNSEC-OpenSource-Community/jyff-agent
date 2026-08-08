import { Icon } from "@iconify/react"
import {
  Badge,
  Card,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../../components/index.ts"
import { toneForStatus } from "../../lib/challenge.ts"
import { toolLabel } from "../../lib/conversation.ts"
import { STATUS_LABELS } from "../../lib/labels.ts"
import { cn } from "../../lib/utils.ts"
import type { ChallengeDetails, DashboardSubagent } from "../../types.ts"

export function AgentSidebar({
  details,
  selectedRunId,
  selectedSubagentId,
  onSelectSubagent,
}: {
  details: ChallengeDetails
  selectedRunId: string
  selectedSubagentId: string | null
  onSelectSubagent(id: string | null): void
}) {
  const c = details.challenge
  const run =
    details.runs.find((r) => r.id === selectedRunId) ?? details.runs[0]

  return (
    <aside className="flex min-w-0 flex-1 flex-col gap-4">
      <Card className="overflow-hidden p-0">
        <Collapsible defaultOpen>
          <CollapsibleTrigger className="group flex w-full items-center justify-between px-4 py-3 text-sm font-medium hover:bg-muted">
            <span className="flex items-center gap-2.5">
              <Icon icon="lucide:scan-search" width="15" />
              状态
            </span>
            <Icon
              icon="lucide:chevron-down"
              width="13"
              className="transition-transform duration-200 group-data-[state=open]:rotate-180"
            />
          </CollapsibleTrigger>
          <CollapsibleContent className="border-t border-border px-4 py-3 text-sm">
            <div className="space-y-2">
              <Row label="ID" value={c.id} mono />
              <Row label="尝试" value={c.attempts} />
              <Row label="中断" value={c.sessionInterruptions} />
              <Row
                label="实时缓存率"
                value={
                  run?.cache.cacheRate === null || !run
                    ? "—"
                    : `${Math.round(run.cache.cacheRate * 100)}%`
                }
              />
              {run ? (
                <Row
                  label="缓存命中"
                  value={`${run.cache.cacheReadTokens.toLocaleString()} tokens`}
                />
              ) : null}
              <Row
                label="平台"
                value={c.platformSolved ? "Solved" : "Unsolved"}
              />
              <Row
                label="环境"
                value={
                  details.environment?.status ?? (c.needsEnv ? "未启动" : "-")
                }
              />
            </div>
          </CollapsibleContent>
        </Collapsible>
      </Card>

      <Card className="flex min-h-0 flex-1 flex-col overflow-hidden p-0">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <span className="flex items-center gap-2.5 text-sm font-medium">
            <Icon icon="lucide:network" width="15" />
            Agents
          </span>
          <Badge className="text-[10px]">{run?.subagents.length ?? 0}</Badge>
        </div>
        <div className="flex flex-col gap-1 overflow-y-auto p-2">
          <AR
            icon="lucide:bot"
            title="Solver"
            sub={run ? `Attempt ${run.attempt}` : "未运行"}
            status={run?.status ?? null}
            active={selectedSubagentId === null}
            onClick={() => onSelectSubagent(null)}
          />
          {run?.subagents.map((s) => (
            <AR
              key={s.id}
              icon="lucide:waypoints"
              title={s.displayName}
              sub={
                s.activeTool
                  ? toolLabel(s.activeTool)
                  : `${s.turns}t · ${s.totalTokens}tk`
              }
              status={s.status}
              active={selectedSubagentId === s.id}
              onClick={() => onSelectSubagent(s.id)}
            />
          ))}
        </div>
      </Card>
    </aside>
  )
}

function Row({
  label,
  value,
  mono,
}: {
  label: string
  value: string | number
  mono?: boolean
}) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <strong className={cn("text-right text-xs", mono && "font-mono")}>
        {value}
      </strong>
    </div>
  )
}

function AR({
  icon,
  title,
  sub,
  status,
  active,
  onClick,
}: {
  icon: string
  title: string
  sub: string
  status: DashboardSubagent["status"] | string | null
  active: boolean
  onClick(): void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-all duration-150",
        active
          ? "bg-primary/10 text-primary shadow-[0_0_0_1px_rgba(94,106,210,0.12)_inset]"
          : "hover:bg-muted",
      )}
    >
      <span
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-full border transition-colors",
          active
            ? "border-primary/30 bg-primary/5 text-primary"
            : "border-border bg-muted text-muted-foreground",
        )}
      >
        <Icon icon={icon} width="15" />
      </span>
      <span className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{title}</p>
        <p className="truncate text-xs text-muted-foreground">{sub}</p>
      </span>
      {status ? (
        <Badge tone={toneForStatus(status)} className="shrink-0 text-[10px]">
          {STATUS_LABELS[status] ?? status}
        </Badge>
      ) : null}
    </button>
  )
}
