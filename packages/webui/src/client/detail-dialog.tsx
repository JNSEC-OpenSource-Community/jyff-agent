import type { RunEvent, SubagentRecord } from "@ctf-agent/core"
import { useEffect, useMemo, useRef, useState } from "react"
import type {
  AgentCacheStats,
  ChallengeDetails,
  DashboardChallenge,
  DashboardRun,
} from "../types.ts"
import {
  absoluteTime,
  controlPost,
  EVENT_LABELS,
  errorMessage,
  objectData,
  relativeTime,
  SOURCE_LABELS,
  STATUS_LABELS,
  shortId,
  TOOL_LABELS,
} from "./lib.ts"

interface DetailDialogProps {
  details: ChallengeDetails | null
  loading: boolean
  operationPending: boolean
  supportedThinkingLevels: string[]
  schedulerAvailable: boolean
  maxAttempts: number
  onClose: () => void
  onRefresh: () => Promise<void>
  onChallengeAction: (challenge: DashboardChallenge) => Promise<void>
  toast: (message: string, error?: boolean) => void
}

export function DetailDialog(props: DetailDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [intervention, setIntervention] = useState("")
  const [subagentMessages, setSubagentMessages] = useState<
    Record<string, string>
  >({})

  useEffect(() => {
    const node = dialog.current
    if (node && !node.open) node.showModal()
  }, [])

  const challenge = props.details?.challenge
  const active = challenge
    ? ["running", "preparing"].includes(challenge.status)
    : false

  async function sendIntervention() {
    const text = intervention.trim()
    if (!challenge || !text || !active || props.operationPending) return
    try {
      await controlPost(
        `/api/challenges/${encodeURIComponent(challenge.id)}/message`,
        {
          text,
        },
      )
      setIntervention("")
      props.toast("已发送，将在下一轮推理时注入")
      await props.onRefresh()
    } catch (error) {
      props.toast(errorMessage(error), true)
    }
  }

  async function refreshTldr() {
    if (!challenge || props.operationPending) return
    try {
      await controlPost(
        `/api/challenges/${encodeURIComponent(challenge.id)}/tldr/refresh`,
      )
      props.toast("TLDR 已更新")
      await props.onRefresh()
    } catch (error) {
      props.toast(`TLDR 更新失败：${errorMessage(error)}`, true)
    }
  }

  async function setThinkingLevel(level: string) {
    if (!challenge || !level) return
    try {
      await controlPost(
        `/api/challenges/${encodeURIComponent(challenge.id)}/thinking-level`,
        { level },
      )
      props.toast(`思考强度已切换为 ${level}，下一轮推理生效`)
      await props.onRefresh()
    } catch (error) {
      props.toast(`切换思考强度失败：${errorMessage(error)}`, true)
    }
  }

  async function steer(runId: string, subagent: SubagentRecord) {
    const message = subagentMessages[subagent.id]?.trim()
    if (!message) return
    try {
      await controlPost(
        `/api/runs/${encodeURIComponent(runId)}/subagents/${encodeURIComponent(subagent.id)}/steer`,
        { message },
      )
      setSubagentMessages((current) => ({ ...current, [subagent.id]: "" }))
      props.toast(`已向 ${subagent.displayName} 发送引导`)
      await props.onRefresh()
    } catch (error) {
      props.toast(errorMessage(error), true)
    }
  }

  async function cancel(runId: string, subagent: SubagentRecord) {
    try {
      await controlPost(
        `/api/runs/${encodeURIComponent(runId)}/subagents/${encodeURIComponent(subagent.id)}/cancel`,
      )
      props.toast(`已取消 ${subagent.displayName}`)
      await props.onRefresh()
    } catch (error) {
      props.toast(errorMessage(error), true)
    }
  }

  return (
    <dialog
      className="detail-dialog"
      ref={dialog}
      aria-labelledby="detail-title"
      onCancel={(event) => {
        event.preventDefault()
        props.onClose()
      }}
      onClick={(event) => {
        if (event.target === dialog.current) props.onClose()
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") props.onClose()
      }}
    >
      <div className="detail-shell">
        <header className="detail-header">
          <div>
            <p className="section-index">
              {challenge
                ? `${challenge.category.toUpperCase()} / ${challenge.id}`
                : "CHALLENGE DETAIL"}
            </p>
            <h2 id="detail-title">{challenge?.title ?? "正在读取…"}</h2>
          </div>
          <div className="detail-header-actions">
            {challenge && props.schedulerAvailable ? (
              <button
                className={`control-button detail-action${active ? " is-pause" : ""}`}
                type="button"
                disabled={props.operationPending}
                onClick={() => void props.onChallengeAction(challenge)}
              >
                {active || challenge.status === "queued"
                  ? "取消任务"
                  : challenge.status === "solved"
                    ? "重新验证"
                    : challenge.schedulerAttempts >= props.maxAttempts
                      ? "强制重试"
                      : challenge.schedulerAttempts > 0
                        ? "重试"
                        : "立即调度"}
              </button>
            ) : null}
            {active && props.supportedThinkingLevels.length > 0 ? (
              <label className="thinking-level-control">
                <span>思考强度</span>
                <select
                  defaultValue=""
                  disabled={props.operationPending}
                  onChange={(event) => {
                    void setThinkingLevel(event.target.value)
                    event.target.value = ""
                  }}
                >
                  <option value="">—</option>
                  {props.supportedThinkingLevels
                    .filter((level) => level !== "off")
                    .map((level) => (
                      <option key={level} value={level}>
                        {level}
                      </option>
                    ))}
                </select>
              </label>
            ) : null}
            {challenge && props.details && props.details.runs.length > 0 ? (
              <a
                className="control-button export-link"
                href={`/api/challenges/${encodeURIComponent(challenge.id)}/export`}
              >
                查看 HTML
              </a>
            ) : null}
            <button
              className="icon-button"
              type="button"
              onClick={props.onClose}
            >
              <span aria-hidden="true">×</span>
              <span className="sr-only">关闭题目详情</span>
            </button>
          </div>
        </header>
        <div className="detail-content">
          {props.loading || !props.details ? (
            <div className="detail-loading">
              <span></span>
              <span></span>
              <span></span>
              <p>正在读取运行记录…</p>
            </div>
          ) : (
            <DetailContent
              details={props.details}
              messages={subagentMessages}
              onMessage={(id, value) =>
                setSubagentMessages((current) => ({ ...current, [id]: value }))
              }
              onSteer={steer}
              onCancel={cancel}
              onRefreshTldr={refreshTldr}
              tldrPending={props.operationPending}
            />
          )}
        </div>
        <footer className="intervention-bar">
          <div className="intervention-row">
            <input
              type="text"
              maxLength={4_000}
              autoComplete="off"
              value={intervention}
              onChange={(event) => setIntervention(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void sendIntervention()
              }}
              placeholder="向运行中的 Agent 发送人工指令…"
              disabled={!active || props.operationPending}
            />
            <button
              className="control-button intervention-send"
              type="button"
              disabled={
                !active || !intervention.trim() || props.operationPending
              }
              onClick={() => void sendIntervention()}
            >
              发送
            </button>
          </div>
          <span className="intervention-hint">
            {active
              ? "消息将发送给该题当前运行的 Agent，并在下一轮推理时注入"
              : "该题当前没有运行中的 Agent，消息暂不可用"}
          </span>
        </footer>
      </div>
    </dialog>
  )
}

