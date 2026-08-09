import { Icon } from "@iconify/react"
import { useCallback, useEffect, useState } from "react"
import { useNavigate, useParams } from "react-router-dom"
import { toast } from "sonner"
import {
  Badge,
  Button,
  Card,
  ErrorNotice,
  PlatformSetupForm,
  type PlatformSetupOption,
} from "../components/index.ts"
import { apiMutation, apiRequest } from "../lib/api.ts"
import { errorMessage } from "../lib/format.ts"
import { ConversationPanel } from "./challenge/ConversationPanel.tsx"

type GateStatus =
  | "requested"
  | "configuring"
  | "validating"
  | "failed"
  | "ready"
  | "installed"
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

export function FatherPage(): React.ReactElement {
  const { sessionId } = useParams()
  return sessionId ? (
    <FatherConversation sessionId={sessionId} />
  ) : (
    <FatherSessions />
  )
}

function FatherSessions(): React.ReactElement {
  const navigate = useNavigate()
  const [sessions, setSessions] = useState<FatherSession[]>([])
  const [error, setError] = useState("")
  const [creating, setCreating] = useState(false)
  useEffect(() => {
    void apiRequest<{ sessions: FatherSession[] }>("/api/father/sessions")
      .then((r) => setSessions(r.sessions))
      .catch((e) => setError(errorMessage(e)))
  }, [])
  async function create(): Promise<void> {
    setCreating(true)
    try {
      const session = await apiMutation<FatherSession>(
        "/api/father/sessions",
        "POST",
      )
      navigate(`/father/sessions/${session.id}`)
    } catch (e) {
      setError(errorMessage(e))
      setCreating(false)
    }
  }
  return (
    <div className="page-container max-w-5xl">
      <header className="mb-8 flex items-end justify-between gap-4">
        <div>
          <div className="mb-3 flex items-center gap-2 text-primary">
            <Icon icon="emojione-monotone:old-man" width="22" />
            <span className="text-xs font-semibold uppercase tracking-[0.16em]">
              Platform workshop
            </span>
          </div>
          <h1 className="text-3xl font-bold tracking-tight">Clanker Father</h1>
          <p className="mt-2! text-sm text-muted-foreground">
            创建平台插件，或回到一段旧对话继续修复。
          </p>
        </div>
        <Button onClick={() => void create()} disabled={creating}>
          <Icon
            icon={creating ? "lucide:loader-circle" : "lucide:plus"}
            className={creating ? "animate-spin" : ""}
            width="15"
          />
          新建会话
        </Button>
      </header>
      {error ? <ErrorNotice message={error} className="mb-5" /> : null}
      {sessions.length ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {sessions.map((session) => (
            <button
              key={session.id}
              type="button"
              onClick={() => navigate(`/father/sessions/${session.id}`)}
              className="group rounded-xl border border-border bg-card/55 p-4 text-left transition-all hover:-translate-y-0.5 hover:border-primary/35 hover:bg-card"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="truncate text-sm font-semibold">
                    {session.title}
                  </h2>
                  <p className="mt-1! truncate font-mono text-[10px] text-muted-foreground">
                    {session.pluginId ?? session.modelId}
                  </p>
                </div>
                <SessionBadge session={session} />
              </div>
              <div className="mt-5 flex items-center justify-between text-[11px] text-muted-foreground">
                <span>{new Date(session.updatedAt).toLocaleString()}</span>
                <Icon
                  icon="lucide:arrow-up-right"
                  className="opacity-0 transition-opacity group-hover:opacity-100"
                  width="14"
                />
              </div>
            </button>
          ))}
        </div>
      ) : (
        <Card className="grid min-h-64 place-items-center border-dashed p-8 text-center">
          <div>
            <Icon
              icon="emojione-monotone:old-man"
              className="mx-auto mb-4 text-muted-foreground"
              width="32"
            />
            <p className="text-sm font-medium">还没有 Father 会话</p>
            <p className="mt-1! text-xs text-muted-foreground">
              新建后直接描述你想适配或修复的平台。
            </p>
          </div>
        </Card>
      )}
    </div>
  )
}

