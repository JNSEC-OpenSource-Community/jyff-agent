import type {
  CodeAuditFinding,
  CodeAuditProject,
  CodeAuditRun,
  CodeAuditRunResult,
} from "@ctf-agent/core"
import { Icon } from "@iconify/react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { Link, useParams, useSearchParams } from "react-router-dom"
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  PageHeader,
  Spinner,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "../components/index.ts"
import { MarkdownContent } from "../components/content/MarkdownContent.tsx"
import { apiMutation, apiRequest } from "../lib/api.ts"
import { errorMessage } from "../lib/format.ts"
import { AuditRunLog } from "./audit/AuditRunLog.tsx"
import {
  AuditCoveragePanel,
  AuditFindingsPanel,
  AuditFollowUpComposer,
  AuditManifestPanel,
  AuditResultSummary,
} from "./audit/AuditResultPanels.tsx"
import { WorkspaceFilesBrowser } from "./challenge/WorkspaceFilesPanel.tsx"

type Detail = {
  audit: CodeAuditProject
  runs: CodeAuditRun[]
  findings: CodeAuditFinding[]
  reports: Array<{ runId: string; markdown: string }>
  adapter: { available: boolean; reason: string }
}

type AuditTab = "overview" | "findings" | "coverage" | "files" | "report"
const AUDIT_TABS: Array<{ value: AuditTab; label: string }> = [
  { value: "overview", label: "概览" },
  { value: "findings", label: "发现" },
  { value: "coverage", label: "覆盖范围" },
  { value: "files", label: "产物" },
  { value: "report", label: "报告" },
]

