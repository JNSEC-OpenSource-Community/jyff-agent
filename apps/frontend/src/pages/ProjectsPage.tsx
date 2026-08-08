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
  Badge,
  Button,
  Card,
  Combobox,
  ConfirmDialog,
  EmptyState,
  ErrorNotice,
  Input,
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
  const [deleting, setDeleting] = useState<(typeof projects)[number] | null>(
    null,
  )
  const [busy, setBusy] = useState(false)
  const [archivingId, setArchivingId] = useState<string | null>(null)
  const [err, setErr] = useState("")

  const running = useMemo(() => projects.filter((p) => !p.archived), [projects])
  const archivedList = useMemo(
    () => projects.filter((p) => p.archived),
    [projects],
  )

  async function toggleArchived(project: ProjectListItem) {
    setArchivingId(project.id)
    setErr("")
    try {
      await apiMutation(
        `/api/projects/${encodeURIComponent(project.id)}/archive`,
        "POST",
        { archived: !project.archived },
      )
      await refreshProjects()
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e))
    } finally {
      setArchivingId(null)
    }
  }

  async function del() {
    if (!deleting) return
    setBusy(true)
    setErr("")
    try {
      await apiMutation(
        `/api/projects/${encodeURIComponent(deleting.id)}`,
        "DELETE",
      )
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
      <header className="mb-10 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="hero-eyebrow text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">
            Workspaces
          </p>
          <h1 className="hero-title mt-3 text-3xl font-bold tracking-tight">
            比赛列表
          </h1>
          <p className="hero-desc mt-3 max-w-xl text-sm text-muted-foreground">
            每场比赛都有独立的调度器、Sandbox 与工作区。
          </p>
        </div>
        <Button asChild>
          <Link to="/projects/new">
            <Icon icon="lucide:plus" width="15" />
            新建比赛
          </Link>
        </Button>
      </header>

      {err ? <ErrorNotice message={err} className="mb-6" /> : null}

      {projects.length === 0 ? (
        <Card className="relative overflow-hidden py-24">
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/60 to-transparent" />
          <EmptyState
            icon="lucide:radar"
            title="暂无比赛"
            description="连接 CTFd 或 GZCTF 后，Agent 自动同步题目并开始调度。"
            action={
              <Button asChild>
                <Link to="/projects/new">连接平台</Link>
              </Button>
            }
          />
        </Card>
      ) : (
        <>
          {running.length > 0 ? (
            <section className="mb-10">
              <div className="mb-4 flex items-center gap-3">
                <span className="flex size-6 items-center justify-center rounded-md bg-green/10 text-green">
                  <Icon icon="lucide:play" width="13" />
                </span>
                <h2 className="text-sm font-semibold text-muted-foreground">
                  Running · {running.length}
                </h2>
              </div>
              <div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
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
                  Archived · {archivedList.length}
                </h2>
              </div>
              <div className="grid grid-cols-1 gap-5 opacity-60 md:grid-cols-2 xl:grid-cols-3">
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
  onDelete,
  onToggleArchived,
}: {
  project: ProjectListItem
  isArchived?: boolean
  archiveBusy?: boolean
  onDelete(): void
  onToggleArchived(): void
}) {
  const ready = project.phase === "ready"
  return (
    <Card className="surface-hover group relative flex flex-col overflow-hidden p-0">
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/50 to-transparent opacity-0 transition-opacity group-hover:opacity-100" />
      <Link
        to={`/projects/${encodeURIComponent(project.id)}`}
        className="block flex-1 p-5"
      >
        <div className="flex items-start justify-between gap-3">
          <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-primary">
            {project.platformId}
          </span>
          <Badge tone={ready ? "positive" : "warning"} className="text-[10px]">
            {ready ? "已连接" : "待恢复"}
          </Badge>
        </div>
        <h3 className="mt-5 truncate text-[17px] font-semibold tracking-tight">
          {project.name}
        </h3>
        <div className="mt-4 grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 border-t border-border/70 pt-3 text-xs">
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
      <div className="flex items-center justify-between border-t border-border bg-muted px-5 py-3">
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span
            className={cn(
              "size-1.5 rounded-full",
              ready ? "bg-green animate-pulse" : "bg-amber",
            )}
          />
          {ready ? "运行正常" : "需要关注"}
        </span>
        <div className="flex items-center gap-1">
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

  useEffect(() => {
    void apiRequest<ControlPlaneSetupSnapshot>("/api/control-plane")
      .then((s) => {
        setSetup(s)
        const f = s.platforms[0]
        if (f) {
          const fs = f.setup.authStrategies[0]
          setPlatId(f.id)
          setStratId(fs?.id ?? "")
          setCfg({ ...f.setup.defaultConfig, ...(fs?.config ?? {}) })
        }
      })
      .catch((e) => setErr(String(e instanceof Error ? e.message : e)))
  }, [])

  const plats = setup?.platforms ?? []
  const plat = plats.find((c) => c.id === platId)
  const pid = useMemo(() => contestIdFromName(pname), [pname])
  function pickPlat(p: SP) {
    setPlatId(p.id)
    const s = p.setup.authStrategies[0]
    setStratId(s?.id ?? "")
    setCfg({ ...p.setup.defaultConfig, ...(s?.config ?? {}) })
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
    return { config: c, secrets }
  }, [cfg, platId, pid, pname, secrets])

  async function testConn() {
    setBusy("test")
    setErr("")
    try {
      const r = await apiMutation<PlatformConnectionTest>(
        "/api/projects/test",
        "POST",
        payload,
      )
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
      nav(
        `/projects/${encodeURIComponent(
          r.project.projectId ?? payload.config.project.id,
        )}`,
      )
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e))
    } finally {
      setBusy(null)
    }
  }

  if (!setup) return <Spinner label="加载平台插件" />

  return (
    <div className="page-container">
      <header className="mb-8">
        <p className="hero-eyebrow text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">
          New Workspace
        </p>
        <h1 className="hero-title mt-3 text-3xl font-bold tracking-tight">
          连接比赛平台
        </h1>
        <p className="hero-desc mt-3 max-w-xl text-sm text-muted-foreground">
          验证成功后自动从平台读取比赛信息并生成配置。
        </p>
      </header>

      {err ? <ErrorNotice message={err} className="mb-6" /> : null}

      <div className="space-y-4">
        <Card className="overflow-hidden p-0">
          <div className="border-b border-border bg-muted px-6 py-4">
            <div className="flex items-center gap-3">
              <StepBadge n={1} active={true} />
              <h2 className="font-semibold">平台类型</h2>
            </div>
            <p className="mt-1 pl-10 text-sm text-muted-foreground">
              选择要接入的比赛平台插件。
            </p>
          </div>
          <div className="p-6">
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
              <p className="mt-2 text-xs leading-5 text-muted-foreground">
                {plat.setup.description}
              </p>
            ) : null}
          </div>
        </Card>

        <Card className="overflow-hidden p-0">
          <div className="border-b border-border bg-muted px-6 py-4">
            <div className="flex items-center gap-3">
              <StepBadge n={2} active={Boolean(platId)} />
              <h2 className="font-semibold">连接信息</h2>
            </div>
            <p className="mt-1 pl-10 text-sm text-muted-foreground">
              填写站点、认证和比赛信息，并验证连接。
            </p>
          </div>
          <section className="space-y-5 p-6">
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
              disabled={busy !== null}
            >
              <Icon
                icon={
                  busy === "test" ? "lucide:loader-circle" : "lucide:plug-zap"
                }
                className={busy === "test" ? "animate-spin" : ""}
                width="14"
              />
              验证连接
            </Button>

            {testR ? (
              <div className="flex items-center gap-3 rounded-xl border border-green/30 bg-green/5 px-4 py-3 text-sm text-green">
                <Icon icon="lucide:circle-check" width="17" />
                <span>
                  <strong>{testR.overview.name}</strong> ·{" "}
                  {testR.overview.challenges} 题 ·{" "}
                  {testR.overview.announcements} 公告
                </span>
              </div>
            ) : null}
          </section>
        </Card>

        <Card className="overflow-hidden p-0">
          <div className="border-b border-border bg-muted px-6 py-4">
            <div className="flex items-center gap-3">
              <StepBadge n={3} active={testR !== null} />
              <h2 className="font-semibold">比赛标识</h2>
            </div>
            <p className="mt-1 pl-10 text-sm text-muted-foreground">
              输入比赛名称，浏览器会实时生成对应的拼音 ID。
            </p>
          </div>
          <section className="p-6">
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
                  placeholder="例如：巅峰极客 2026"
                  onChange={(e) => setPname(e.target.value)}
                />
              </div>
              <div>
                <label
                  htmlFor="project-id"
                  className="mb-1.5 block text-xs font-medium text-muted-foreground"
                >
                  比赛 ID（自动生成）
                </label>
                <Input
                  id="project-id"
                  value={pid}
                  placeholder="输入比赛名称后生成"
                  disabled
                />
                <p className="mt-1 text-[11px] text-muted-foreground">
                  用于路由与持久化，创建后不可修改。
                </p>
              </div>
            </div>
          </section>

          <div className="flex justify-end gap-3 border-t border-border bg-muted px-6 py-4">
            <Button variant="ghost" asChild>
              <Link to="/">取消</Link>
            </Button>
            <Button
              onClick={() => void submit()}
              disabled={!testR || !pid.trim() || !pname.trim() || busy !== null}
            >
              {busy === "create" ? (
                <Icon
                  icon="lucide:loader-circle"
                  className="animate-spin"
                  width="14"
                />
              ) : null}
              创建比赛
            </Button>
          </div>
        </Card>
      </div>
    </div>
  )
}

function StepBadge({ n, active }: { n: number; active: boolean }) {
  return (
    <span
      className={cn(
        "flex size-7 items-center justify-center rounded-full text-xs font-bold",
        active
          ? "bg-primary/10 text-primary"
          : "bg-muted/70 text-muted-foreground",
      )}
    >
      {n}
    </span>
  )
}