function DetailContent(props: {
  details: ChallengeDetails
  messages: Record<string, string>
  onMessage: (id: string, value: string) => void
  onSteer: (runId: string, subagent: SubagentRecord) => Promise<void>
  onCancel: (runId: string, subagent: SubagentRecord) => Promise<void>
  onRefreshTldr: () => Promise<void>
  tldrPending: boolean
}) {
  const { challenge, runs, blackboard, environment, writeup, tldr } =
    props.details
  const submission = acceptedSubmission(runs)
  return (
    <>
      {submission ? (
        <div className="accepted-submission">
          <span>PLATFORM CONFIRMED FLAG</span>
          <code>{submission}</code>
        </div>
      ) : null}
      <div className="detail-overview">
        <Metric
          label="状态"
          value={STATUS_LABELS[challenge.status] ?? challenge.status}
        />
        <Metric label="分值" value={`${challenge.score} PT`} />
        <Metric label="环境" value={challenge.needsEnv ? "需申请" : "无需"} />
        <Metric label="尝试" value={String(challenge.attempts)} />
        <Metric
          label="证据 / 机会"
          value={`${challenge.evidence} / ${challenge.openOpportunities}`}
        />
      </div>
      <DetailSection title="当前进度">
        <div className="current-progress">
          <strong>{challenge.progress}</strong>
          <span>
            {challenge.lastActivityAt
              ? `最近活动 ${relativeTime(challenge.lastActivityAt)}`
              : "等待首次调度"}
            {challenge.queuePosition
              ? ` · 队列位置 #${challenge.queuePosition}`
              : ""}
          </span>
        </div>
      </DetailSection>
      {environment ? (
        <DetailSection title="远程环境" count={environment.status}>
          <div className="environment-card">
            <strong>{environment.id}</strong>
            <span>{environment.status}</span>
            <code>{environment.endpoint || "端点尚未就绪"}</code>
          </div>
        </DetailSection>
      ) : null}
      <DetailSection title="运行时间线" count={`${runs.length} 次尝试`}>
        {runs.length === 0 ? (
          <div className="detail-empty">此题尚未分配 Agent。</div>
        ) : (
          runs.map((run, index) => (
            <RunCard
              key={run.id}
              run={run}
              initiallyOpen={index === 0}
              messages={props.messages}
              onMessage={props.onMessage}
              onSteer={props.onSteer}
              onCancel={props.onCancel}
            />
          ))
        )}
      </DetailSection>
      <DetailSection
        title="TLDR"
        count={tldr ? relativeTime(tldr.updatedAt) : "未生成"}
      >
        <div className="writeup-actions">
          <button
            className="outline-button"
            type="button"
            disabled={props.tldrPending}
            onClick={() => void props.onRefreshTldr()}
          >
            {tldr ? "更新 TLDR" : "生成 TLDR"}
          </button>
          {tldr ? (
            <span
              title={`input ${tldr.inputTokens.toLocaleString()} · cache read ${tldr.cacheReadTokens.toLocaleString()} · cache write ${tldr.cacheWriteTokens.toLocaleString()}`}
            >
              {tldr.model} · CACHE{" "}
              {formatCacheRate({
                inputTokens: tldr.inputTokens,
                cacheReadTokens: tldr.cacheReadTokens,
                cacheWriteTokens: tldr.cacheWriteTokens,
                cacheRate: cacheRate(tldr.inputTokens, tldr.cacheReadTokens),
              })}
            </span>
          ) : null}
        </div>
        {tldr?.content ? (
          <pre className="tldr-preview">{tldr.content}</pre>
        ) : (
          <div className="detail-empty">
            {tldr?.error ?? "尚未生成题目摘要。"}
          </div>
        )}
      </DetailSection>
      <DetailSection
        title="Writeup"
        count={writeup.validation.valid ? "已校验" : "未完成"}
      >
        {writeup.validation.valid && writeup.content ? (
          <>
            <div className="writeup-actions">
              <a
                className="control-button export-link"
                href={`/api/challenges/${encodeURIComponent(challenge.id)}/writeup`}
                download
              >
                下载 Markdown
              </a>
              <span>{writeup.validation.size.toLocaleString()} bytes</span>
            </div>
            <pre className="writeup-preview">
              {writeup.content.slice(0, 24_000)}
            </pre>
          </>
        ) : (
          <div className="detail-empty">
            {writeup.validation.errors.join("；") || "Writeup 尚未生成。"}
          </div>
        )}
      </DetailSection>
      <DetailSection
        title="协作黑板"
        count={`${blackboard.evidence.length} 条证据 · ${blackboard.opportunities.length} 个机会`}
      >
        {blackboard.evidence.length === 0 &&
        blackboard.opportunities.length === 0 ? (
          <div className="detail-empty">
            Agent 尚未记录可复用的证据或解题机会。
          </div>
        ) : (
          <div className="blackboard-grid">
            {blackboard.evidence.map((record) => (
              <article className="knowledge-card" key={`e-${record.id}`}>
                <small>Evidence #{record.id}</small>
                <p>{record.description}</p>
              </article>
            ))}
            {blackboard.opportunities.map((record) => (
              <article
                className={`knowledge-card ${record.status === "open" ? "is-open" : "is-concluded"}`}
                key={`o-${record.id}`}
              >
                <small>
                  {record.status === "open" ? "Open" : "Concluded"} opportunity
                  #{record.id}
                </small>
                <p>{record.description}</p>
              </article>
            ))}
          </div>
        )}
      </DetailSection>
    </>
  )
}

