import { Icon } from "@iconify/react"
import { useCallback, useEffect, useId, useMemo, useState } from "react"
import { toast } from "sonner"
import {
  Badge,
  Button,
  Card,
  ErrorNotice,
  Input,
  Textarea,
} from "../components/index.ts"
import { apiMutation, apiRequest } from "../lib/api.ts"
import { errorMessage } from "../lib/format.ts"
import { ConversationPanel } from "./challenge/ConversationPanel.tsx"

type FatherStatus =
  | "draft"
  | "running"
  | "stopped"
  | "completed"
  | "failed"
  | "archived"
interface FatherSession {
  id: string
  title: string
  pluginId: string
  status: FatherStatus
  modelId: string
  createdAt: string
}
interface ValidationCheck {
  id: string
  label: string
  status: "passed" | "failed" | "skipped"
  message: string
}
interface ValidationReport {
  status: "failed" | "read_only_verified" | "fully_verified"
  revision: string
  checks: ValidationCheck[]
}

export function FatherPage(): React.ReactElement {
  const [sessions, setSessions] = useState<FatherSession[]>([])
  const [selectedId, setSelectedId] = useState<string>()
  const [title, setTitle] = useState("")
  const [pluginId, setPluginId] = useState("")
  const [configuration, setConfiguration] = useState("{}")
  const [secrets, setSecrets] = useState("{}")
  const [challengeId, setChallengeId] = useState("")
  const [invalidFlag, setInvalidFlag] = useState("")
  const [report, setReport] = useState<ValidationReport>()
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState("")
  const configurationId = useId()
  const secretsId = useId()
  const selected = useMemo(
    () => sessions.find((item) => item.id === selectedId),
    [sessions, selectedId],
  )

  const refresh = useCallback(async (): Promise<void> => {
    const result = await apiRequest<{ sessions: FatherSession[] }>(
      "/api/father/sessions",
    )
    setSessions(result.sessions)
    setSelectedId((current) => current ?? result.sessions[0]?.id)
  }, [])
  useEffect(() => {
    void refresh().catch((cause) => setError(errorMessage(cause)))
  }, [refresh])

  async function create(): Promise<void> {
    setBusy("create")
    setError("")
    try {
      const session = await apiMutation<FatherSession>(
        "/api/father/sessions",
        "POST",
        { title, pluginId },
      )
      await refresh()
      setSelectedId(session.id)
      setTitle("")
      setPluginId("")
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(undefined)
    }
  }
  async function validate(): Promise<void> {
    if (!selected) return
    setBusy("validate")
    setError("")
    try {
      const result = await apiMutation<ValidationReport>(
        `/api/father/sessions/${selected.id}/validate`,
        "POST",
        {
          profile: {
            id: `father-${selected.id}`,
            project: {
              id: `father-${selected.pluginId}`,
              name: `${selected.title} validation`,
            },
            config: JSON.parse(configuration),
            secrets: JSON.parse(secrets),
            expected: challengeId ? { challengeId } : {},
            mutations: invalidFlag ? { invalidFlag } : {},
          },
        },
      )
      setReport(result)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(undefined)
    }
  }
  async function activate(): Promise<void> {
    if (!selected) return
    setBusy("activate")
    try {
      await apiMutation(`/api/father/sessions/${selected.id}/activate`, "POST")
      toast.success("插件已安装并加入平台注册表")
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <div className="flex h-full min-h-0 bg-background">
      <aside className="flex w-72 shrink-0 flex-col border-r border-border bg-card/35 p-3">
        <div className="mb-3 flex items-center gap-2 px-1">
          <Icon icon="emojione-monotone:old-man" width="22" />
          <div>
            <h1 className="text-sm font-semibold">Clanker Father</h1>
            <p className="text-[11px] text-muted-foreground">平台适配工坊</p>
          </div>
        </div>
        <Card className="mb-3 space-y-2 p-3">
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Session 名称"
          />
          <Input
            value={pluginId}
            onChange={(e) => setPluginId(e.target.value)}
            placeholder="插件 ID，如 rctf"
          />
          <Button
            size="sm"
            className="w-full"
            disabled={busy === "create" || !title.trim() || !pluginId.trim()}
            onClick={() => void create()}
          >
            <Icon icon="lucide:plus" width="14" />
            新建 Session
          </Button>
        </Card>
        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
          {sessions.map((session) => (
            <button
              type="button"
              key={session.id}
              onClick={() => {
                setSelectedId(session.id)
                setReport(undefined)
              }}
              className={`w-full rounded-lg border px-3 py-2 text-left transition-colors ${selectedId === session.id ? "border-primary/45 bg-primary/8" : "border-transparent hover:bg-muted/60"}`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-xs font-medium">
                  {session.title}
                </span>
                <Badge className="text-[9px]">{session.status}</Badge>
              </div>
              <p className="mt-1! truncate font-mono text-[10px] text-muted-foreground">
                {session.pluginId} · {session.modelId}
              </p>
            </button>
          ))}
        </div>
      </aside>
      <main className="min-w-0 flex-1">
        {selected ? (
          <ConversationPanel
            target={{ type: "solver" }}
            attempt={1}
            runStatus={
              selected.status === "running" ? "running" : "interrupted"
            }
            hasConversation
            conversationUrl={`/api/father/sessions/${selected.id}/conversation`}
            streamUrl={`/api/father/sessions/${selected.id}/events`}
            sendUrl={`/api/father/sessions/${selected.id}/message`}
            header={{
              label: selected.title,
              subLabel: selected.pluginId,
              icon: "emojione-monotone:old-man",
            }}
            readOnly={["completed", "archived"].includes(selected.status)}
            onChanged={refresh}
          />
        ) : (
          <div className="grid h-full place-items-center text-sm text-muted-foreground">
            新建或选择一个 Father Session
          </div>
        )}
      </main>
      <aside className="w-80 shrink-0 overflow-y-auto border-l border-border bg-card/35 p-4">
        <div className="mb-4">
          <p className="text-xs font-semibold uppercase tracking-[0.15em]">
            Plugin Gate
          </p>
          <p className="mt-1! text-xs text-muted-foreground">
            真实契约测试通过后，仍需手动批准安装。
          </p>
        </div>
        {error ? <ErrorNotice message={error} className="mb-3" /> : null}
        <div className="space-y-3">
          <label htmlFor={configurationId} className="block text-xs">
            平台配置 JSON
            <Textarea
              id={configurationId}
              className="mt-1 font-mono text-xs"
              value={configuration}
              onChange={(e) => setConfiguration(e.target.value)}
            />
          </label>
          <label htmlFor={secretsId} className="block text-xs">
            测试密钥 JSON
            <Textarea
              id={secretsId}
              className="mt-1 font-mono text-xs"
              value={secrets}
              onChange={(e) => setSecrets(e.target.value)}
            />
          </label>
          <Input
            value={challengeId}
            onChange={(e) => setChallengeId(e.target.value)}
            placeholder="期望存在的 challenge ID"
          />
          <Input
            value={invalidFlag}
            onChange={(e) => setInvalidFlag(e.target.value)}
            placeholder="无效测试 flag（可选）"
          />
          <Button
            className="w-full"
            disabled={!selected || busy === "validate"}
            onClick={() => void validate()}
          >
            <Icon icon="lucide:shield-check" width="14" />
            运行验证关口
          </Button>
        </div>
        {report ? (
          <div className="mt-5 space-y-2 border-t border-border pt-4">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold">{report.status}</span>
              <span className="font-mono text-[9px] text-muted-foreground">
                {report.revision.slice(0, 10)}
              </span>
            </div>
            {report.checks.map((check) => (
              <div key={check.id} className="flex gap-2 text-xs">
                <Icon
                  icon={
                    check.status === "passed"
                      ? "lucide:check-circle-2"
                      : check.status === "failed"
                        ? "lucide:x-circle"
                        : "lucide:minus-circle"
                  }
                  className={
                    check.status === "failed"
                      ? "text-danger"
                      : "text-muted-foreground"
                  }
                  width="14"
                />
                <div>
                  <p>{check.label}</p>
                  {check.message ? (
                    <p className="text-[10px] text-muted-foreground">
                      {check.message}
                    </p>
                  ) : null}
                </div>
              </div>
            ))}
            <Button
              variant="secondary"
              className="mt-3 w-full"
              disabled={report.status === "failed" || busy === "activate"}
              onClick={() => void activate()}
            >
              <Icon icon="lucide:badge-check" width="14" />
              批准并安装此 Revision
            </Button>
          </div>
        ) : null}
      </aside>
    </div>
  )
}
