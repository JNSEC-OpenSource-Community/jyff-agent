import { Icon } from "@iconify/react"
import { useCallback, useEffect, useRef, useState } from "react"
import { Link, useNavigate, useParams } from "react-router-dom"
import { toast } from "sonner"
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  ErrorNotice,
  PageHeader,
  PlatformSetupForm,
  type PlatformSetupOption,
} from "../components/index.ts"
import { apiMutation, apiRequest } from "../lib/api.ts"
import { errorMessage } from "../lib/format.ts"
import { ConversationPanel } from "./challenge/ConversationPanel.tsx"
import { WorkspaceFilesBrowser } from "./challenge/WorkspaceFilesPanel.tsx"

type GateStatus = "requested" | "configuring" | "validating" | "failed" | "ready" | "installed"
interface ValidationReport {
  status: "failed" | "read_only_verified" | "fully_verified"
  revision: string
  checks: Array<{
    id: string
    status: "passed" | "failed" | "skipped"
    message: string
  }>
}
interface FatherSession {
  id: string
  title: string
  pluginId?: string
  pluginName?: string
  status: "draft" | "running" | "stopped" | "completed" | "failed" | "archived"
  modelId: string
  updatedAt: string
  gate?: { status: GateStatus; requestedAt: string; report?: ValidationReport }
}
interface GateView {
  candidate: {
    pluginId: string
    name: string
    version: string
    schemaFingerprint: string
    setup: PlatformSetupOption["setup"]
  }
  saved: {
    config: Record<string, unknown>
    configuredSecrets: Record<string, { configured: boolean }>
  } | null
}

const sessionDateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
})

export function FatherPage(): React.ReactElement {
  const { sessionId } = useParams()
  return sessionId ? <FatherConversation sessionId={sessionId} /> : <FatherSessions />
}

function FatherSessions(): React.ReactElement {
  const navigate = useNavigate()
  const [sessions, setSessions] = useState<FatherSession[]>([])
  const [error, setError] = useState("")
  const [creating, setCreating] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<FatherSession>()
  const [deleting, setDeleting] = useState(false)
  useEffect(() => {
    void apiRequest<{ sessions: FatherSession[] }>("/api/father/sessions")
      .then((r) => setSessions(r.sessions))
      .catch((e) => setError(errorMessage(e)))
  }, [])
  async function create(): Promise<void> {
    setCreating(true)
    try {
      const session = await apiMutation<FatherSession>("/api/father/sessions", "POST")
      void navigate(`/father/sessions/${session.id}`)
    } catch (e) {
      setError(errorMessage(e))
      setCreating(false)
    }
  }
  async function remove(): Promise<void> {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await apiMutation(`/api/father/sessions/${deleteTarget.id}`, "DELETE")
      setSessions((current) => current.filter(({ id }) => id !== deleteTarget.id))
      setDeleteTarget(undefined)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setDeleting(false)
    }
  }
  return (
    <div className="page-container max-w-5xl">
      <PageHeader
        eyebrow="平台插件"
        title="Clanker Father"
        description="创建平台插件，或回到一段旧对话继续修复。"
        actions={
          <Button onClick={() => void create()} disabled={creating}>
            <Icon
              icon={creating ? "lucide:loader-circle" : "lucide:plus"}
              className={creating ? "animate-spin" : ""}
              width="15"
              aria-hidden="true"
            />
            新建会话
          </Button>
        }
      />
      {error ? <ErrorNotice message={error} className="mb-5" /> : null}
      {sessions.length ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {sessions.map((session) => (
            <article
              key={session.id}
              className="group grid min-h-28 grid-cols-[minmax(0,1fr)_2.75rem] overflow-hidden rounded-md border border-border bg-card transition-[background-color,border-color] hover:border-muted-foreground/50 hover:bg-muted/30 focus-within:ring-2 focus-within:ring-primary/40 motion-reduce:transition-none"
            >
              <Link
                to={`/father/sessions/${session.id}`}
                className="grid min-w-0 grid-cols-[2.5rem_minmax(0,1fr)] gap-3 p-4 pr-3 outline-none"
              >
                <span
                  className="flex size-10 items-center justify-center rounded-lg bg-primary/8 text-primary ring-1 ring-inset ring-primary/10 transition-colors group-hover:bg-primary/12"
                  aria-hidden="true"
                >
                  <Icon icon="emojione-monotone:old-man" width="19" />
                </span>
                <div className="flex min-w-0 flex-col">
                  <div className="flex min-w-0 items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <h2 className="truncate text-sm font-semibold">{session.title}</h2>
                      <p
                        className="mt-1! truncate font-mono text-[10px] text-muted-foreground"
                        translate="no"
                      >
                        {session.pluginId ?? session.modelId}
                      </p>
                    </div>
                    <SessionBadge session={session} />
                  </div>
                  <div className="mt-auto flex items-end justify-between gap-3 pt-4 text-[11px] text-muted-foreground">
                    <time dateTime={session.updatedAt} className="truncate font-mono tabular-nums">
                      {sessionDateFormatter.format(new Date(session.updatedAt))}
                    </time>
                    <Icon
                      icon="lucide:arrow-up-right"
                      className="shrink-0 translate-y-0.5 opacity-40 transition-[opacity,transform] group-hover:translate-y-0 group-hover:opacity-100 motion-reduce:transform-none motion-reduce:transition-none"
                      width="14"
                      aria-hidden="true"
                    />
                  </div>
                </div>
              </Link>
              <div className="flex items-center justify-center border-l border-border bg-muted/30">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-8 text-muted-foreground/60 hover:bg-danger/10 hover:text-danger focus-visible:text-danger"
                  aria-label={`删除 ${session.title}`}
                  onClick={() => setDeleteTarget(session)}
                >
                  <Icon icon="lucide:trash-2" width="14" aria-hidden="true" />
                </Button>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <Card className="grid min-h-52 place-items-center border-dashed p-6 text-center">
          <div>
            <Icon
              icon="emojione-monotone:old-man"
              className="mx-auto mb-4 text-muted-foreground"
              width="32"
              aria-hidden="true"
            />
            <p className="text-sm font-medium">还没有 Father 会话</p>
            <p className="mt-1! text-xs text-muted-foreground">
              新建后直接描述你想适配或修复的平台。
            </p>
          </div>
        </Card>
      )}
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (!open && !deleting) setDeleteTarget(undefined)
        }}
        title="删除 Father 会话？"
        description="将永久删除这段对话、workspace 和未安装候选；已经安装的插件 revision 不受影响。"
        confirmLabel="删除会话"
        busy={deleting}
        onConfirm={() => void remove()}
      />
    </div>
  )
}