function RunCard(props: {
  run: DashboardRun
  initiallyOpen: boolean
  messages: Record<string, string>
  onMessage: (id: string, value: string) => void
  onSteer: (runId: string, subagent: SubagentRecord) => Promise<void>
  onCancel: (runId: string, subagent: SubagentRecord) => Promise<void>
}) {
  const run = props.run
  const [open, setOpen] = useState(props.initiallyOpen)
  return (
    <details
      className="run-card"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span className="run-card-title">
          <strong>ATTEMPT {String(run.attempt).padStart(2, "0")}</strong>
          <span>
            {SOURCE_LABELS[run.source] ?? run.source} · {shortId(run.id)} ·{" "}
            {absoluteTime(run.createdAt)}
          </span>
        </span>
        <span
          className="run-cache-rate"
          title={`input ${run.cache.inputTokens.toLocaleString()} · cache read ${run.cache.cacheReadTokens.toLocaleString()} · cache write ${run.cache.cacheWriteTokens.toLocaleString()}`}
        >
          CACHE {formatCacheRate(run.cache)}
        </span>
        <span className={`status-chip status-${run.status}`}>
          {STATUS_LABELS[run.status] ?? run.status}
        </span>
        <a
          className="run-export-link"
          href={`/api/challenges/${encodeURIComponent(run.challengeId)}/export?run=${encodeURIComponent(run.id)}`}
          onClick={(event) => event.stopPropagation()}
        >
          查看 HTML
        </a>
      </summary>
      {run.subagents.length > 0 ? (
        <SubagentFleet
          run={run}
          messages={props.messages}
          onMessage={props.onMessage}
          onSteer={props.onSteer}
          onCancel={props.onCancel}
        />
      ) : null}
      <Timeline events={run.events} />
      {run.error || run.cleanupError ? (
        <pre className="run-errors">
          {[
            run.error ? `运行错误：${run.error}` : "",
            run.cleanupError ? `清理错误：${run.cleanupError}` : "",
          ]
            .filter(Boolean)
            .join("\n")}
        </pre>
      ) : null}
    </details>
  )
}

