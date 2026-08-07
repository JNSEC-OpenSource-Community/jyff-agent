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

/** 单题 Attempt 历史：状态、指标、事件时间线，以及带自定义提示词的失败重试。 */
export function AttemptHistory({
  projectId,
  runs,
  onChanged,
}: {
  projectId: string
  runs: DashboardRun[]
  onChanged(): Promise<void>
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

  return (
    <div className="flex flex-col gap-3">
      {error ? <ErrorNotice message={error} /> : null}
      {runs.map((run) => (
        <Card className="p-4" key={run.id}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-3">
              <span className="text-muted-foreground font-mono text-xs">
                #{run.attempt}
              </span>
              <div>
                <strong className="block text-sm">{run.id}</strong>
                <small className="text-muted-foreground text-xs">
                  {absoluteTime(run.createdAt)}
                </small>
              </div>
            </div>
            <Badge tone={toneForStatus(run.status)}>
              {STATUS_LABELS[run.status] ?? run.status}
            </Badge>
          </div>
          <div className="text-muted-foreground mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
            <span>
              {run.events.length}
              <small className="text-muted-foreground/70 block">事件</small>
            </span>
            <span>
              {run.subagents.length}
              <small className="text-muted-foreground/70 block">
                SubAgents
              </small>
            </span>
            <span>
              {run.cache.inputTokens}
              <small className="text-muted-foreground/70 block">
                输入 tokens
              </small>
            </span>
            <span>
              {run.cache.cacheRate === null
                ? "—"
                : `${Math.round(run.cache.cacheRate * 100)}%`}
              <small className="text-muted-foreground/70 block">缓存命中</small>
            </span>
          </div>
          <Collapsible className="mt-2">
            <CollapsibleTrigger className="text-muted-foreground hover:text-foreground flex cursor-pointer items-center gap-1 text-xs font-semibold">
              查看运行事件 <Icon icon="lucide:chevron-down" width="14" />
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-2 flex flex-col gap-1">
              {run.events.map((event) => (
                <div
                  className="text-muted-foreground flex items-center gap-3 text-xs"
                  key={event.id}
                >
                  <time>{absoluteTime(event.createdAt)}</time>
                  <strong>{EVENT_LABELS[event.type] ?? event.type}</strong>
                </div>
              ))}
            </CollapsibleContent>
          </Collapsible>
          <div className="mt-3 flex items-center gap-2">
            <Input
              value={prompts[run.id] ?? ""}
              onChange={(event) =>
                setPrompts((current) => ({
                  ...current,
                  [run.id]: event.target.value,
                }))
              }
              placeholder="留空使用默认继续提示词，或输入自定义提示词"
              className="h-8 flex-1"
            />
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void retry(run.id)}
              disabled={busyRun !== null}
            >
              <Icon
                icon={
                  busyRun === run.id
                    ? "lucide:loader-circle"
                    : "lucide:rotate-ccw"
                }
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