function FatherConversation({
  sessionId,
}: {
  sessionId: string
}): React.ReactElement {
  const navigate = useNavigate()
  const [session, setSession] = useState<FatherSession>()
  const [gate, setGate] = useState<GateView>()
  const [error, setError] = useState("")
  const load = useCallback(async () => {
    const next = await apiRequest<FatherSession>(
      `/api/father/sessions/${sessionId}`,
    )
    setSession(next)
    if (next.gate) {
      try {
        setGate(
          await apiRequest<GateView>(`/api/father/sessions/${sessionId}/gate`),
        )
      } catch {
        setGate(undefined)
      }
    }
  }, [sessionId])
  useEffect(() => {
    void load().catch((e) => setError(errorMessage(e)))
  }, [load])
  if (!session)
    return (
      <div className="grid h-full place-items-center">
        {error ? (
          <ErrorNotice message={error} />
        ) : (
          <Icon icon="lucide:loader-circle" className="animate-spin" />
        )}
      </div>
    )
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4">
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          onClick={() => navigate("/father")}
          aria-label="返回会话列表"
        >
          <Icon icon="lucide:arrow-left" width="16" />
        </Button>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{session.title}</p>
          <p className="truncate text-[10px] text-muted-foreground">
            {session.modelId}
          </p>
        </div>
        <SessionBadge session={session} />
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
          header={{
            label: "Clanker Father",
            subLabel: session.pluginName ?? session.title,
            icon: "emojione-monotone:old-man",
          }}
          readOnly={["completed", "archived"].includes(session.status)}
          emptyDescription="描述你要创建的平台插件，或告诉 Father 现有插件出了什么问题。"
          composerPlaceholder="描述平台、提供文档或反馈插件问题…"
          notice={
            session.gate ? (
              <GateCard session={session} gate={gate} onChanged={load} />
            ) : null
          }
          onChanged={load}
        />
      </div>
    </div>
  )
}

function GateCard({
  session,
  gate,
  onChanged,
}: {
  session: FatherSession
  gate?: GateView
  onChanged(): Promise<void>
}): React.ReactElement {
  const [editing, setEditing] = useState(!gate?.saved)
  const [config, setConfig] = useState<Record<string, unknown>>(
    gate?.saved?.config ?? gate?.candidate.setup.defaultConfig ?? {},
  )
  const [secrets, setSecrets] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  useEffect(() => {
    if (gate) {
      setConfig(gate.saved?.config ?? gate.candidate.setup.defaultConfig)
      setEditing(!gate.saved)
    }
  }, [gate])
  if (!gate)
    return (
      <div className="shrink-0 border-t border-border bg-card/80 px-4 py-3 text-xs text-muted-foreground">
        <Icon
          icon="lucide:loader-circle"
          className="mr-2 inline animate-spin"
          width="13"
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
  async function validate(): Promise<void> {
    setBusy(true)
    setError("")
    try {
      await apiMutation(`/api/father/sessions/${session.id}/validate`, "POST", {
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
  }
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
    <div className="max-h-[55dvh] shrink-0 overflow-y-auto border-t border-border bg-card/90 px-4 py-3 backdrop-blur">
      <div className="mx-auto max-w-5xl rounded-xl border border-primary/25 bg-primary/5 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex gap-3">
            <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary/12 text-primary">
              <Icon
                icon={ready ? "lucide:badge-check" : "lucide:flask-conical"}
                width="16"
              />
            </span>
            <div>
              <p className="text-sm font-semibold">
                {ready
                  ? `${gate.candidate.name} 验证通过`
                  : `验证 ${gate.candidate.name}`}
              </p>
              <p className="mt-1! text-xs text-muted-foreground">
                {ready
                  ? "报告已绑定当前插件 revision，安装仍需你的批准。"
                  : gate.saved && !editing
                    ? "已保存测试配置，Father 可以继续复用。"
                    : "填写一次测试站连接信息；密钥不会写入验证报告。"}
              </p>
            </div>
          </div>
          {gate.saved && !editing && !ready ? (
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setEditing(true)}
              >
                修改测试配置
              </Button>
              {session.gate?.status === "requested" ? (
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => void validate()}
                >
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
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setEditing(false)}
                >
                  取消
                </Button>
              ) : null}
              <Button size="sm" disabled={busy} onClick={() => void validate()}>
                <Icon
                  icon={busy ? "lucide:loader-circle" : "lucide:play"}
                  className={busy ? "animate-spin" : ""}
                  width="14"
                />
                保存并验证
              </Button>
            </div>
          </div>
        ) : ready ? (
          <div className="mt-4 flex justify-end">
            <Button size="sm" disabled={busy} onClick={() => void install()}>
              <Icon icon="lucide:package-check" width="14" />
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

function SessionBadge({
  session,
}: {
  session: FatherSession
}): React.ReactElement {
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
      tone={
        status === "已安装"
          ? "positive"
          : status === "需处理"
            ? "warning"
            : "neutral"
      }
      className="ml-auto shrink-0 text-[9px]"
    >
      {status}
    </Badge>
  )
}
