import type {
  ControlPlaneSetupSnapshot,
  PlatformConnectionTest,
  ProjectConfig,
} from "@ctf-agent/core"
import { Icon } from "@iconify/react"
import { useEffect, useMemo, useState } from "react"
import { Link, useNavigate } from "react-router-dom"
import { type ProjectListItem, useApp } from "../app/AppProvider.tsx"
import {
  Button,
  Card,
  Combobox,
  ConfirmDialog,
  EmptyState,
  ErrorNotice,
  Input,
  PageHeader,
  PlatformSetupForm,
  Spinner,
} from "../components/index.ts"
import { apiMutation, apiRequest } from "../lib/api.ts"
import { contestIdFromName } from "../lib/contest-name.ts"
import { absoluteTime } from "../lib/time.ts"
import { cn } from "../lib/utils.ts"

/* ═══════════════════════════ Project list ═══════════════════════════ */

export function ProjectsPage() {
  const { projects, loading, refreshProjects } = useApp()
  const [deleting, setDeleting] = useState<(typeof projects)[number] | null>(null)
  const [busy, setBusy] = useState(false)
  const [archivingId, setArchivingId] = useState<string | null>(null)
  const [startingId, setStartingId] = useState<string | null>(null)
  const [err, setErr] = useState("")

  const pending = useMemo(
    () => projects.filter((p) => !p.archived && p.activation?.state === "pending"),
    [projects],
  )
  const running = useMemo(
    () => projects.filter((p) => !p.archived && p.activation?.state !== "pending"),
    [projects],
  )
  const archivedList = useMemo(() => projects.filter((p) => p.archived), [projects])

  async function toggleArchived(project: ProjectListItem) {
    setArchivingId(project.id)
    setErr("")
    try {
      await apiMutation(`/api/projects/${encodeURIComponent(project.id)}/archive`, "POST", {
        archived: !project.archived,
      })
      await refreshProjects()
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e))
    } finally {
      setArchivingId(null)
    }
  }

  async function startProject(project: ProjectListItem) {
    setStartingId(project.id)
    setErr("")
    try {
      await apiMutation(`/api/projects/${encodeURIComponent(project.id)}/start`, "POST")
      await refreshProjects()
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e))
    } finally {
      setStartingId(null)
    }
  }

  async function del() {
    if (!deleting) return
    setBusy(true)
    setErr("")
    try {
      await apiMutation(`/api/projects/${encodeURIComponent(deleting.id)}`, "DELETE")
      await refreshProjects()
      setDeleting(null)
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e))
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <Spinner label="读取比赛列表" />

  return (
    <div className="page-container">
      <PageHeader
        eyebrow="比赛管理"
        title="比赛列表"
        description="连接平台、同步题目，然后从队列开始解题。"
        actions={
          <Button asChild>
            <Link to="/projects/new">
              <Icon icon="lucide:plus" width="15" />
              新建比赛
            </Link>
          </Button>
        }
      />

      {err ? <ErrorNotice message={err} className="mb-6" /> : null}

      {projects.length === 0 ? (
        <Card className="relative overflow-hidden py-12">
          <div className="absolute inset-x-0 top-0 h-px bg-linear-to-r from-transparent via-primary/60 to-transparent" />
          <EmptyState
            icon="lucide:radar"
            title="暂无比赛"
            description="连接 CTFd 或 GZCTF 后即可同步题目；准备好模型后再启动调度。"
            action={
              <Button asChild>
                <Link to="/projects/new">连接平台</Link>
              </Button>
            }
          />
        </Card>
      ) : (
        <>
          {pending.length > 0 ? (
            <section className="mb-8">
              <div className="mb-4 flex items-center gap-3">
                <span className="flex size-6 items-center justify-center rounded-md bg-amber/10 text-amber">
                  <Icon icon="lucide:timer" width="13" />
                </span>
                <h2 className="text-sm font-semibold text-muted-foreground">
                  待开始的比赛 · {pending.length}
                </h2>
              </div>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                {pending.map((p) => (
                  <ProjectCard
                    key={p.id}
                    project={p}
                    isArchived={false}
                    startBusy={startingId === p.id}
                    onStart={
                      p.activation?.scheduledStartAt ? undefined : () => void startProject(p)
                    }
                    onDelete={() => {
                      setErr("")
                      setDeleting(p)
                    }}
                    archiveBusy={archivingId === p.id}
                    onToggleArchived={() => void toggleArchived(p)}
                  />
                ))}
              </div>
            </section>
          ) : null}
          {running.length > 0 ? (
            <section className="mb-8">
              <div className="mb-4 flex items-center gap-3">
                <span className="flex size-6 items-center justify-center rounded-md bg-green/10 text-green">
                  <Icon icon="lucide:play" width="13" />
                </span>
                <h2 className="text-sm font-semibold text-muted-foreground">
                  进行中的比赛 · {running.length}
                </h2>
              </div>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                {running.map((p) => (
                  <ProjectCard
                    key={p.id}
                    project={p}
                    isArchived={false}
                    onDelete={() => {
                      setErr("")
                      setDeleting(p)
                    }}
                    archiveBusy={archivingId === p.id}
                    onToggleArchived={() => void toggleArchived(p)}
                  />
                ))}
              </div>
            </section>
          ) : null}
          {archivedList.length > 0 ? (
            <section>
              <div className="mb-4 flex items-center gap-3">
                <span className="flex size-6 items-center justify-center rounded-md bg-muted text-muted-foreground">
                  <Icon icon="lucide:archive" width="13" />
                </span>
                <h2 className="text-sm font-semibold text-muted-foreground">
                  已归档 · {archivedList.length}
                </h2>
              </div>
              <div className="grid grid-cols-1 gap-4 opacity-60 md:grid-cols-2 xl:grid-cols-3">
                {archivedList.map((p) => (
                  <ProjectCard
                    key={p.id}
                    project={p}
                    isArchived={true}
                    onDelete={() => {
                      setErr("")
                      setDeleting(p)
                    }}
                    archiveBusy={archivingId === p.id}
                    onToggleArchived={() => void toggleArchived(p)}
                  />
                ))}
              </div>
            </section>
          ) : null}
        </>
      )}

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => {
          if (!o && !busy) setDeleting(null)
        }}
        title={`删除 ${deleting?.name}？`}
        description="永久删除此比赛的调度器、Agent、Run、对话、工作区与配置。全局模型不受影响。"
        confirmLabel="删除"
        busy={busy}
        onConfirm={() => void del()}
      />
    </div>
  )
}

