import { Icon } from "@iconify/react"
import { useMemo, useState } from "react"
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
import type {
  AgentCacheStats,
  ChallengeDetails,
  DashboardRun,
  DashboardSubagent,
} from "../../types.ts"

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
  const selectedSubagent = run?.subagents.find(
    (subagent) => subagent.id === selectedSubagentId,
  )
  const selectedAgentName = selectedSubagent?.displayName ?? "Solver"
  const cache = useMemo(
    () => selectedAgentCache(run, selectedSubagent),
    [run, selectedSubagent],
  )

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
              <Row label="当前 Agent" value={selectedAgentName} />
              <Row
                label="实时缓存率"
                value={
                  cache.cacheRate === null
                    ? "—"
                    : `${Math.round(cache.cacheRate * 100)}%`
                }
              />
              {run ? (
                <>
                  <Row label="输入" value={tokenLabel(cache.inputTokens)} />
                  <Row
                    label="缓存读取"
                    value={tokenLabel(cache.cacheReadTokens)}
                  />
                  <Row
                    label="缓存写入"
                    value={tokenLabel(cache.cacheWriteTokens)}
                  />
                </>
              ) : null}
              <Row
                label="平台"
                value={c.platformSolved ? "Solved" : "Unsolved"}
              />
              <Row
                label="环境"
                value={environmentLabel(details, c.needsEnv === true)}
              />
              {details.environment?.endpoint ? (
                <EnvironmentEndpoint
                  key={details.environment.endpoint}
                  endpoint={details.environment.endpoint}
                />
              ) : null}
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

function selectedAgentCache(
  run: DashboardRun | undefined,
  subagent: DashboardSubagent | undefined,
): AgentCacheStats {
  if (!subagent) {
    return (
      run?.cache ?? {
        inputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cacheRate: null,
      }
    )
  }
  const inputTokens = Math.max(0, subagent.inputTokens ?? 0)
  const cacheReadTokens = Math.max(0, subagent.cacheReadTokens ?? 0)
  const cacheWriteTokens = Math.max(0, subagent.cacheWriteTokens ?? 0)
  const eligibleTokens = inputTokens + cacheReadTokens
  return {
    inputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    cacheRate: eligibleTokens > 0 ? cacheReadTokens / eligibleTokens : null,
  }
}

function tokenLabel(value: number): string {
  return `${value.toLocaleString()} tokens`
}

function environmentLabel(
  details: ChallengeDetails,
  needsEnvironment: boolean,
): string {
  switch (details.environment?.status) {
    case "starting":
      return "启动中"
    case "running":
      return "运行中"
    case "stopped":
      return "已停止"
    default:
      return needsEnvironment ? "未启动" : "不需要"
  }
}

function EnvironmentEndpoint({ endpoint }: { endpoint: string }) {
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">(
    "idle",
  )
  const copy = async () => {
    try {
      await copyText(endpoint)
      setCopyStatus("copied")
    } catch {
      setCopyStatus("failed")
    }
  }

  return (
    <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-2">
      <span className="text-muted-foreground">环境 URL</span>
      <div className="flex min-w-0 items-center justify-end gap-1">
        <code
          className="min-w-0 flex-1 truncate text-right font-mono text-[11px] text-foreground"
          title={endpoint}
        >
          {endpoint}
        </code>
        <button
          type="button"
          onClick={() => void copy()}
          className={cn(
            "flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
            copyStatus === "copied" && "text-success",
            copyStatus === "failed" && "text-danger",
          )}
          aria-label={
            copyStatus === "copied"
              ? "环境 URL 已复制"
              : copyStatus === "failed"
                ? "复制环境 URL 失败，点击重试"
                : "复制环境 URL"
          }
          title={
            copyStatus === "copied"
              ? "已复制"
              : copyStatus === "failed"
                ? "复制失败"
                : "复制"
          }
        >
          <Icon
            icon={
              copyStatus === "copied"
                ? "lucide:check"
                : copyStatus === "failed"
                  ? "lucide:triangle-alert"
                  : "lucide:copy"
            }
            width="13"
            aria-hidden="true"
          />
        </button>
      </div>
    </div>
  )
}

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value)
      return
    } catch {
      // 非安全上下文或权限被拒绝时回退到选择复制。
    }
  }
  const textarea = document.createElement("textarea")
  textarea.value = value
  textarea.setAttribute("readonly", "")
  textarea.style.position = "fixed"
  textarea.style.opacity = "0"
  document.body.append(textarea)
  let copied = false
  try {
    textarea.select()
    copied = document.execCommand("copy")
  } finally {
    textarea.remove()
  }
  if (!copied) throw new Error("Clipboard unavailable")
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
    <div className="flex min-w-0 justify-between gap-2">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <strong
        className={cn(
          "min-w-0 truncate text-right text-xs",
          mono && "font-mono",
        )}
        title={String(value)}
      >
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