function FatherConversation({ sessionId }: { sessionId: string }): React.ReactElement {
  const [session, setSession] = useState<FatherSession>()
  const [gate, setGate] = useState<GateView>()
  const [gateError, setGateError] = useState("")
  const [gateOpen, setGateOpen] = useState(false)
  const [workspaceOpen, setWorkspaceOpen] = useState(false)
  const lastGateRequest = useRef("")
  const [error, setError] = useState("")
  const load = useCallback(async () => {
    const next = await apiRequest<FatherSession>(`/api/father/sessions/${sessionId}`)
    setSession(next)
    if (next.gate) {
      try {
        setGate(await apiRequest<GateView>(`/api/father/sessions/${sessionId}/gate`))
        setGateError("")
      } catch (cause) {
        setGate(undefined)
        setGateError(errorMessage(cause))
      }
    } else {
      setGate(undefined)
      setGateError("")
    }
  }, [sessionId])
  useEffect(() => {
    void load().catch((e) => setError(errorMessage(e)))
  }, [load])
  useEffect(() => {
    const requestedAt = session?.gate?.requestedAt
    if (
      !requestedAt ||
      session.gate?.status === "installed" ||
      lastGateRequest.current === requestedAt
    )
      return
    lastGateRequest.current = requestedAt
    setGateOpen(true)
  }, [session?.gate?.requestedAt, session?.gate?.status])
  if (!session)
    return (
      <div className="grid h-full place-items-center">
        {error ? (
          <ErrorNotice message={error} />
        ) : (
          <Icon icon="lucide:loader-circle" className="animate-spin" aria-hidden="true" />
        )}
      </div>
    )
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4">
        <Button variant="ghost" size="icon" className="size-8" asChild>
          <Link to="/father" aria-label="返回会话列表">
            <Icon icon="lucide:arrow-left" width="16" aria-hidden="true" />
          </Link>
        </Button>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{session.title}</p>
          <p className="truncate text-[10px] text-muted-foreground">{session.modelId}</p>
        </div>
        <div className="ml-auto flex items-center gap-1">
          {session.gate ? (
            <Button
              variant="ghost"
              size="icon"
              className="relative size-8"
              aria-label="打开测试配置"
              onClick={() => setGateOpen(true)}
            >
              <Icon icon="lucide:flask-conical" width="15" aria-hidden="true" />
              <span className="absolute right-1 bottom-1 size-1.5 rounded-full bg-primary" />
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label="查看 Father workspace 文件"
            onClick={() => setWorkspaceOpen(true)}
          >
            <Icon icon="lucide:folder-tree" width="15" aria-hidden="true" />
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1">
        <ConversationPanel
          target={{ type: "solver" }}
          attempt={1}
          runStatus={session.status === "running" ? "running" : "interrupted"}
          hasConversation
          conversationUrl={`/api/father/sessions/${sessionId}/conversation`}
          streamUrl={`/api/father/sessions/${sessionId}/events`}
          sendUrl={`/api/father/sessions/${sessionId}/message`}
          exportUrl={`/api/father/sessions/${sessionId}/export`}
          stopUrl={`/api/father/sessions/${sessionId}/stop`}
          header={{
            label: "Clanker Father",
            subLabel: session.pluginName ?? session.title,
            icon: "emojione-monotone:old-man",
          }}
          readOnly={["completed", "archived"].includes(session.status)}
          emptyDescription="描述你要创建的平台插件，或告诉 Father 现有插件出了什么问题。"
          composerPlaceholder="描述平台、提供文档或反馈插件问题…"
          idleStatusLabel="Father 正在等待你的指令"
          stopPlacement="composer"
          onChanged={load}
        />
      </div>
      <FatherGateDialog
        open={gateOpen}
        session={session}
        gate={gate}
        error={gateError}
        onOpenChange={setGateOpen}
        onChanged={load}
      />
      <FatherWorkspaceDialog
        open={workspaceOpen}
        sessionId={sessionId}
        onOpenChange={setWorkspaceOpen}
      />
    </div>
  )
}

function FatherWorkspaceDialog({
  open,
  sessionId,
  onOpenChange,
}: {
  open: boolean
  sessionId: string
  onOpenChange: (open: boolean) => void
}): React.ReactElement {
  const baseUrl = `/api/father/sessions/${sessionId}/workspace/files`
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <header className="flex min-h-14 items-center gap-3 border-b border-border px-4">
          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
            <Icon icon="lucide:folder-tree" width="16" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <DialogTitle className="text-sm font-semibold">Father workspace</DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              源码、研究记录、测试和候选输出
            </DialogDescription>
          </div>
          <DialogClose asChild>
            <Button variant="ghost" size="icon" className="size-8" aria-label="关闭文件列表">
              <Icon icon="lucide:x" width="16" aria-hidden="true" />
            </Button>
          </DialogClose>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-4">
          {open ? (
            <WorkspaceFilesBrowser
              listUrl={baseUrl}
              previewUrl={(path) => `${baseUrl}/preview?path=${encodeURIComponent(path)}`}
              downloadUrl={(path) => `${baseUrl}/download?path=${encodeURIComponent(path)}`}
              emptyDescription="Father 尚未在 workspace 中创建文件。"
            />
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function FatherGateDialog({
  open,
  session,
  gate,
  error,
  onOpenChange,
  onChanged,
}: {
  open: boolean
  session: FatherSession
  gate?: GateView
  error: string
  onOpenChange: (open: boolean) => void
  onChanged: () => Promise<void>
}): React.ReactElement {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:h-auto sm:max-h-[88dvh] sm:w-[min(92vw,58rem)]">
        <header className="flex min-h-14 items-center gap-3 border-b border-border px-3 sm:px-4">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
            <Icon icon="lucide:flask-conical" width="17" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate text-sm font-semibold">
              {gate ? `验证 ${gate.candidate.name}` : "准备测试配置"}
            </DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              测试连接信息只保存到当前 Father Session
            </DialogDescription>
          </div>
          <DialogClose asChild>
            <Button variant="ghost" size="icon" className="size-8" aria-label="关闭测试配置">
              <Icon icon="lucide:x" width="16" aria-hidden="true" />
            </Button>
          </DialogClose>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-4">
          {error ? (
            <ErrorNotice message={`无法生成测试表单：${error}`} />
          ) : (
            <GateCard session={session} gate={gate} onChanged={onChanged} />
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function GateCard({
  session,
  gate,
  onChanged,
}: {
  session: FatherSession
  gate?: GateView
  onChanged: () => Promise<void>
}): React.ReactElement {
  const [editing, setEditing] = useState(!gate?.saved)
  const [config, setConfig] = useState<Record<string, unknown>>(
    gate?.saved?.config ?? gate?.candidate.setup.defaultConfig ?? {},
  )
  const [secrets, setSecrets] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const automaticValidation = useRef("")
  const validate = useCallback(async (): Promise<void> => {
    if (!gate) return
    setBusy(true)
    setError("")
    try {
      await apiMutation(`/api/father/sessions/${session.id}/validate`, "POST", {
        schemaFingerprint: gate.candidate.schemaFingerprint,
        config,
        secrets,
      })
      setEditing(false)
      await onChanged()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }, [config, gate, onChanged, secrets, session.id])
  useEffect(() => {
    if (gate) {
      setConfig(gate.saved?.config ?? gate.candidate.setup.defaultConfig)
      setEditing(!gate.saved)
    }
  }, [gate])
  useEffect(() => {
    const fingerprint = gate?.candidate.schemaFingerprint
    if (
      !fingerprint ||
      !gate.saved ||
      config !== gate.saved.config ||
      session.gate?.status !== "requested" ||
      automaticValidation.current === fingerprint
    ) {
      return
    }
    automaticValidation.current = fingerprint
    void validate()
  }, [config, gate, session.gate?.status, validate])
  if (!gate)
    return (
      <div className="flex min-h-40 items-center justify-center text-xs text-muted-foreground">
        <Icon
          icon="lucide:loader-circle"
          className="mr-2 inline animate-spin"
          width="13"
          aria-hidden="true"
        />
        Father 正在准备验证表单…
      </div>
    )
  const candidate = gate.candidate
  const strategyId = String(
    (config.auth as { type?: string } | undefined)?.type ??
      gate.candidate.setup.authStrategies[0]?.id ??
      "",
  )
  async function install(): Promise<void> {
    setBusy(true)
    try {
      await apiMutation(`/api/father/sessions/${session.id}/activate`, "POST")
      toast.success(`${candidate.name} 已安装`)
      await onChanged()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const ready = session.gate?.status === "ready"
  return (
    <div className="space-y-4">
      <div>
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold">
              {ready ? "验证通过" : gate.saved && !editing ? "测试配置已保存" : "填写测试配置"}
            </p>
            <p className="mt-1! text-xs text-muted-foreground">
              {ready
                ? "报告已绑定当前插件 revision，安装仍需你的批准。"
                : gate.saved && !editing
                  ? "已保存测试配置，Father 可以继续复用。"
                  : "填写一次测试站连接信息；密钥不会写入验证报告。"}
            </p>
          </div>
          {gate.saved && !editing && !ready ? (
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
                修改测试配置
              </Button>
              {session.gate?.status === "requested" ? (
                <Button size="sm" disabled={busy} onClick={() => void validate()}>
                  使用已保存配置验证
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
        {error ? <ErrorNotice message={error} className="mt-3" /> : null}
        {editing ? (
          <div className="mt-4 space-y-4 border-t border-border/70 pt-4">
            <PlatformSetupForm
              platform={{
                id: gate.candidate.pluginId,
                setup: gate.candidate.setup,
              }}
              strategyId={strategyId}
              config={config}
              secrets={secrets}
              configuredSecrets={gate.saved?.configuredSecrets}
              onStrategyChange={(id, defaults) => {
                setConfig((current) => ({
                  ...current,
                  ...defaults,
                  auth: { type: id },
                }))
                setSecrets({})
              }}
              onConfigChange={setConfig}
              onSecretsChange={setSecrets}
            />
            <div className="flex justify-end gap-2">
              {gate.saved ? (
                <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
                  取消
                </Button>
              ) : null}
              <Button size="sm" disabled={busy} onClick={() => void validate()}>
                <Icon
                  icon={busy ? "lucide:loader-circle" : "lucide:play"}
                  className={busy ? "animate-spin" : ""}
                  width="14"
                  aria-hidden="true"
                />
                保存并验证
              </Button>
            </div>
          </div>
        ) : ready ? (
          <div className="mt-4 flex justify-end gap-2">
            <Button size="sm" disabled={busy} onClick={() => void install()}>
              <Icon icon="lucide:package-check" width="14" aria-hidden="true" />
              批准并安装
            </Button>
          </div>
        ) : session.gate?.status === "failed" ? (
          <div className="mt-3 flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
              修改配置
            </Button>
            <Button size="sm" disabled={busy} onClick={() => void validate()}>
              再次验证
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function SessionBadge({ session }: { session: FatherSession }): React.ReactElement {
  const status =
    session.gate?.status === "installed"
      ? "已安装"
      : session.gate?.status === "ready"
        ? "等待安装"
        : session.gate?.status === "failed"
          ? "需处理"
          : session.gate?.status === "validating"
            ? "验证中"
            : session.status === "running"
              ? "工作中"
              : "对话"
  return (
    <Badge
      tone={status === "已安装" ? "positive" : status === "需处理" ? "warning" : "neutral"}
      className="ml-auto shrink-0"
    >
      {status}
    </Badge>
  )
}