function SubagentFleet(props: {
  run: DashboardRun
  messages: Record<string, string>
  onMessage: (id: string, value: string) => void
  onSteer: (runId: string, subagent: SubagentRecord) => Promise<void>
  onCancel: (runId: string, subagent: SubagentRecord) => Promise<void>
}) {
  return (
    <section className="subagent-fleet">
      <div className="subagent-fleet-heading">
        <div>
          <span className="strip-label">SUBAGENT FLEET</span>
          <strong>{props.run.subagents.length} 个 worker</strong>
        </div>
        <span>
          {
            props.run.subagents.filter((agent) => agent.status === "running")
              .length
          }{" "}
          active
        </span>
      </div>
      <div className="subagent-grid">
        {props.run.subagents.map((agent) => {
          const running = agent.status === "running"
          return (
            <article
              className={`subagent-card status-${agent.status}`}
              key={agent.id}
            >
              <header>
                <div className="subagent-identity">
                  <span className="subagent-role">{agent.role}</span>
                  <strong>{agent.displayName}</strong>
                  <small>{shortId(agent.id)}</small>
                </div>
                <span className={`status-chip status-${agent.status}`}>
                  {STATUS_LABELS[agent.status] ?? agent.status}
                </span>
              </header>
              <p>{agent.description}</p>
              <div className="subagent-metrics">
                <span>
                  <small>TURN</small>
                  <strong>{agent.turns}</strong>
                </span>
                <span>
                  <small>TOOLS</small>
                  <strong>{agent.toolUses}</strong>
                </span>
                <span>
                  <small>TOKENS</small>
                  <strong>{agent.totalTokens.toLocaleString()}</strong>
                </span>
                <span
                  title={`input ${(agent.inputTokens ?? 0).toLocaleString()} · cache read ${(agent.cacheReadTokens ?? 0).toLocaleString()} · cache write ${(agent.cacheWriteTokens ?? 0).toLocaleString()}`}
                >
                  <small>CACHE</small>
                  <strong>
                    {formatCacheRate({
                      inputTokens: agent.inputTokens ?? 0,
                      cacheReadTokens: agent.cacheReadTokens ?? 0,
                      cacheWriteTokens: agent.cacheWriteTokens ?? 0,
                      cacheRate: cacheRate(
                        agent.inputTokens ?? 0,
                        agent.cacheReadTokens ?? 0,
                      ),
                    })}
                  </strong>
                </span>
              </div>
              {agent.activeTool ? (
                <div className="subagent-activity">
                  <i></i> {TOOL_LABELS[agent.activeTool] ?? agent.activeTool}
                </div>
              ) : null}
              {agent.result ? (
                <pre className="subagent-output">{agent.result}</pre>
              ) : null}
              {agent.error ? (
                <pre className="subagent-output is-error">{agent.error}</pre>
              ) : null}
              {running ? (
                <div className="subagent-controls">
                  <input
                    value={props.messages[agent.id] ?? ""}
                    maxLength={4_000}
                    placeholder="发送新的调查方向…"
                    onChange={(event) =>
                      props.onMessage(agent.id, event.target.value)
                    }
                  />
                  <button
                    className="outline-button"
                    type="button"
                    disabled={!(props.messages[agent.id] ?? "").trim()}
                    onClick={() => void props.onSteer(props.run.id, agent)}
                  >
                    STEER
                  </button>
                  <button
                    className="row-action is-cancel"
                    type="button"
                    onClick={() => void props.onCancel(props.run.id, agent)}
                  >
                    取消
                  </button>
                </div>
              ) : null}
            </article>
          )
        })}
      </div>
    </section>
  )
}

