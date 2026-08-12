import type { ModelTokenUsage, ProjectTokenUsageSnapshot } from "@ctf-agent/core"
import { Icon } from "@iconify/react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { useParams } from "react-router-dom"
import { Button, Card, EmptyState, ErrorNotice, PageHeader, Spinner } from "../components/index.ts"
import { apiRequest, projectApi } from "../lib/api.ts"
import { errorMessage } from "../lib/format.ts"

const integerFormat = new Intl.NumberFormat("zh-CN")
const compactFormat = new Intl.NumberFormat("zh-CN", {
  notation: "compact",
  maximumFractionDigits: 1,
})

export function TokenUsagePage(): React.ReactElement {
  const { projectId = "" } = useParams()
  const [snapshot, setSnapshot] = useState<ProjectTokenUsageSnapshot | null>(null)
  const [error, setError] = useState("")
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setRefreshing(true)
      setError("")
      try {
        const next = await apiRequest<ProjectTokenUsageSnapshot>(
          projectApi(projectId, "/token-usage"),
          { cache: "no-store", signal },
        )
        setSnapshot(next)
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === "AbortError") return
        setError(errorMessage(cause))
      } finally {
        if (!signal?.aborted) setRefreshing(false)
      }
    },
    [projectId],
  )

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load])

  const scaleMaximum = useMemo(
    () =>
      Math.max(
        1,
        ...(snapshot?.models.flatMap((model) => [
          model.inputTokens,
          model.outputTokens,
          model.cacheReadTokens,
        ]) ?? []),
      ),
    [snapshot],
  )

  if (!snapshot && !error) return <Spinner label="加载 Token 消耗" />

  return (
    <div className="page-container token-usage-page">
      <PageHeader
        eyebrow={projectId}
        title="Token 消耗"
        description="按模型汇总本场比赛中 Solver、SubAgent 与 TLDR 的供应商上报用量。"
        actions={
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={refreshing}
            onClick={() => void load()}
          >
            <Icon
              icon="lucide:refresh-cw"
              width="14"
              className={refreshing ? "animate-spin motion-reduce:animate-none" : undefined}
            />
            刷新
          </Button>
        }
      />

      {error ? <ErrorNotice message={error} className="mb-4" /> : null}
      {snapshot ? (
        <>
          <UsageSummary snapshot={snapshot} />

          {snapshot.unattributedTokens > 0 ? (
            <div className="mb-4 flex items-start gap-2 rounded-md border border-amber/30 bg-amber/8 px-3 py-2 text-xs text-amber">
              <Icon icon="lucide:history" width="15" className="mt-0.5 shrink-0" />
              <span>
                {formatTokens(snapshot.unattributedTokens)}{" "}
                来自升级前的历史记录，旧数据未保存模型名，已单独列出。
              </span>
            </div>
          ) : null}

          {snapshot.models.length > 0 ? (
            <Card className="overflow-hidden p-0">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
                <div>
                  <h2 className="text-sm font-semibold tracking-tight">模型用量</h2>
                  <p className="mt-1! text-xs text-muted-foreground">
                    所有柱形共用同一刻度；缓存命中使用 Pi 的 cacheRead 字段。
                  </p>
                </div>
                <UsageLegend />
              </div>
              <div className="divide-y divide-border">
                {snapshot.models.map((usage) => (
                  <ModelUsageBars
                    key={`${usage.provider}/${usage.model}`}
                    usage={usage}
                    scaleMaximum={scaleMaximum}
                  />
                ))}
              </div>
            </Card>
          ) : (
            <Card className="p-0">
              <EmptyState
                icon="lucide:chart-no-axes-column"
                title="暂无 Token 数据"
                description="本场比赛产生第一条模型回复后，这里会按模型显示输入、输出与缓存命中。"
              />
            </Card>
          )}

          <p className="mt-3! text-right text-[10px] text-muted-foreground">
            数据生成于{" "}
            <span className="font-mono tabular-nums">
              {new Date(snapshot.generatedAt).toLocaleString("zh-CN", { hour12: false })}
            </span>
          </p>
        </>
      ) : null}
    </div>
  )
}

