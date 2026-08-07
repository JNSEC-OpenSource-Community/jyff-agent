import type { AgentMessage } from "@earendil-works/pi-agent-core"
import { Icon } from "@iconify/react"
import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react"
import { useParams } from "react-router-dom"
import type {
  ChallengeDetails,
  DashboardConversation,
  DashboardRun,
  DashboardSubagent,
} from "../types.ts"
import { apiMutation, apiRequest, projectApi } from "./api.ts"
import {
  Badge,
  Button,
  Card,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  EmptyState,
  ErrorNotice,
  PageHeader,
  Spinner,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "./components/index.ts"
import {
  absoluteTime,
  EVENT_LABELS,
  errorMessage,
  STATUS_LABELS,
  TOOL_LABELS,
} from "./lib.ts"

type ConversationTarget =
  | { type: "solver" }
  | { type: "subagent"; subagent: DashboardSubagent }

function toneForStatus(
  status: string,
): "neutral" | "positive" | "warning" | "danger" | "info" {
  if (["solved", "completed"].includes(status)) return "positive"
  if (["running", "preparing", "writing_writeup", "blocking"].includes(status))
    return "info"
  if (["failed", "blocked", "interrupted", "aborted"].includes(status))
    return "danger"
  if (["queued", "pending"].includes(status)) return "warning"
  return "neutral"
}

function textContent(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .filter((part): part is { type: "text"; text: string } =>
      Boolean(
        part &&
          typeof part === "object" &&
          (part as { type?: unknown }).type === "text" &&
          typeof (part as { text?: unknown }).text === "string",
      ),
    )
    .map((part) => part.text)
    .join("\n")
}

function ToolBlock({
  label,
  detail,
  error,
}: {
  label: string
  detail: string
  error?: boolean
}): React.ReactElement {
  return (
    <Collapsible className={error ? "tool-block is-error" : "tool-block"}>
      <CollapsibleTrigger className="tool-block-trigger">
        <Icon icon={error ? "lucide:circle-x" : "lucide:terminal"} width="16" />
        <span>{label}</span>
        <Icon icon="lucide:chevron-down" className="tool-chevron" width="15" />
      </CollapsibleTrigger>
      <CollapsibleContent className="tool-block-content">
        <pre>{detail || "（无输出）"}</pre>
      </CollapsibleContent>
    </Collapsible>
  )
}

function MessageBody({
  message,
}: {
  message: AgentMessage
}): React.ReactElement {
  if (message.role === "user") {
    return <div className="message-text">{textContent(message.content)}</div>
  }
  if (message.role === "assistant") {
    return (
      <div className="message-parts">
        {message.content.map((part, index) => {
          if (part.type === "text")
            return (
              <div className="message-text" key={`text-${index}`}>
                {part.text}
              </div>
            )
          if (part.type === "thinking")
            return (
              <Collapsible
                className="thinking-block"
                key={`thinking-${index}`}
              >
                <CollapsibleTrigger className="thinking-trigger">
                  <Icon icon="lucide:brain" width="15" /> 推理记录
                  <Icon
                    icon="lucide:chevron-down"
                    className="tool-chevron"
                    width="14"
                  />
                </CollapsibleTrigger>
                <CollapsibleContent className="thinking-content">
                  {part.redacted
                    ? "推理内容已由模型提供方隐藏。"
                    : part.thinking}
                </CollapsibleContent>
              </Collapsible>
            )
          if (part.type === "toolCall")
            return (
              <ToolBlock
                key={part.id}
                label={TOOL_LABELS[part.name] ?? part.name}
                detail={JSON.stringify(part.arguments, null, 2)}
              />
            )
          return null
        })}
        {message.errorMessage ? (
          <div className="message-error">{message.errorMessage}</div>
        ) : null}
      </div>
    )
  }
  if (message.role === "toolResult") {
    return (
      <ToolBlock
        label={`${TOOL_LABELS[message.toolName] ?? message.toolName} · 返回`}
        detail={textContent(message.content)}
        error={message.isError}
      />
    )
  }

  const custom = message as unknown as Record<string, unknown>
  if (message.role === "bashExecution") {
    return (
      <ToolBlock
        label="终端命令"
        detail={`$ ${String(custom.command ?? "")}\n${String(custom.output ?? "")}`}
        error={typeof custom.exitCode === "number" && custom.exitCode !== 0}
      />
    )
  }
  return (
    <div className="message-text">
      {textContent(custom.content) || String(custom.summary ?? "系统消息")}
    </div>
  )
}

function ConversationPanel({
  projectId,
  challengeId,
  run,
  target,
  onChanged,
}: {
  projectId: string
  challengeId: string
  run: DashboardRun
  target: ConversationTarget
  onChanged(): Promise<void>
}): React.ReactElement {
  const [conversation, setConversation] =
    useState<DashboardConversation | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [message, setMessage] = useState("")
  const [sending, setSending] = useState(false)
  const hasConversation =
    target.type === "solver"
      ? run.hasConversation
      : target.subagent.hasConversation

  const conversationUrl =
    target.type === "solver"
      ? projectApi(
          projectId,
          `/api/runs/${encodeURIComponent(run.id)}/conversation`,
        )
      : projectApi(
          projectId,
          `/api/runs/${encodeURIComponent(run.id)}/subagents/${encodeURIComponent(target.subagent.id)}/conversation`,
        )

  useEffect(() => {
    setConversation(null)
    setError("")
    if (!hasConversation) return
    setLoading(true)
    void apiRequest<DashboardConversation>(conversationUrl)
      .then(setConversation)
      .catch((cause) => setError(errorMessage(cause)))
      .finally(() => setLoading(false))
  }, [conversationUrl, hasConversation])

  async function send(event: FormEvent): Promise<void> {
    event.preventDefault()
    const text = message.trim()
    if (!text) return
    setSending(true)
    setError("")
    try {
      if (target.type === "solver") {
        await apiMutation(
          projectApi(
            projectId,
            `/api/challenges/${encodeURIComponent(challengeId)}/message`,
          ),
          "POST",
          { message: text },
        )
      } else {
        await apiMutation(
          projectApi(
            projectId,
            `/api/runs/${encodeURIComponent(run.id)}/subagents/${encodeURIComponent(target.subagent.id)}/steer`,
          ),
          "POST",
          { message: text },
        )
      }
      setMessage("")
      await onChanged()
      if (hasConversation) {
        setConversation(
          await apiRequest<DashboardConversation>(conversationUrl),
        )
      }
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setSending(false)
    }
  }

  const messages = conversation?.messages ?? []
  return (
    <div className="conversation-panel">
      <div className="conversation-toolbar">
        <div>
          <span className="conversation-avatar">
            <Icon
              icon={target.type === "solver" ? "lucide:bot" : "lucide:network"}
              width="17"
            />
          </span>
          <div>
            <strong>
              {target.type === "solver"
                ? "Solver Agent"
                : target.subagent.displayName}
            </strong>
            <small>
              {target.type === "solver"
                ? `Attempt ${run.attempt}`
                : target.subagent.role}
            </small>
          </div>
        </div>
        {hasConversation ? (
          <Button variant="ghost" size="sm" asChild>
            <a
              href={
                target.type === "solver"
                  ? projectApi(
                      projectId,
                      `/api/runs/${encodeURIComponent(run.id)}/export`,
                    )
                  : projectApi(
                      projectId,
                      `/api/runs/${encodeURIComponent(run.id)}/subagents/${encodeURIComponent(target.subagent.id)}/export`,
                    )
              }
              target="_blank"
              rel="noreferrer"
            >
              <Icon icon="lucide:file-code-2" width="15" /> 查看 HTML
            </a>
          </Button>
        ) : null}
      </div>
      <div className="conversation-scroll">
        {loading ? <Spinner label="读取 Pi 会话" /> : null}
        {error ? <ErrorNotice message={error} /> : null}
        {!loading && !hasConversation ? (
          <EmptyState
            icon="lucide:message-circle-dashed"
            title="尚无 Agent 对话"
            description="该 attempt 还没有生成可查看的 Assistant 消息。"
          />
        ) : null}
        {messages.map(({ entryId, message: item, timestamp }) => (
          <article key={entryId} className={`chat-message role-${item.role}`}>
            <div className="message-meta">
              <span>
                {item.role === "assistant"
                  ? "AGENT"
                  : item.role === "user"
                    ? "YOU / SYSTEM"
                    : "TOOL"}
              </span>
              <time>{absoluteTime(timestamp)}</time>
            </div>
            <MessageBody message={item} />
          </article>
        ))}
      </div>
      <form className="composer" onSubmit={(event) => void send(event)}>
        <textarea
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          placeholder={
            target.type === "solver"
              ? "向当前 Solver 发送补充指令…"
              : "Steer 这个 SubAgent；完成的会话会从持久化状态恢复…"
          }
          rows={2}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault()
              event.currentTarget.form?.requestSubmit()
            }
          }}
        />
        <Button
          type="submit"
          size="icon"
          disabled={sending || !message.trim()}
          aria-label="发送消息"
        >
          <Icon
            icon={sending ? "lucide:loader-circle" : "lucide:arrow-up"}
            className={sending ? "spin" : ""}
            width="18"
          />
        </Button>
      </form>
    </div>
  )
}