function Timeline({ events }: { events: RunEvent[] }) {
  const grouped = useMemo(() => groupThinking(events), [events])
  if (grouped.length === 0)
    return (
      <div className="timeline">
        <div className="detail-empty">没有持久化事件。</div>
      </div>
    )
  return (
    <div className="timeline">
      {grouped.map((event) =>
        event.kind === "thinking" ? (
          <div
            className="timeline-item is-thinking"
            key={`thinking-${event.id}`}
          >
            <strong>💭 思考</strong>
            <time dateTime={event.at}>{absoluteTime(event.at)}</time>
            <details className="thinking-details">
              <summary>思考过程</summary>
              <p className="thinking-text">{event.text}</p>
            </details>
          </div>
        ) : (
          <EventItem event={event.event} key={event.event.id} />
        ),
      )}
    </div>
  )
}

function EventItem({ event }: { event: RunEvent }) {
  const data = objectData(event.data)
  const toolName = typeof data.toolName === "string" ? data.toolName : undefined
  let label = EVENT_LABELS[event.type] ?? event.type
  if (event.type.startsWith("tool_") && toolName) {
    label = `${label} · ${TOOL_LABELS[toolName] ?? toolName}`
  }
  const classes = ["timeline-item"]
  if (event.type.startsWith("tool_")) classes.push("is-tool")
  if (event.type === "human_message") classes.push("is-human")
  if (event.type === "agent_message") classes.push("is-agent")
  if (event.type === "run_interrupted" || data.isError === true)
    classes.push("is-error")
  if (
    event.type === "flag_submitted" &&
    ["accepted", "already_solved"].includes(String(data.status))
  )
    classes.push("is-success")
  const detail = eventDetail(event.type, data)
  if (detail && event.type.startsWith("tool_")) {
    return (
      <div className={classes.join(" ")}>
        <details className="trace-details">
          <summary>
            <strong>{label}</strong>
            <span className="trace-chevron" aria-hidden="true">
              ⌄
            </span>
            <time dateTime={event.createdAt}>
              {absoluteTime(event.createdAt)}
            </time>
          </summary>
          <pre className="trace-output">{detail}</pre>
        </details>
      </div>
    )
  }
  return (
    <div className={classes.join(" ")}>
      <strong>{label}</strong>
      <time dateTime={event.createdAt}>{absoluteTime(event.createdAt)}</time>
      {detail ? (
        <p className={event.type === "flag_submitted" ? "trace-output" : ""}>
          {detail}
        </p>
      ) : null}
    </div>
  )
}

