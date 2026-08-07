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
import type { ChallengeDetails, DashboardSubagent } from "../../types.ts"

/** 题目侧栏：状态元数据 + Solver/SubAgent 切换列表。 */
export function AgentSidebar({
  details,
  selectedRunId,
  selectedSubagentId,
  onSelectSubagent,
}: {
  details: ChallengeDetails
  selectedRunId: string
  selectedSubagentId: string | null
  onSelectSubagent(subagentId: string | null): void
}): React.ReactElement {
  const challenge = details.challenge
  const selectedRun =
    details.runs.find((run) => run.id === selectedRunId) ?? details.runs[0]

  return (
    <aside className="flex w-72 shrink-0 flex-col gap-4">
      <Card className="p-0">
        <Collapsible defaultOpen>
          <CollapsibleTrigger className="hover:bg-muted/30 flex w-full cursor-pointer items-center justify-between rounded-lg px-4 py-3 text-sm font-semibold">
            <span className="inline-flex items-center gap-2">
              <Icon icon="lucide:scan-search" width="16" />
              题目状态
            </span>
            <Icon icon="lucide:chevron-down" width="15" />
          </CollapsibleTrigger>
          <CollapsibleContent className="border-border/60 flex flex-col gap-2 border-t px-4 py-3 text-sm">
            <div className="flex justify-between gap-2">
              <span className="text-muted-foreground">Challenge ID</span>
              <strong className="break-all text-right">{challenge.id}</strong>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-muted-foreground">尝试次数</span>
              <strong>{challenge.attempts}</strong>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-muted-foreground">异常中断</span>
              <strong>{challenge.sessionInterruptions}</strong>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-muted-foreground">平台判定</span>
              <strong>
                {challenge.platformSolved ? "Solved" : "Unsolved"}
              </strong>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-muted-foreground">环境</span>
              <strong>
                {details.environment?.status ??
                  (challenge.needsEnv ? "未启动" : "不需要")}
              </strong>
            </div>
          </CollapsibleContent>
        </Collapsible>
      </Card>
      <Card className="p-0">
        <div className="flex items-center justify-between px-4 py-3 text-sm font-semibold">
          <span className="inline-flex items-center gap-2">
            <Icon icon="lucide:network" width="16" />
            协作 Agents
          </span>
          <Badge>{selectedRun?.subagents.length ?? 0}</Badge>
        </div>
        <div className="border-border/60 flex flex-col gap-1 border-t p-2">
          <AgentListItem
            icon="lucide:bot"
            title="Solver Agent"
            subtitle={selectedRun ? `Attempt ${selectedRun.attempt}` : "未运行"}
            status={selectedRun?.status ?? null}
            active={selectedSubagentId === null}
            onClick={() => onSelectSubagent(null)}
          />
          {selectedRun?.subagents.map((subagent) => (
            <AgentListItem
              key={subagent.id}
              icon="lucide:waypoints"
              title={subagent.displayName}
              subtitle={
                subagent.activeTool
                  ? `正在使用 ${toolLabel(subagent.activeTool)}`
                  : `${subagent.turns} turns · ${subagent.totalTokens} tokens`
              }
              status={subagent.status}
              active={selectedSubagentId === subagent.id}
              onClick={() => onSelectSubagent(subagent.id)}
            />
          ))}
        </div>
      </Card>
    </aside>
  )
}

function AgentListItem({
  icon,
  title,
  subtitle,
  status,
  active,
  onClick,
}: {
  icon: string
  title: string
  subtitle: string
  status: DashboardSubagent["status"] | string | null
  active: boolean
  onClick(): void
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        active
          ? "bg-accent text-accent-foreground flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2 py-2 text-left"
          : "hover:bg-muted/40 flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2 py-2 text-left"
      }
    >
      <span className="bg-muted text-muted-foreground flex size-8 shrink-0 items-center justify-center rounded-full">
        <Icon icon={icon} width="16" />
      </span>
      <span className="min-w-0 flex-1">
        <strong className="block truncate text-sm">{title}</strong>
        <small className="text-muted-foreground block truncate text-xs">
          {subtitle}
        </small>
      </span>
      {status ? (
        <Badge tone={toneForStatus(status)}>
          {STATUS_LABELS[status] ?? status}
        </Badge>
      ) : null}
    </button>
  )
}