function AttemptHistory({
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
    <div className="attempt-list">
      {error ? <ErrorNotice message={error} /> : null}
      {runs.map((run) => (
        <Card className="attempt-card" key={run.id}>
          <div className="attempt-heading">
            <div>
              <span className="attempt-number">#{run.attempt}</span>
              <div>
                <strong>{run.id}</strong>
                <small>{absoluteTime(run.createdAt)}</small>
              </div>
            </div>
            <Badge tone={toneForStatus(run.status)}>
              {STATUS_LABELS[run.status] ?? run.status}
            </Badge>
          </div>
          <div className="attempt-metrics">
            <span>
              {run.events.length}
              <small>事件</small>
            </span>
            <span>
              {run.subagents.length}
              <small>SubAgents</small>
            </span>
            <span>
              {run.cache.inputTokens}
              <small>输入 tokens</small>
            </span>
            <span>
              {run.cache.cacheRate === null
                ? "—"
                : `${Math.round(run.cache.cacheRate * 100)}%`}
              <small>缓存命中</small>
            </span>
          </div>
          <Collapsible className="attempt-events">
            <CollapsibleTrigger>
              查看运行事件 <Icon icon="lucide:chevron-down" width="14" />
            </CollapsibleTrigger>
            <CollapsibleContent>
              {run.events.map((event) => (
                <div className="event-row" key={event.id}>
                  <time>{absoluteTime(event.createdAt)}</time>
                  <strong>{EVENT_LABELS[event.type] ?? event.type}</strong>
                </div>
              ))}
            </CollapsibleContent>
          </Collapsible>
          <div className="retry-row">
            <input
              value={prompts[run.id] ?? ""}
              onChange={(event) =>
                setPrompts((current) => ({
                  ...current,
                  [run.id]: event.target.value,
                }))
              }
              placeholder="留空使用默认继续提示词，或输入自定义提示词"
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
                className={busyRun === run.id ? "spin" : ""}
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

export function ChallengePage(): React.ReactElement {
  const { projectId = "", challengeId = "" } = useParams()
  const [details, setDetails] = useState<ChallengeDetails | null>(null)
  const [selectedRunId, setSelectedRunId] = useState("")
  const [selectedSubagentId, setSelectedSubagentId] = useState<string | null>(
    null,
  )
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    const next = await apiRequest<ChallengeDetails>(
      projectApi(
        projectId,
        `/api/challenges/${encodeURIComponent(challengeId)}`,
      ),
    )
    setDetails(next)
    setSelectedRunId((current) =>
      next.runs.some((run) => run.id === current)
        ? current
        : (next.runs[0]?.id ?? ""),
    )
  }, [challengeId, projectId])

  useEffect(() => {
    setDetails(null)
    setError("")
    void load().catch((cause) => setError(errorMessage(cause)))
    const source = new EventSource(projectApi(projectId, "/api/events"))
    source.addEventListener("snapshot", () => void load())
    return () => source.close()
  }, [load, projectId])

  const selectedRun = useMemo(
    () =>
      details?.runs.find((run) => run.id === selectedRunId) ?? details?.runs[0],
    [details, selectedRunId],
  )
  const selectedSubagent = selectedRun?.subagents.find(
    (subagent) => subagent.id === selectedSubagentId,
  )
  const target: ConversationTarget = selectedSubagent
    ? { type: "subagent", subagent: selectedSubagent }
    : { type: "solver" }

  async function challengeAction(action: "dispatch" | "cancel"): Promise<void> {
    setBusy(true)
    setError("")
    try {
      await apiMutation(
        projectApi(
          projectId,
          `/api/challenges/${encodeURIComponent(challengeId)}/${action}`,
        ),
        "POST",
        action === "dispatch" && details?.challenge.status === "blocked"
          ? { force: true }
          : {},
      )
      await load()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  if (!details) {
    return error ? (
      <div className="page">
        <ErrorNotice message={error} />
      </div>
    ) : (
      <Spinner label="正在读取题目工作区" />
    )
  }

  const challenge = details.challenge
  const active = [
    "preparing",
    "running",
    "blocking",
    "writing_writeup",
  ].includes(challenge.status)
  return (
    <div className="page challenge-page">
      <PageHeader
        eyebrow={`${challenge.category} · ${challenge.score} PTS`}
        title={challenge.title}
        description={challenge.progress}
        actions={
          <>
            <Badge tone={toneForStatus(challenge.status)}>
              {STATUS_LABELS[challenge.status] ?? challenge.status}
            </Badge>
            <Button
              variant={active ? "danger" : "primary"}
              disabled={busy}
              onClick={() =>
                void challengeAction(active ? "cancel" : "dispatch")
              }
            >
              <Icon
                icon={active ? "lucide:square" : "lucide:play"}
                width="16"
              />
              {active
                ? "终止当前运行"
                : challenge.status === "blocked"
                  ? "强制重新派发"
                  : "派发 Solver"}
            </Button>
          </>
        }
      />
      {error ? <ErrorNotice message={error} /> : null}
      <div className="challenge-workspace">
        <Card className="challenge-main">
          <Tabs defaultValue="conversation">
            <div className="challenge-tabbar">
              <TabsList>
                <TabsTrigger value="conversation">对话</TabsTrigger>
                <TabsTrigger value="intelligence">情报</TabsTrigger>
                <TabsTrigger value="attempts">Attempts</TabsTrigger>
                <TabsTrigger value="writeup">Writeup</TabsTrigger>
              </TabsList>
              {selectedRun ? (
                <select
                  className="attempt-select"
                  value={selectedRun.id}
                  onChange={(event) => {
                    setSelectedRunId(event.target.value)
                    setSelectedSubagentId(null)
                  }}
                >
                  {details.runs.map((run) => (
                    <option value={run.id} key={run.id}>
                      Attempt {run.attempt} ·{" "}
                      {STATUS_LABELS[run.status] ?? run.status}
                    </option>
                  ))}
                </select>
              ) : null}
            </div>
            <TabsContent value="conversation">
              {selectedRun ? (
                <ConversationPanel
                  projectId={projectId}
                  challengeId={challengeId}
                  run={selectedRun}
                  target={target}
                  onChanged={load}
                />
              ) : (
                <EmptyState
                  icon="lucide:bot"
                  title="尚无 Attempt"
                  description="派发 Solver 后，对话会在这里实时出现。"
                />
              )}
            </TabsContent>
            <TabsContent value="intelligence" className="intelligence-tab">
              <div className="intelligence-grid">
                <section>
                  <div className="section-heading">
                    <Icon icon="lucide:check-check" width="17" />
                    <h3>已确认事实</h3>
                    <Badge>{details.blackboard.evidence.length}</Badge>
                  </div>
                  {details.blackboard.evidence.length ? (
                    details.blackboard.evidence.map((item) => (
                      <article key={item.id}>
                        <span>E-{item.id}</span>
                        <p>{item.description}</p>
                      </article>
                    ))
                  ) : (
                    <p className="inline-empty">黑板暂无证据。</p>
                  )}
                </section>
                <section>
                  <div className="section-heading">
                    <Icon icon="lucide:lightbulb" width="17" />
                    <h3>待验证机会</h3>
                    <Badge>{details.blackboard.opportunities.length}</Badge>
                  </div>
                  {details.blackboard.opportunities.length ? (
                    details.blackboard.opportunities.map((item) => (
                      <article key={item.id}>
                        <span>O-{item.id}</span>
                        <p>{item.description}</p>
                        <Badge
                          tone={item.status === "open" ? "warning" : "neutral"}
                        >
                          {item.status}
                        </Badge>
                      </article>
                    ))
                  ) : (
                    <p className="inline-empty">黑板暂无机会项。</p>
                  )}
                </section>
              </div>
            </TabsContent>
            <TabsContent value="attempts" className="attempts-tab">
              <AttemptHistory
                projectId={projectId}
                runs={details.runs}
                onChanged={load}
              />
            </TabsContent>
            <TabsContent value="writeup" className="writeup-tab">
              {details.writeup.content ? (
                <pre className="writeup-content">{details.writeup.content}</pre>
              ) : (
                <EmptyState
                  icon="lucide:file-pen-line"
                  title="Writeup 尚未生成"
                  description={
                    details.writeup.validation.errors.join("；") ||
                    "Solver 解出题目后会生成结构化 Writeup。"
                  }
                />
              )}
            </TabsContent>
          </Tabs>
        </Card>
        <aside className="challenge-aside">
          <Card className="metadata-card">
            <Collapsible defaultOpen>
              <CollapsibleTrigger className="aside-heading">
                <span>
                  <Icon icon="lucide:scan-search" width="16" />
                  题目状态
                </span>
                <Icon icon="lucide:chevron-down" width="15" />
              </CollapsibleTrigger>
              <CollapsibleContent className="metadata-list">
                <div>
                  <span>Challenge ID</span>
                  <strong>{challenge.id}</strong>
                </div>
                <div>
                  <span>尝试次数</span>
                  <strong>{challenge.attempts}</strong>
                </div>
                <div>
                  <span>异常中断</span>
                  <strong>{challenge.sessionInterruptions}</strong>
                </div>
                <div>
                  <span>平台判定</span>
                  <strong>
                    {challenge.platformSolved ? "Solved" : "Unsolved"}
                  </strong>
                </div>
                <div>
                  <span>环境</span>
                  <strong>
                    {details.environment?.status ??
                      (challenge.needsEnv ? "未启动" : "不需要")}
                  </strong>
                </div>
              </CollapsibleContent>
            </Collapsible>
          </Card>
          <Card className="subagent-card">
            <div className="aside-heading">
              <span>
                <Icon icon="lucide:network" width="16" />
                协作 Agents
              </span>
              <Badge>{selectedRun?.subagents.length ?? 0}</Badge>
            </div>
            <button
              type="button"
              className={
                selectedSubagentId === null
                  ? "agent-list-item is-active"
                  : "agent-list-item"
              }
              onClick={() => setSelectedSubagentId(null)}
            >
              <span className="agent-icon">
                <Icon icon="lucide:bot" width="16" />
              </span>
              <span>
                <strong>Solver Agent</strong>
                <small>
                  {selectedRun ? `Attempt ${selectedRun.attempt}` : "未运行"}
                </small>
              </span>
              {selectedRun ? (
                <Badge tone={toneForStatus(selectedRun.status)}>
                  {STATUS_LABELS[selectedRun.status] ?? selectedRun.status}
                </Badge>
              ) : null}
            </button>
            {selectedRun?.subagents.map((subagent) => (
              <button
                type="button"
                key={subagent.id}
                className={
                  selectedSubagentId === subagent.id
                    ? "agent-list-item is-active"
                    : "agent-list-item"
                }
                onClick={() => setSelectedSubagentId(subagent.id)}
              >
                <span className="agent-icon">
                  <Icon icon="lucide:waypoints" width="16" />
                </span>
                <span>
                  <strong>{subagent.displayName}</strong>
                  <small>
                    {subagent.activeTool
                      ? `正在使用 ${TOOL_LABELS[subagent.activeTool] ?? subagent.activeTool}`
                      : `${subagent.turns} turns · ${subagent.totalTokens} tokens`}
                  </small>
                </span>
                <Badge tone={toneForStatus(subagent.status)}>
                  {STATUS_LABELS[subagent.status] ?? subagent.status}
                </Badge>
              </button>
            ))}
          </Card>
        </aside>
      </div>
    </div>
  )
}
