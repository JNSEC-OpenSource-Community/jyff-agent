import { Icon } from "@iconify/react"
import { useState } from "react"
import {
  Badge,
  Button,
  Card,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  ErrorNotice,
  Input,
} from "../../components/index.ts"
import { apiMutation, projectApi } from "../../lib/api.ts"
import { toneForStatus } from "../../lib/challenge.ts"
import { errorMessage } from "../../lib/format.ts"
import { EVENT_LABELS, STATUS_LABELS } from "../../lib/labels.ts"
import { absoluteTime } from "../../lib/time.ts"
import type { DashboardRun } from "../../types.ts"

export function AttemptHistory({
  projectId,
  runs,
  onChanged,
}: {
  projectId: string
  runs: DashboardRun[]
  onChanged: () => Promise<void>
}): React.ReactElement {
  const [prompts, setPrompts] = useState<Record<string, string>>({})
  const [busyRun, setBusyRun] = useState<string | null>(null)
  const [error, setError] = useState("")

  async function retry(runId: string): Promise<void> {
    setBusyRun(runId)
    setError("")
    try {
      const prompt = prompts[runId]?.trim()
      await apiMutation(
        projectApi(projectId, `/api/runs/${encodeURIComponent(runId)}/retry`),
        "POST",
        prompt ? { prompt } : {},
      )
      await onChanged()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusyRun(null)
    }
  }

  if (runs.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border bg-muted/30 py-8 text-center text-sm text-muted-foreground">
        该题目还没有任何 Attempt 记录。
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {error ? <ErrorNotice message={error} /> : null}
      {runs.map((run) => (
        <Card key={run.id} className="p-0">
          <div className="p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-3">
                <span className="font-mono text-xs text-muted-foreground tabular-nums">
                  #{run.attempt}
                </span>
                <div>
                  <strong className="block text-sm font-medium">{run.id}</strong>
                  <small className="text-muted-foreground text-xs">
                    {absoluteTime(run.createdAt)}
                  </small>
                </div>
              </div>
              <Badge tone={toneForStatus(run.status)}>
                {STATUS_LABELS[run.status] ?? run.status}
              </Badge>
            </div>

            <div className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
              <Metric value={run.events.length} label="事件" />
              <Metric value={run.subagents.length} label="SubAgents" />
              <Metric value={run.cache.inputTokens} label="输入 tokens" />
              <Metric
                value={
                  run.cache.cacheRate === null ? "—" : `${Math.round(run.cache.cacheRate * 100)}%`
                }
                label="缓存命中"
              />
            </div>

            {run.error ? (
              <ErrorNotice message={`运行失败原因：${run.error}`} className="mt-3" />
            ) : null}
            {run.cleanupError ? (
              <ErrorNotice message={`资源清理异常：${run.cleanupError}`} className="mt-3" />
            ) : null}

            <Collapsible className="mt-3">
              <CollapsibleTrigger className="group flex cursor-pointer items-center gap-1 text-xs font-semibold text-muted-foreground hover:text-foreground">
                查看运行事件
                <Icon
                  icon="lucide:chevron-down"
                  width="14"
                  className="transition-transform group-data-[state=open]:rotate-180"
                />
              </CollapsibleTrigger>
              <CollapsibleContent className="mt-2! flex flex-col gap-1">
                {run.events.map((event) => (
                  <div
                    key={event.id}
                    className="flex items-center gap-3 text-xs text-muted-foreground"
                  >
                    <time>{absoluteTime(event.createdAt)}</time>
                    <strong className="text-foreground/80">
                      {EVENT_LABELS[event.type] ?? event.type}
                    </strong>
                    {eventFailureMessage(event.data) ? (
                      <span className="min-w-0 break-all text-destructive">
                        {eventFailureMessage(event.data)}
                      </span>
                    ) : null}
                  </div>
                ))}
              </CollapsibleContent>
            </Collapsible>
          </div>

          <div className="flex items-center gap-2 border-t border-border bg-muted/30 px-3 py-2.5">
            <Input
              value={prompts[run.id] ?? ""}
              onChange={(event) =>
                setPrompts((current) => ({
                  ...current,
                  [run.id]: event.target.value,
                }))
              }
              placeholder="留空使用默认提示词"
              className="h-8 flex-1"
            />
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void retry(run.id)}
              disabled={busyRun !== null}
            >
              <Icon
                icon={busyRun === run.id ? "lucide:loader-circle" : "lucide:rotate-ccw"}
                className={busyRun === run.id ? "animate-spin" : ""}
                width="14"
              />
              重试此 Attempt
            </Button>
          </div>
        </Card>
      ))}
    </div>
  )
}

/** 创建失败事件保留历史 Run 的根因，兼容旧记录没有 Run.error 的情况。 */
function eventFailureMessage(data: unknown): string | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null
  const error = (data as Record<string, unknown>).error
  return typeof error === "string" && error.trim() ? error : null
}

function Metric({ value, label }: { value: string | number; label: string }) {
  return (
    <div className="rounded-md border border-border bg-muted px-2.5 py-2">
      <span className="block font-mono text-sm font-semibold tabular-nums text-foreground">
        {value}
      </span>
      <small className="block text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </small>
    </div>
  )
}