function ProjectCard({
  project,
  isArchived = false,
  archiveBusy = false,
  startBusy = false,
  onStart,
  onDelete,
  onToggleArchived,
}: {
  project: ProjectListItem
  isArchived?: boolean
  archiveBusy?: boolean
  startBusy?: boolean
  onStart?: () => void
  onDelete: () => void
  onToggleArchived: () => void
}) {
  const pending = !isArchived && project.activation?.state === "pending"
  const ready = !isArchived && !pending && project.phase === "ready" && !project.lastError
  return (
    <Card className="surface-hover group relative flex flex-col overflow-hidden p-0">
      <div className="absolute inset-x-0 top-0 h-px bg-linear-to-r from-transparent via-primary/50 to-transparent opacity-0 transition-opacity group-hover:opacity-100" />
      <Link to={`/projects/${encodeURIComponent(project.id)}`} className="block flex-1 p-4">
        <div className="flex items-start justify-between gap-3">
          <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-primary">
            {project.platformId}
          </span>
        </div>
        <h3 className="mt-1 truncate text-base font-semibold tracking-tight">{project.name}</h3>
        <div className="mt-3 grid grid-cols-[auto_1fr] gap-x-5 gap-y-1 border-t border-border/70 pt-3 text-xs">
          <span className="text-muted-foreground">解题进度</span>
          <strong className="text-right font-mono tabular-nums">
            {project.solved} / {project.total}
          </strong>
          <span className="text-muted-foreground">创建时间</span>
          <time
            dateTime={project.createdAt}
            className="text-right font-mono text-[11px] tabular-nums"
          >
            {absoluteTime(project.createdAt)}
          </time>
        </div>
      </Link>
      <div className="flex items-center justify-between border-t border-border bg-muted px-4 py-2.5">
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span
            className={cn("size-1.5 rounded-full", ready ? "bg-green animate-pulse" : "bg-amber")}
          />
          {ready
            ? "运行正常"
            : isArchived
              ? "已归档"
              : pending
                ? project.activation?.scheduledStartAt
                  ? `计划 ${absoluteTime(project.activation.scheduledStartAt)}`
                  : "等待手动开始"
                : "平台故障"}
        </span>
        <div className="flex items-center gap-1">
          {onStart ? (
            <button
              type="button"
              disabled={startBusy}
              className="flex h-7 items-center gap-1 rounded-md bg-primary px-2 text-[11px] font-medium text-primary-foreground transition-opacity hover:opacity-85 disabled:pointer-events-none disabled:opacity-60"
              onClick={(e) => {
                e.preventDefault()
                onStart()
              }}
            >
              <Icon
                icon={startBusy ? "lucide:loader-circle" : "lucide:play"}
                className={startBusy ? "animate-spin" : undefined}
                width="12"
              />
              开始比赛
            </button>
          ) : null}
          <button
            type="button"
            disabled={archiveBusy}
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-all hover:-translate-y-px hover:bg-primary/10 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
            aria-label={isArchived ? "取消归档" : "归档"}
            onClick={(e) => {
              e.preventDefault()
              onToggleArchived()
            }}
          >
            <Icon
              icon={
                archiveBusy
                  ? "lucide:loader-circle"
                  : isArchived
                    ? "lucide:archive-restore"
                    : "lucide:archive"
              }
              className={archiveBusy ? "animate-spin" : undefined}
              width="13"
            />
          </button>
          <button
            type="button"
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-danger/10 hover:text-danger"
            aria-label={`删除 ${project.name}`}
            onClick={(e) => {
              e.preventDefault()
              onDelete()
            }}
          >
            <Icon icon="lucide:trash-2" width="13" />
          </button>
        </div>
      </div>
    </Card>
  )
}