function eventDetail(type: string, data: Record<string, unknown>): string {
  if (["agent_message", "human_message"].includes(type))
    return String(data.text ?? "").slice(0, 2_000)
  if (type === "tool_started" && data.args) {
    const args = objectData(data.args)
    return data.toolName === "bash" && typeof args.command === "string"
      ? args.command
      : JSON.stringify(data.args, null, 2)
  }
  if (type === "tool_finished" && data.result !== undefined)
    return JSON.stringify(data.result, null, 2)
  if (type === "flag_submitted") {
    return [
      `状态：${data.status ?? "unknown"}`,
      data.flag ? `Flag：${data.flag}` : "",
      data.message ? `平台消息：${data.message}` : "",
    ]
      .filter(Boolean)
      .join("\n")
  }
  if (type.startsWith("subagent_") && data.role) {
    return `${data.displayName ?? data.role} · turn ${data.turns ?? 0} · tools ${data.toolUses ?? 0}`
  }
  return ""
}

type GroupedEvent =
  | { kind: "event"; event: RunEvent }
  | { kind: "thinking"; id: number; text: string; at: string }

function groupThinking(events: RunEvent[]): GroupedEvent[] {
  const result: GroupedEvent[] = []
  let text = ""
  let at = ""
  let id = 0
  const flush = () => {
    if (text) result.push({ kind: "thinking", id, text, at })
    text = ""
    at = ""
    id = 0
  }
  for (const event of events) {
    if (event.type === "agent_thinking") {
      const chunk = objectData(event.data).text
      if (typeof chunk === "string") {
        if (!at) {
          at = event.createdAt
          id = event.id
        }
        text += chunk
      }
    } else {
      flush()
      result.push({ kind: "event", event })
    }
  }
  flush()
  return result
}

function cacheRate(
  inputTokens: number,
  cacheReadTokens: number,
): number | null {
  const eligibleTokens = inputTokens + cacheReadTokens
  return eligibleTokens > 0 ? cacheReadTokens / eligibleTokens : null
}

function formatCacheRate(cache: AgentCacheStats): string {
  if (cache.cacheRate === null) return "—"
  return `${(cache.cacheRate * 100).toFixed(1)}%`
}

function acceptedSubmission(runs: DashboardRun[]): string | undefined {
  for (const run of runs) {
    for (const event of [...run.events].reverse()) {
      if (event.type !== "flag_submitted") continue
      const data = objectData(event.data)
      if (!["accepted", "already_solved"].includes(String(data.status)))
        continue
      if (typeof data.flag === "string" && data.flag !== "[redacted]")
        return data.flag
    }
  }
  return undefined
}

function DetailSection(props: {
  title: string
  count?: string
  children: React.ReactNode
}) {
  return (
    <section className="detail-section">
      <div className="detail-section-heading">
        <h3>{props.title}</h3>
        {props.count ? <span>{props.count}</span> : null}
      </div>
      <div className="detail-section-body">{props.children}</div>
    </section>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="detail-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}