export function AuditDetailPage(): React.ReactElement {
  const { auditId = "" } = useParams()
  const [searchParams, setSearchParams] = useSearchParams()
  const [detail, setDetail] = useState<Detail | null>(null)
  const [selectedRunId, setSelectedRunId] = useState("")
  const [result, setResult] = useState<CodeAuditRunResult | null>(null)
  const [error, setError] = useState("")
  const [resultError, setResultError] = useState("")
  const [resultLoading, setResultLoading] = useState(false)
  const [followUpDraft, setFollowUpDraft] = useState("")
  const [followUpBusy, setFollowUpBusy] = useState(false)

  const activeTab = tabFromSearch(searchParams.get("tab"))
  const load = useCallback(async () => {
    try {
      setDetail(await apiRequest<Detail>(`/api/audits/${encodeURIComponent(auditId)}`))
      setError("")
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }, [auditId])
  useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), 2_500)
    return () => clearInterval(timer)
  }, [load])
  useEffect(() => {
    setSelectedRunId((current) => {
      if (current && detail?.runs.some((run) => run.id === current)) return current
      return detail?.runs[0]?.id ?? ""
    })
  }, [detail])

  const selectedRun = useMemo(
    () => detail?.runs.find((run) => run.id === selectedRunId) ?? detail?.runs[0],
    [detail, selectedRunId],
  )
  const selectedRunStatus = selectedRun?.status
  const loadResult = useCallback(async () => {
    if (!selectedRunId) {
      setResult(null)
      return
    }
    setResultLoading(true)
    setResult(null)
    setResultError("")
    try {
      setResult(
        await apiRequest<CodeAuditRunResult>(
          `/api/audits/${encodeURIComponent(auditId)}/runs/${encodeURIComponent(selectedRunId)}/result`,
        ),
      )
      setResultError("")
    } catch (cause) {
      setResultError(errorMessage(cause))
    } finally {
      setResultLoading(false)
    }
  }, [auditId, selectedRunId])
  useEffect(() => {
    void loadResult()
  }, [loadResult, selectedRunStatus])

  if (!detail && !error)
    return (
      <div className="page-container">
        <Spinner label="加载审计概览" />
      </div>
    )
  if (error && !detail)
    return (
      <div className="page-container">
        <ErrorNotice message={error} />
      </div>
    )
  if (!detail)
    return (
      <div className="page-container">
        <EmptyState
          icon="lucide:file-question"
          title="找不到审计项目"
          description="该项目可能已删除。"
        />
      </div>
    )

  const configured = Boolean(detail.audit.auditModelId)
  const run = async (mode: "standard" | "deep") => {
    try {
      const response = await apiMutation<{ run: CodeAuditRun }>(
        `/api/audits/${encodeURIComponent(auditId)}/runs`,
        "POST",
        { mode },
      )
      setSelectedRunId(response.run.id)
      await load()
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }
  const control = async (runId: string, action: "pause" | "resume" | "cancel") => {
    try {
      await apiMutation(
        `/api/audits/${encodeURIComponent(auditId)}/runs/${encodeURIComponent(runId)}/${action}`,
        "POST",
      )
      await load()
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }
  const submitFollowUp = async () => {
    if (!selectedRun || !followUpDraft.trim()) return
    setFollowUpBusy(true)
    setError("")
    try {
      const response = await apiMutation<{ run: CodeAuditRun }>(
        `/api/audits/${encodeURIComponent(auditId)}/runs/${encodeURIComponent(selectedRun.id)}/follow-up`,
        "POST",
        { prompt: followUpDraft.trim() },
      )
      setFollowUpDraft("")
      setSelectedRunId(response.run.id)
      await load()
      const next = new URLSearchParams(searchParams)
      next.set("tab", "overview")
      setSearchParams(next, { replace: true })
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setFollowUpBusy(false)
    }
  }
  const reports = detail.reports.find((report) => report.runId === selectedRun?.id)

  return (
    <div className="page-container audit-detail-page">
      <PageHeader
        eyebrow="审计概览"
        title={detail.audit.name}
        description={`${detail.audit.archiveName} · ${(detail.audit.archiveSize / 1024 / 1024).toFixed(1)} MiB`}
        actions={
          <Button asChild variant="outline" size="sm">
            <Link to={`/audits/${encodeURIComponent(auditId)}/settings`}>
              <Icon icon="lucide:sliders-horizontal" width={14} aria-hidden="true" />
              审计设置
            </Link>
          </Button>
        }
      />
      {error ? <ErrorNotice message={error} className="mb-5" /> : null}
      <Card className="mb-5 overflow-hidden p-0">
        <div className="grid lg:grid-cols-[minmax(0,1fr)_auto]">
          <div className="p-5">
            <div className="flex items-center gap-3">
              <span
                className={`size-2 rounded-full ${detail.adapter.available ? "bg-success" : "bg-warning"}`}
                aria-hidden="true"
              />
              <h2 className="font-semibold">运行审计</h2>
            </div>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
              {configured
                ? detail.adapter.reason
                : "先在审计设置中选择模型与源码范围，再启动新的审计运行。"}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 border-t border-border/60 bg-muted/60 p-4 lg:border-t-0 lg:border-l">
            <Button
              disabled={!configured || !detail.adapter.available}
              onClick={() => void run("standard")}
            >
              <Icon icon="lucide:play" width={15} aria-hidden="true" />
              标准审计
            </Button>
            <Button
              variant="outline"
              disabled={!configured || !detail.adapter.available}
              onClick={() => void run("deep")}
            >
              <Icon icon="lucide:layers-3" width={15} aria-hidden="true" />
              深度审计
            </Button>
          </div>
        </div>
      </Card>

      <Tabs
        value={activeTab}
        onValueChange={(value) => {
          const next = new URLSearchParams(searchParams)
          next.set("tab", value)
          setSearchParams(next, { replace: true })
        }}
        className="min-w-0"
      >
        <TabsList className="mb-5 w-full justify-start overflow-x-auto rounded-md border-border/60 bg-muted/50 p-1">
          {AUDIT_TABS.map((tab) => (
            <TabsTrigger className="min-w-24 flex-1" value={tab.value} key={tab.value}>
              {tab.label}
              {tab.value === "findings" && result?.findings ? (
                <span className="font-mono text-[10px] text-muted-foreground">
                  {result.findings.findings.length}
                </span>
              ) : null}
              {tab.value === "coverage" && result?.coverage?.openQuestions?.length ? (
                <span className="font-mono text-[10px] text-warning">
                  {result.coverage.openQuestions.length}
                </span>
              ) : null}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="overview">
          <AuditResultSummary
            findings={result?.findings ?? null}
            coverage={result?.coverage ?? null}
            manifest={result?.manifest ?? null}
          />
          <section className="mb-5">
            <SectionTitle icon="lucide:activity" title="运行记录" />
            <RunList
              auditId={auditId}
              runs={detail.runs}
              selectedRunId={selectedRun?.id ?? ""}
              onSelect={setSelectedRunId}
              onControl={control}
            />
          </section>
          <AuditManifestPanel manifest={result?.manifest ?? null} />
        </TabsContent>

        <TabsContent value="findings">
          <ResultPanelState loading={resultLoading} error={resultError}>
            <AuditFindingsPanel document={result?.findings ?? null} />
          </ResultPanelState>
        </TabsContent>

        <TabsContent value="coverage">
          <ResultPanelState loading={resultLoading} error={resultError}>
            <div className="grid gap-5">
              <AuditCoveragePanel
                coverage={result?.coverage ?? null}
                onUsePrompt={setFollowUpDraft}
              />
              {selectedRun &&
              !["queued", "running", "paused", "blocked"].includes(selectedRun.status) ? (
                <AuditFollowUpComposer
                  draft={followUpDraft}
                  onChange={setFollowUpDraft}
                  onSubmit={() => void submitFollowUp()}
                  disabled={followUpBusy}
                />
              ) : null}
            </div>
          </ResultPanelState>
        </TabsContent>

        <TabsContent value="files">
          {selectedRun ? (
            <Card className="p-3 sm:p-4">
              <WorkspaceFilesBrowser
                key={`${selectedRun.id}:${selectedRun.status}`}
                listUrl={`/api/audits/${encodeURIComponent(auditId)}/runs/${encodeURIComponent(selectedRun.id)}/files`}
                previewUrl={(path) =>
                  `/api/audits/${encodeURIComponent(auditId)}/runs/${encodeURIComponent(selectedRun.id)}/files/preview?path=${encodeURIComponent(path)}`
                }
                downloadUrl={(path) =>
                  `/api/audits/${encodeURIComponent(auditId)}/runs/${encodeURIComponent(selectedRun.id)}/files/download?path=${encodeURIComponent(path)}`
                }
                emptyDescription="运行结束后，scan-manifest、findings、coverage 和报告等产物会显示在这里。"
              />
            </Card>
          ) : (
            <EmptyState
              icon="lucide:folder-tree"
              title="尚无输出文件"
              description="开始一次审计后，Codex Security 的产物会显示在这里。"
            />
          )}
        </TabsContent>

        <TabsContent value="report">
          {reports ? (
            <Card className="p-5">
              <MarkdownContent>{reports.markdown}</MarkdownContent>
            </Card>
          ) : (
            <EmptyState
              icon="lucide:file-text"
              title="报告尚未生成"
              description="完成审计后，canonical report.md 会作为不可变产物保存。"
            />
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}

function ResultPanelState({
  loading,
  error,
  children,
}: {
  loading: boolean
  error: string
  children: React.ReactNode
}): React.ReactElement {
  if (loading) return <Spinner label="加载 canonical 审计结果" />
  if (error) return <ErrorNotice message={error} />
  return <>{children}</>
}

function SectionTitle({ icon, title }: { icon: string; title: string }): React.ReactElement {
  return (
    <div className="mb-4 flex items-center gap-2 border-b border-border/60 pb-3">
      <span className="flex size-6 items-center justify-center rounded-md bg-primary/10 text-primary">
        <Icon icon={icon} width={13} aria-hidden="true" />
      </span>
      <h2 className="text-sm font-semibold">{title}</h2>
    </div>
  )
}

function RunList({
  auditId,
  runs,
  selectedRunId,
  onSelect,
  onControl,
}: {
  auditId: string
  runs: CodeAuditRun[]
  selectedRunId: string
  onSelect: (id: string) => void
  onControl: (id: string, action: "pause" | "resume" | "cancel") => void
}): React.ReactElement {
  if (!runs.length)
    return (
      <EmptyState
        icon="lucide:activity"
        title="尚无审计运行"
        description="在审计设置中保存模型和范围后，开始第一轮审计。"
      />
    )
  const visibleRun = runs.find((run) => run.id === selectedRunId) ?? runs[0]
  if (!visibleRun) return <></>
  const history = runs.filter((run) => run.id !== visibleRun.id)
  return (
    <>
      <AuditRunLog auditId={auditId} run={visibleRun} />
      <Card className="mb-3 overflow-hidden p-0">
        <RunRow run={visibleRun} selected onSelect={onSelect} onControl={onControl} />
      </Card>
      {history.length ? (
        <details className="group">
          <summary className="flex cursor-pointer list-none items-center gap-2 text-xs font-semibold text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40">
            <Icon
              icon="lucide:chevron-right"
              width="14"
              className="transition-transform duration-200 group-open:rotate-90"
              aria-hidden="true"
            />
            其他运行 · {history.length}
          </summary>
          <Card className="mt-3 divide-y divide-border/60 overflow-hidden p-0">
            {history.map((run) => (
              <RunRow
                key={run.id}
                run={run}
                selected={false}
                onSelect={onSelect}
                onControl={onControl}
              />
            ))}
          </Card>
        </details>
      ) : null}
    </>
  )
}

function RunRow({
  run,
  selected,
  onSelect,
  onControl,
}: {
  run: CodeAuditRun
  selected: boolean
  onSelect: (id: string) => void
  onControl: (id: string, action: "pause" | "resume" | "cancel") => void
}): React.ReactElement {
  return (
    <div className={`flex flex-wrap items-center gap-3 px-4 py-3 ${selected ? "bg-muted/40" : ""}`}>
      <span
        className={`size-1.5 shrink-0 rounded-full ${run.status === "running" ? "animate-pulse bg-success motion-reduce:animate-none" : run.status === "paused" ? "bg-warning" : run.status === "failed" ? "bg-danger" : "bg-muted-foreground/40"}`}
        aria-hidden="true"
      />
      <span className="min-w-18 font-mono text-xs">
        {run.purpose === "follow_up" ? "follow-up" : run.mode}
      </span>
      <Badge tone={runTone(run.status)}>{run.status}</Badge>
      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
        {run.followUpPrompt ?? run.error ?? ""}
      </span>
      <Button
        type="button"
        size="sm"
        variant={selected ? "secondary" : "ghost"}
        aria-pressed={selected}
        onClick={() => onSelect(run.id)}
      >
        查看
      </Button>
      {run.status === "running" ? (
        <Button size="sm" variant="outline" onClick={() => onControl(run.id, "pause")}>
          暂停
        </Button>
      ) : null}
      {run.status === "paused" ? (
        <Button size="sm" variant="outline" onClick={() => onControl(run.id, "resume")}>
          恢复
        </Button>
      ) : null}
      {run.status === "running" || run.status === "paused" ? (
        <Button size="sm" variant="outline" onClick={() => onControl(run.id, "cancel")}>
          取消
        </Button>
      ) : null}
    </div>
  )
}

function runTone(status: CodeAuditRun["status"]): "danger" | "positive" | "warning" | "neutral" {
  return status === "failed"
    ? "danger"
    : status === "completed"
      ? "positive"
      : status === "paused"
        ? "warning"
        : status === "running"
          ? "positive"
          : "neutral"
}

export function tabFromSearch(value: string | null): AuditTab {
  return AUDIT_TABS.some((tab) => tab.value === value) ? (value as AuditTab) : "overview"
}