/* ═══════════════════════════ Create project ═══════════════════════════ */

type SP = ControlPlaneSetupSnapshot["platforms"][number]

export function NewProjectPage() {
  const nav = useNavigate()
  const { refreshProjects } = useApp()
  const [setup, setSetup] = useState<ControlPlaneSetupSnapshot | null>(null)
  const [platId, setPlatId] = useState("")
  const [stratId, setStratId] = useState("")
  const [pname, setPname] = useState("")
  const [cfg, setCfg] = useState<Record<string, unknown>>({})
  const [secrets, setSecrets] = useState<Record<string, string>>({})
  const [testR, setTestR] = useState<PlatformConnectionTest | null>(null)
  const [err, setErr] = useState("")
  const [busy, setBusy] = useState<"test" | "create" | null>(null)
  const [startMode, setStartMode] = useState<"now" | "manual" | "scheduled">("now")
  const [scheduledStartAt, setScheduledStartAt] = useState("")

  useEffect(() => {
    void apiRequest<ControlPlaneSetupSnapshot>("/api/control-plane")
      .then((s) => {
        setSetup(s)
        const f = s.platforms[0]
        if (f) {
          const fs = f.setup.authStrategies[0]
          setPlatId(f.id)
          setStratId(fs?.id ?? "")
          setCfg({ ...f.setup.defaultConfig, ...fs?.config })
        }
      })
      .catch((e) => setErr(String(e instanceof Error ? e.message : e)))
  }, [])

  const plats = setup?.platforms ?? []
  const plat = plats.find((c) => c.id === platId)
  const [pid, setPid] = useState("")
  useEffect(() => {
    let active = true
    void contestIdFromName(pname).then((next) => {
      if (active) setPid(next)
    })
    return () => {
      active = false
    }
  }, [pname])
  function pickPlat(p: SP) {
    setPlatId(p.id)
    const s = p.setup.authStrategies[0]
    setStratId(s?.id ?? "")
    setCfg({ ...p.setup.defaultConfig, ...s?.config })
    setSecrets({})
    setTestR(null)
  }

  const payload = useMemo(() => {
    const c: ProjectConfig = {
      version: 1,
      project: {
        id: pid || "connection-test",
        name: pname.trim() || "新比赛",
      },
      platform: { plugin: platId, config: cfg },
      sandbox: {
        image: "ctf-agent-solver:latest",
        privileged: false,
        networkMode: "bridge",
      },
    }
    const start =
      startMode === "now"
        ? { mode: "now" as const }
        : startMode === "manual"
          ? { mode: "manual" as const }
          : {
              mode: "scheduled" as const,
              scheduledStartAt: toIsoOrEmpty(scheduledStartAt),
            }
    return { config: c, secrets, start }
  }, [cfg, platId, pid, pname, scheduledStartAt, secrets, startMode])

  async function testConn() {
    if (startMode !== "now") return
    setBusy("test")
    setErr("")
    try {
      const r = await apiMutation<PlatformConnectionTest>("/api/projects/test", "POST", payload)
      setTestR(r)
    } catch (e) {
      setTestR(null)
      setErr(String(e instanceof Error ? e.message : e))
    } finally {
      setBusy(null)
    }
  }

  async function submit() {
    setBusy("create")
    setErr("")
    try {
      const r = await apiMutation<{ project: { projectId: string | null } }>(
        "/api/projects",
        "POST",
        payload,
      )
      await refreshProjects()
      void nav(`/projects/${encodeURIComponent(r.project.projectId ?? payload.config.project.id)}`)
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e))
    } finally {
      setBusy(null)
    }
  }

  if (!setup) return <Spinner label="加载平台插件" />

  return (
    <div className="page-container">
      <PageHeader
        eyebrow="添加比赛"
        title="连接比赛平台"
        description="连接 CTFd 或 GZCTF，准备好模型后开始调度。"
      />

      {err ? <ErrorNotice message={err} className="mb-6" /> : null}

      <div className="space-y-4">
        <Card className="overflow-hidden p-0">
          <div className="border-b border-border bg-muted px-4 py-3">
            <div className="flex items-center gap-3">
              <StepBadge n={1} active={true} />
              <h2 className="font-semibold">平台类型</h2>
            </div>
            <p className="mt-1! pl-10 text-sm text-muted-foreground">选择要接入的比赛平台插件。</p>
          </div>
          <div className="p-4">
            <Combobox
              value={platId}
              onChange={(id) => {
                const next = plats.find((item) => item.id === id)
                if (next) pickPlat(next)
              }}
              options={plats.map((item) => ({
                value: item.id,
                label: item.setup.label,
                description: item.setup.description,
              }))}
              placeholder="选择平台插件"
              searchPlaceholder="搜索平台插件…"
              emptyText="没有可用的平台插件"
            />
            {plat ? (
              <p className="mt-2! text-xs leading-5 text-muted-foreground">
                {plat.setup.description}
              </p>
            ) : null}
          </div>
        </Card>

        <Card className="overflow-hidden p-0">
          <div className="border-b border-border bg-muted px-4 py-3">
            <div className="flex items-center gap-3">
              <StepBadge n={2} active={Boolean(platId)} />
              <h2 className="font-semibold">连接信息</h2>
            </div>
            <p className="mt-1! pl-10 text-sm text-muted-foreground">
              填写站点、认证和比赛信息，并验证连接。
            </p>
          </div>
          <section className="space-y-4 p-4">
            {plat ? (
              <PlatformSetupForm
                platform={plat}
                strategyId={stratId}
                config={cfg}
                secrets={secrets}
                onStrategyChange={(id, defaults) => {
                  setStratId(id)
                  setCfg((current) => ({ ...current, ...defaults }))
                  setSecrets({})
                  setTestR(null)
                }}
                onConfigChange={(next) => {
                  setCfg(next)
                  setTestR(null)
                }}
                onSecretsChange={(next) => {
                  setSecrets(next)
                  setTestR(null)
                }}
              />
            ) : null}

            <Button
              variant="secondary"
              onClick={() => void testConn()}
              disabled={busy !== null || startMode !== "now"}
            >
              <Icon
                icon={busy === "test" ? "lucide:loader-circle" : "lucide:plug-zap"}
                className={busy === "test" ? "animate-spin" : ""}
                width="14"
              />
              验证连接
            </Button>

            {testR ? (
              <div className="flex items-center gap-3 rounded-md border border-green/30 bg-green/5 px-3 py-2.5 text-sm text-green">
                <Icon icon="lucide:circle-check" width="17" />
                <span>
                  <strong>{testR.overview.name}</strong> · {testR.overview.challenges} 题 ·{" "}
                  {testR.overview.announcements} 公告
                </span>
              </div>
            ) : null}
          </section>
        </Card>

        <Card className="overflow-hidden p-0">
          <div className="border-b border-border bg-muted px-4 py-3">
            <div className="flex items-center gap-3">
              <StepBadge n={3} active={true} />
              <h2 className="font-semibold">开始方式</h2>
            </div>
            <p className="mt-1! pl-10 text-sm text-muted-foreground">
              未开始的比赛不会请求平台；可以在时间到达时自动开始，或稍后手动开始。
            </p>
          </div>
          <section className="space-y-3 p-4">
            <StartModeOption
              checked={startMode === "now"}
              value="now"
              title="立即开始并验证连接"
              description="现在连接平台并同步题目。"
              onChange={() => {
                setStartMode("now")
                setTestR(null)
              }}
            />
            <StartModeOption
              checked={startMode === "manual"}
              value="manual"
              title="稍后手动开始"
              description="先保存比赛，准备好后点击“开始比赛”。"
              onChange={() => {
                setStartMode("manual")
                setTestR(null)
              }}
            />
            <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border p-3 hover:bg-muted/50">
              <input
                type="radio"
                name="start-mode"
                value="scheduled"
                checked={startMode === "scheduled"}
                onChange={() => {
                  setStartMode("scheduled")
                  setTestR(null)
                }}
                className="mt-0.5 accent-primary"
              />
              <span className="min-w-0 flex-1">
                <strong className="block text-sm">设定开始时间</strong>
                <span className="text-xs text-muted-foreground">到达时间后自动连接平台。</span>
                {startMode === "scheduled" ? (
                  <Input
                    aria-label="比赛开始时间"
                    type="datetime-local"
                    value={scheduledStartAt}
                    onChange={(event) => setScheduledStartAt(event.target.value)}
                    className="mt-2 max-w-sm"
                  />
                ) : null}
              </span>
            </label>
          </section>
        </Card>

        <Card className="overflow-hidden p-0">
          <div className="border-b border-border bg-muted px-4 py-3">
            <div className="flex items-center gap-3">
              <StepBadge n={4} active={Boolean(testR !== null || startMode !== "now")} />
              <h2 className="font-semibold">比赛标识</h2>
            </div>
            <p className="mt-1! pl-10 text-sm text-muted-foreground">
              输入比赛名称，浏览器会实时生成对应的拼音 ID。
            </p>
          </div>
          <section className="p-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label
                  htmlFor="project-name"
                  className="mb-1.5 block text-xs font-medium text-muted-foreground"
                >
                  比赛名称
                </label>
                <Input
                  id="project-name"
                  value={pname}
                  placeholder="例如：SlopCON CTF 2026"
                  onChange={(e) => setPname(e.target.value)}
                />
              </div>
              <div>
                <label
                  htmlFor="project-id"
                  className="mb-1.5 block text-xs font-medium text-muted-foreground"
                >
                  比赛 ID
                </label>
                <Input id="project-id" value={pid} placeholder="自动生成" disabled />
              </div>
            </div>
          </section>

          <div className="flex justify-end gap-3 border-t border-border bg-muted px-4 py-3">
            <Button
              onClick={() => void submit()}
              disabled={
                !pid.trim() ||
                !pname.trim() ||
                busy !== null ||
                (startMode === "now" && !testR) ||
                (startMode === "scheduled" && !scheduledStartAt)
              }
            >
              {busy === "create" ? (
                <Icon icon="lucide:loader-circle" className="animate-spin" width="14" />
              ) : null}
              {startMode === "now" ? "创建比赛" : "保存比赛"}
            </Button>
          </div>
        </Card>
      </div>
    </div>
  )
}

function toIsoOrEmpty(value: string): string {
  if (!value) return ""
  const timestamp = Date.parse(value)
  return Number.isNaN(timestamp) ? "" : new Date(timestamp).toISOString()
}

function StartModeOption({
  checked,
  value,
  title,
  description,
  onChange,
}: {
  checked: boolean
  value: "now" | "manual"
  title: string
  description: string
  onChange: () => void
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border p-3 hover:bg-muted/50">
      <input
        type="radio"
        name="start-mode"
        value={value}
        checked={checked}
        onChange={onChange}
        className="mt-0.5 accent-primary"
      />
      <span>
        <strong className="block text-sm">{title}</strong>
        <span className="text-xs text-muted-foreground">{description}</span>
      </span>
    </label>
  )
}

function StepBadge({ n, active }: { n: number; active: boolean }) {
  return (
    <span
      className={cn(
        "flex size-7 items-center justify-center rounded-full text-xs font-bold",
        active ? "bg-primary/10 text-primary" : "bg-muted/70 text-muted-foreground",
      )}
    >
      {n}
    </span>
  )
}
