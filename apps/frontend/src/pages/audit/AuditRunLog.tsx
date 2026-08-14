import type { CodeAuditRun } from "@ctf-agent/core"
import { Icon } from "@iconify/react"
import { useCallback, useEffect, useRef, useState } from "react"
import { Badge, Card, ErrorNotice } from "../../components/index.ts"
import { useSse } from "../../hooks/useSse.ts"
import { apiRequest } from "../../lib/api.ts"
import { errorMessage } from "../../lib/format.ts"

interface AuditLogSnapshot {
  runId: string
  text: string
  offset: number
  total: number
  updatedAt: string | null
}

interface AuditLogChunk {
  runId: string
  text: string
  offset: number
  total: number
}

export function AuditRunLog({ auditId, run }: { auditId: string; run: CodeAuditRun }) {
  const [log, setLog] = useState("")
  const [error, setError] = useState("")
  const logRef = useRef<HTMLPreElement>(null)
  const cursorRef = useRef(0)
  const logUrl = `/api/audits/${encodeURIComponent(auditId)}/runs/${encodeURIComponent(run.id)}/log`
  const active = run.status === "running" || run.status === "paused"
  const eventsUrl = active
    ? `/api/audits/${encodeURIComponent(auditId)}/runs/${encodeURIComponent(run.id)}/events`
    : ""

  const load = useCallback(async () => {
    try {
      const snapshot = await apiRequest<AuditLogSnapshot>(logUrl)
      cursorRef.current = snapshot.offset + snapshot.text.length
      setLog(snapshot.text)
      setError("")
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }, [logUrl])

  useEffect(() => {
    cursorRef.current = 0
    setLog("")
    void load()
  }, [load, run.id])

  useSse(eventsUrl, {
    audit_log: (data) => {
      if (!isAuditLogChunk(data) || data.runId !== run.id) return
      const previousCursor = cursorRef.current
      const incomingEnd = data.offset + data.text.length
      if (incomingEnd <= previousCursor) return
      const skip = Math.max(0, previousCursor - data.offset)
      const next = data.text.slice(skip)
      cursorRef.current = incomingEnd
      setLog((current) => (data.offset > previousCursor ? data.text : `${current}${next}`))
      setError("")
    },
  })

  useEffect(() => {
    const element = logRef.current
    if (!element) return
    element.scrollTop = element.scrollHeight
  }, [log])

  const progress = run.progress
  const total = progress?.filesTotal ?? 0
  const completed = progress?.filesCompleted ?? 0
  const ratio = total > 0 ? Math.min(1, Math.max(0, completed / total)) : 0
  return (
    <Card className="mb-4 overflow-hidden border-success/25 bg-card">
      <header className="flex flex-wrap items-center gap-3 border-b border-border/60 bg-muted/30 px-4 py-3">
        <span className="relative flex size-2.5 shrink-0" aria-hidden="true">
          {active ? (
            <span className="absolute inset-0 rounded-full bg-success/50 motion-reduce:hidden animate-ping-soft" />
          ) : null}
          <span
            className={`relative size-2.5 rounded-full ${active ? "bg-success" : "bg-muted-foreground/50"}`}
          />
        </span>
        <div className="min-w-0 flex-1">
          <p className="field-label">Codex Security 输出</p>
          <h3 className="truncate text-sm font-semibold">
            {active ? "正在运行" : `最近一次运行 · ${run.mode}`}
          </h3>
        </div>
        <Badge
          tone={
            run.status === "running"
              ? "positive"
              : run.status === "paused"
                ? "warning"
                : run.status === "failed"
                  ? "danger"
                  : "neutral"
          }
        >
          {run.status}
        </Badge>
      </header>
      <div className="grid gap-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <span className="font-mono">{progress?.phase ?? "等待输出"}</span>
          {total > 0 ? (
            <span className="font-mono tabular-nums">
              {completed}/{total} files
            </span>
          ) : null}
        </div>
        {total > 0 ? (
          <div
            className="h-1 overflow-hidden rounded-full bg-muted"
            aria-label={`已完成 ${completed} / ${total} 个文件`}
          >
            <div
              className="h-full origin-left rounded-full bg-success transition-transform duration-300 motion-reduce:transition-none"
              style={{ transform: `scaleX(${ratio})` }}
            />
          </div>
        ) : null}
        <pre
          ref={logRef}
          role="log"
          aria-live="polite"
          aria-label="Codex Security 运行日志"
          className="max-h-64 min-h-28 overflow-auto whitespace-pre-wrap break-words rounded-md bg-background/80 p-3 font-mono text-[11px] leading-5 text-muted-foreground"
        >
          {log || "等待 Worker 输出…"}
        </pre>
        {error ? <ErrorNotice message={error} /> : null}
        {run.error ? (
          <p className="flex items-start gap-2 text-xs text-danger">
            <Icon
              icon="lucide:circle-alert"
              width="14"
              className="mt-0.5 shrink-0"
              aria-hidden="true"
            />
            <span>{run.error}</span>
          </p>
        ) : null}
      </div>
    </Card>
  )
}

function isAuditLogChunk(value: unknown): value is AuditLogChunk {
  if (typeof value !== "object" || value === null) return false
  const item = value as Record<string, unknown>
  return (
    typeof item.runId === "string" &&
    typeof item.text === "string" &&
    typeof item.offset === "number" &&
    typeof item.total === "number"
  )
}
