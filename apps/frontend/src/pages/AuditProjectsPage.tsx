import type { CodeAuditCatalog, CodeAuditProject } from "@ctf-agent/core"
import { Icon } from "@iconify/react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { Link } from "react-router-dom"
import { useApp } from "../app/AppProvider.tsx"
import {
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorNotice,
  PageHeader,
  Spinner,
} from "../components/index.ts"
import { apiMutation, apiRequest } from "../lib/api.ts"
import { errorMessage } from "../lib/format.ts"

export function AuditProjectsPage(): React.ReactElement {
  const { refreshAuditProjects } = useApp()
  const [catalog, setCatalog] = useState<CodeAuditCatalog | null>(null)
  const [error, setError] = useState("")
  const [deleting, setDeleting] = useState<CodeAuditProject | null>(null)
  const [busy, setBusy] = useState(false)
  const load = useCallback(async () => {
    try {
      setCatalog(await apiRequest<CodeAuditCatalog>("/api/audits", { cache: "no-store" }))
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])
  const del = async () => {
    if (!deleting) return
    setBusy(true)
    try {
      await apiMutation(`/api/audits/${encodeURIComponent(deleting.id)}`, "DELETE")
      await refreshAuditProjects()
      await load()
      setDeleting(null)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }
  const active = useMemo(
    () => catalog?.audits.filter((audit) => audit.status === "running") ?? [],
    [catalog],
  )
  const archived = useMemo(
    () => catalog?.audits.filter((audit) => audit.status !== "running") ?? [],
    [catalog],
  )
  if (!catalog && !error) return <Spinner label="加载审计项目" />
  return (
    <div className="page-container">
      <PageHeader
        eyebrow="独立代码审计"
        title="审计项目"
        description="每个归档独立配置、独立运行，不属于任何 CTF 比赛。"
        actions={
          <Button asChild>
            <Link to="/audits/new">
              <Icon icon="lucide:plus" width={15} />
              新建审计项目
            </Link>
          </Button>
        }
      />
      {error ? <ErrorNotice message={error} className="mb-6" /> : null}
      {!catalog?.audits.length ? (
        <Card className="relative overflow-hidden py-12">
          <div className="absolute inset-x-0 top-0 h-px bg-linear-to-r from-transparent via-primary/60 to-transparent" />
          <EmptyState
            icon="lucide:folder-search-2"
            title="还没有审计项目"
            description="上传一份源码压缩包，选择模型和审计范围后开始。"
            action={
              <Button asChild>
                <Link to="/audits/new">登记源码</Link>
              </Button>
            }
          />
        </Card>
      ) : (
        <>
          {active.length ? (
            <AuditSection
              title={`运行中的审计 · ${active.length}`}
              icon="lucide:play"
              audits={active}
              onDelete={setDeleting}
            />
          ) : null}
          {archived.length ? (
            <AuditSection
              title={
                active.length ? `其他项目 · ${archived.length}` : `全部项目 · ${archived.length}`
              }
              icon="lucide:folder-search-2"
              audits={archived}
              onDelete={setDeleting}
            />
          ) : null}
        </>
      )}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setDeleting(null)
        }}
        title={`删除 ${deleting?.name}？`}
        description="永久删除此审计项目的归档记录、配置、运行、报告和发现。运行中的审计必须先取消。"
        confirmLabel="删除审计项目"
        busy={busy}
        onConfirm={() => void del()}
      />
    </div>
  )
}
function AuditSection({
  title,
  icon,
  audits,
  onDelete,
}: {
  title: string
  icon: string
  audits: CodeAuditProject[]
  onDelete: (audit: CodeAuditProject) => void
}) {
  return (
    <section className="mb-8">
      <div className="mb-4 flex items-center gap-3">
        <span className="flex size-6 items-center justify-center rounded-md bg-primary/10 text-primary">
          <Icon icon={icon} width={13} />
        </span>
        <h2 className="text-sm font-semibold text-muted-foreground">{title}</h2>
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {audits.map((audit) => (
          <AuditCard key={audit.id} audit={audit} onDelete={() => onDelete(audit)} />
        ))}
      </div>
    </section>
  )
}
function AuditCard({ audit, onDelete }: { audit: CodeAuditProject; onDelete: () => void }) {
  const live = audit.status === "running"
  return (
    <Card className="surface-hover group relative flex flex-col overflow-hidden p-0">
      <div className="absolute inset-x-0 top-0 h-px bg-linear-to-r from-transparent via-primary/50 to-transparent opacity-0 transition-opacity group-hover:opacity-100" />
      <Link to={`/audits/${encodeURIComponent(audit.id)}`} className="block flex-1 p-4">
        <div className="flex items-start justify-between gap-3">
          <span className="text-[10px] font-bold uppercase tracking-[.14em] text-primary">
            CODE AUDIT
          </span>
          <span className="flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
            <span
              className={`size-1.5 rounded-full ${live ? "animate-pulse bg-green" : "bg-quiet"}`}
            />
            {audit.status}
          </span>
        </div>
        <h3 className="mt-1 truncate text-base font-semibold tracking-tight">{audit.name}</h3>
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-5 gap-y-1 border-t border-border/70 pt-3 text-xs">
          <dt className="text-muted-foreground">源码归档</dt>
          <dd className="truncate text-right font-mono text-[11px]">{audit.archiveName}</dd>
          <dt className="text-muted-foreground">审计范围</dt>
          <dd className="text-right font-mono text-[11px]">
            {audit.includePaths.length || "全部"} 项
          </dd>
        </dl>
      </Link>
      <div className="flex items-center justify-between border-t border-border bg-muted px-4 py-2.5 text-xs text-muted-foreground">
        <span>{(audit.archiveSize / 1024 / 1024).toFixed(1)} MiB</span>
        <div className="flex items-center gap-1">
          <Link
            to={`/audits/${encodeURIComponent(audit.id)}/settings`}
            className="flex size-7 items-center justify-center rounded-md outline-none transition-colors hover:bg-primary/10 hover:text-primary focus-visible:ring-2 focus-visible:ring-ring/50"
            aria-label={`设置 ${audit.name}`}
          >
            <Icon icon="lucide:sliders-horizontal" width={13} />
          </Link>
          <button
            type="button"
            className="flex size-7 items-center justify-center rounded-md outline-none transition-colors hover:bg-danger/10 hover:text-danger focus-visible:ring-2 focus-visible:ring-ring/50"
            aria-label={`删除 ${audit.name}`}
            onClick={(event) => {
              event.preventDefault()
              onDelete()
            }}
          >
            <Icon icon="lucide:trash-2" width={13} />
          </button>
        </div>
      </div>
    </Card>
  )
}