function UsageSummary({ snapshot }: { snapshot: ProjectTokenUsageSnapshot }): React.ReactElement {
  const cacheRate = snapshot.totals.cacheHitRate
  return (
    <Card className="mb-4 p-0">
      <dl className="grid grid-cols-2 divide-x divide-y divide-border sm:grid-cols-4 sm:divide-y-0">
        <SummaryMetric label="总 Tokens" value={formatTokens(snapshot.totals.totalTokens)} />
        <SummaryMetric label="输入" value={formatTokens(snapshot.totals.inputTokens)} />
        <SummaryMetric label="输出" value={formatTokens(snapshot.totals.outputTokens)} />
        <SummaryMetric
          label="缓存命中"
          value={formatTokens(snapshot.totals.cacheReadTokens)}
          detail={cacheRate === null ? "—" : `${(cacheRate * 100).toFixed(1)}%`}
        />
      </dl>
    </Card>
  )
}

function SummaryMetric({
  label,
  value,
  detail,
}: {
  label: string
  value: string
  detail?: string
}): React.ReactElement {
  return (
    <div className="min-w-0 px-4 py-3.5">
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className="mt-1.5 flex items-baseline gap-2 font-mono text-lg font-semibold tabular-nums">
        {value}
        {detail ? <span className="text-[10px] font-medium text-green">{detail}</span> : null}
      </dd>
    </div>
  )
}

function UsageLegend(): React.ReactElement {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
      <LegendItem className="bg-foreground" label="输入" />
      <LegendItem className="bg-muted-foreground" label="输出" />
      <LegendItem className="bg-green" label="缓存命中" />
    </div>
  )
}

function LegendItem({ className, label }: { className: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={`h-1.5 w-4 rounded-sm ${className}`} aria-hidden="true" />
      {label}
    </span>
  )
}

function ModelUsageBars({
  usage,
  scaleMaximum,
}: {
  usage: ModelTokenUsage
  scaleMaximum: number
}): React.ReactElement {
  const displayName = usage.attributed ? `${usage.provider}/${usage.model}` : usage.model
  return (
    <section className="grid gap-4 px-4 py-4 lg:grid-cols-[minmax(12rem,0.34fr)_minmax(20rem,1fr)] lg:gap-8">
      <header className="min-w-0">
        <h3
          className={`truncate text-xs font-semibold ${usage.attributed ? "font-mono" : ""}`}
          title={displayName}
        >
          {displayName}
        </h3>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
          <span>
            合计 <span className="font-mono tabular-nums">{formatTokens(usage.totalTokens)}</span>
          </span>
          <span>
            命中率 {usage.cacheHitRate === null ? "—" : `${(usage.cacheHitRate * 100).toFixed(1)}%`}
          </span>
        </div>
      </header>
      <div className="space-y-2.5">
        <UsageBar
          label="输入"
          value={usage.inputTokens}
          maximum={scaleMaximum}
          fillClassName="bg-foreground"
        />
        <UsageBar
          label="输出"
          value={usage.outputTokens}
          maximum={scaleMaximum}
          fillClassName="bg-muted-foreground"
        />
        <UsageBar
          label="缓存命中"
          value={usage.cacheReadTokens}
          maximum={scaleMaximum}
          fillClassName="bg-green"
        />
      </div>
    </section>
  )
}

function UsageBar({
  label,
  value,
  maximum,
  fillClassName,
}: {
  label: string
  value: number
  maximum: number
  fillClassName: string
}): React.ReactElement {
  const percentage = value > 0 ? Math.max(1.5, (value / maximum) * 100) : 0
  return (
    <div className="grid grid-cols-[4.5rem_minmax(0,1fr)_4.75rem] items-center gap-2 sm:grid-cols-[5rem_minmax(0,1fr)_6rem] sm:gap-3">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <div
        className="h-2 overflow-hidden rounded-sm bg-muted"
        role="progressbar"
        aria-label={`${label} ${integerFormat.format(value)} tokens`}
        aria-valuemin={0}
        aria-valuemax={maximum}
        aria-valuenow={value}
      >
        <div
          className={`h-full origin-left rounded-sm transition-[width] duration-300 motion-reduce:transition-none ${fillClassName}`}
          style={{ width: `${percentage}%` }}
        />
      </div>
      <span
        className="text-right font-mono text-[11px] tabular-nums text-foreground"
        title={`${integerFormat.format(value)} tokens`}
      >
        {formatTokens(value)}
      </span>
    </div>
  )
}

export function formatTokens(value: number): string {
  return compactFormat.format(Math.max(0, value))
}
