import type { ControlPlaneSetupSnapshot } from "@ctf-agent/core"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { createRoot } from "react-dom/client"
import type {
  ChallengeDetails,
  DashboardChallenge,
  DashboardSnapshot,
  ModelConfigurationView,
} from "../types.ts"
import { DetailDialog } from "./detail-dialog.tsx"
import {
  controlPost,
  errorMessage,
  getJson,
  matchesStatus,
  relativeTime,
  STATUS_LABELS,
  sortChallenges,
} from "./lib.ts"
import { ModelDialog, PlatformDialog } from "./settings-dialogs.tsx"

type Connection = "connecting" | "online" | "degraded" | "offline"
type Modal = "model" | "platform" | null
interface Toast {
  id: number
  message: string
  error: boolean
}

function App() {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null)
  const [connection, setConnection] = useState<Connection>("connecting")
  const [connectionLabel, setConnectionLabel] = useState("正在连接")
  const [operationPending, setOperationPending] = useState(false)
  const [selectedChallengeId, setSelectedChallengeId] = useState<string | null>(
    () => new URLSearchParams(location.hash.slice(1)).get("challenge"),
  )
  const [details, setDetails] = useState<ChallengeDetails | null>(null)
  const [detailsLoading, setDetailsLoading] = useState(false)
  const [modelSummary, setModelSummary] =
    useState<ModelConfigurationView | null>(null)
  const [platformSummary, setPlatformSummary] =
    useState<ControlPlaneSetupSnapshot | null>(null)
  const [platformAvailable, setPlatformAvailable] = useState(true)
  const [modal, setModal] = useState<Modal>(null)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [clock, setClock] = useState(0)
  const toastId = useRef(0)
  const detailsRequest = useRef(0)
  const lastSyncToast = useRef<{ message: string; at: number } | null>(null)

  const toast = useCallback((message: string, error = false) => {
    const id = ++toastId.current
    setToasts((current) => [...current, { id, message, error }])
    window.setTimeout(
      () => setToasts((current) => current.filter((item) => item.id !== id)),
      3_500,
    )
  }, [])

  const applySnapshot = useCallback((value: DashboardSnapshot) => {
    setSnapshot(value)
    setConnection("online")
    setConnectionLabel("实时连接")
    document.title = `${value.overview.name} · CTF Agent`
  }, [])

  useEffect(() => {
    let live = true
    void getJson<DashboardSnapshot>("/api/snapshot")
      .then((value) => {
        if (live) applySnapshot(value)
      })
      .catch((error) => {
        if (!live) return
        toast(errorMessage(error), true)
      })

    const events = new EventSource("/api/events")
    events.addEventListener("open", () => {
      if (!live) return
      setConnection("online")
      setConnectionLabel("实时连接")
    })
    events.addEventListener("snapshot", (event) => {
      if (!live || !(event instanceof MessageEvent)) return
      try {
        applySnapshot(JSON.parse(event.data) as DashboardSnapshot)
      } catch {
        setConnection("offline")
        setConnectionLabel("数据异常")
      }
    })
    events.addEventListener("dashboard_error", (event) => {
      if (!live) return
      setConnection("degraded")
      setConnectionLabel("平台同步异常")
      if (event instanceof MessageEvent) {
        try {
          const data = JSON.parse(event.data) as { message?: string }
          const message = data.message ?? "实时数据同步失败"
          const previous = lastSyncToast.current
          if (
            !previous ||
            previous.message !== message ||
            Date.now() - previous.at >= 15_000
          ) {
            lastSyncToast.current = { message, at: Date.now() }
            toast(message, true)
          }
        } catch {
          toast("实时数据同步失败", true)
        }
      }
    })
    events.addEventListener("dashboard_recovered", () => {
      if (!live) return
      lastSyncToast.current = null
      setConnection("online")
      setConnectionLabel("实时连接")
    })
    events.addEventListener("dashboard_status", (event) => {
      if (!live || !(event instanceof MessageEvent)) return
      try {
        const status = JSON.parse(event.data) as { status?: string }
        if (status.status === "degraded") {
          setConnection("degraded")
          setConnectionLabel("平台同步异常")
        }
      } catch {
        // The snapshot remains usable even if a status event is malformed.
      }
    })
    events.addEventListener("error", () => {
      if (!live) return
      setConnection("offline")
      setConnectionLabel("正在重连")
    })
    return () => {
      live = false
      events.close()
    }
  }, [applySnapshot, toast])

  useEffect(() => {
    let live = true
    void getJson<ModelConfigurationView>("/api/model-config")
      .then((value) => {
        if (live) setModelSummary(value)
      })
      .catch(() => undefined)
    void getJson<ControlPlaneSetupSnapshot>("/api/control-plane")
      .then((value) => {
        if (live) setPlatformSummary(value)
      })
      .catch(() => {
        if (live) setPlatformAvailable(false)
      })
    return () => {
      live = false
    }
  }, [])

  useEffect(() => {
    const interval = window.setInterval(
      () => setClock((value) => value + 1),
      10_000,
    )
    return () => window.clearInterval(interval)
  }, [])

  const refreshDetails = useCallback(async () => {
    if (!selectedChallengeId) return
    const requestId = ++detailsRequest.current
    setDetailsLoading(true)
    try {
      const value = await getJson<ChallengeDetails>(
        `/api/challenges/${encodeURIComponent(selectedChallengeId)}`,
      )
      if (requestId === detailsRequest.current) setDetails(value)
    } catch (error) {
      toast(`题目详情同步失败：${errorMessage(error)}`, true)
    } finally {
      if (requestId === detailsRequest.current) setDetailsLoading(false)
    }
  }, [selectedChallengeId, toast])

  const selectedChallengeVersion = useMemo(() => {
    const challenge = snapshot?.challenges.find(
      (item) => item.id === selectedChallengeId,
    )
    if (!challenge) return ""
    return JSON.stringify([
      challenge.status,
      challenge.latestRunId,
      challenge.latestRunStatus,
      challenge.lastActivityAt,
      challenge.queuePosition,
      challenge.attempts,
      challenge.evidence,
      challenge.openOpportunities,
      challenge.concludedOpportunities,
    ])
  }, [selectedChallengeId, snapshot])

  useEffect(() => {
    if (!selectedChallengeId || !selectedChallengeVersion) {
      setDetails(null)
      return
    }
    void refreshDetails()
  }, [selectedChallengeId, selectedChallengeVersion, refreshDetails])

  const operate = useCallback(
    async (
      operation: () => Promise<DashboardSnapshot>,
      successMessage: string,
    ) => {
      if (operationPending) return
      setOperationPending(true)
      try {
        applySnapshot(await operation())
        toast(successMessage)
      } catch (error) {
        toast(errorMessage(error), true)
      } finally {
        setOperationPending(false)
      }
    },
    [applySnapshot, operationPending, toast],
  )

  const challengeAction = useCallback(
    async (challenge: DashboardChallenge) => {
      const cancelling = ["queued", "preparing", "running"].includes(
        challenge.status,
      )
      if (cancelling) {
        await operate(
          () =>
            controlPost<DashboardSnapshot>(
              `/api/challenges/${encodeURIComponent(challenge.id)}/cancel`,
            ),
          "已发送取消请求",
        )
        return
      }
      const force =
        challenge.status === "solved" ||
        challenge.status === "blocked" ||
        Boolean(
          snapshot?.scheduler &&
            challenge.schedulerAttempts >= snapshot.scheduler.maxAttempts,
        )
      if (
        force &&
        !window.confirm(
          `确认重新验证 ${challenge.title}？这会产生一次新的模型调用。`,
        )
      )
        return
      await operate(
        () =>
          controlPost<DashboardSnapshot>(
            `/api/challenges/${encodeURIComponent(challenge.id)}/dispatch`,
            { force },
          ),
        force ? "重新验证任务已入队" : "题目已加入调度队列",
      )
    },
    [operate, snapshot?.scheduler],
  )

  function openChallenge(id: string) {
    detailsRequest.current += 1
    setDetails(null)
    setDetailsLoading(true)
    setSelectedChallengeId(id)
    history.replaceState(null, "", `#challenge=${encodeURIComponent(id)}`)
  }

  function closeChallenge() {
    detailsRequest.current += 1
    setSelectedChallengeId(null)
    setDetails(null)
    history.replaceState(null, "", `${location.pathname}${location.search}`)
  }

  async function refreshPlatform() {
    await operate(
      () => controlPost<DashboardSnapshot>("/api/refresh"),
      "平台数据已刷新",
    )
  }

  async function toggleScheduler() {
    const scheduler = snapshot?.scheduler
    if (!scheduler?.available) return
    await operate(
      () =>
        controlPost<DashboardSnapshot>(
          scheduler.autoEnabled
            ? "/api/scheduler/auto/pause"
            : "/api/scheduler/auto/start",
        ),
      scheduler.autoEnabled ? "自主调度已暂停" : "自主调度已开启",
    )
  }

  async function setSchedulerConcurrency(maxConcurrent: number) {
    await operate(
      () =>
        controlPost<DashboardSnapshot>("/api/scheduler/concurrency", {
          maxConcurrent,
        }),
      `调度并发量已设为 ${maxConcurrent}`,
    )
  }

  async function reviewAnnouncement(
    candidate: DashboardSnapshot["announcementCandidates"][number],
    status: "approved" | "rejected",
  ) {
    await operate(
      () =>
        controlPost<DashboardSnapshot>("/api/announcements/review", {
          challengeId: candidate.challengeId,
          announcementKey: candidate.key,
          status,
        }),
      status === "approved"
        ? "公告已批准并发送给对应 Solver"
        : "公告已拒绝，不会进入 Agent 上下文",
    )
  }

  return (
    <>
      <a className="skip-link" href="#challenge-board">
        跳到题目列表
      </a>
      <div className="ambient-grid" aria-hidden="true"></div>
      <Header
        connection={connection}
        connectionLabel={connectionLabel}
        generatedAt={snapshot?.generatedAt ?? null}
        clock={clock}
        modelConfigured={modelSummary?.configured === true}
        platformConfigured={platformSummary?.state.phase === "ready"}
        platformAvailable={platformAvailable}
        operationPending={operationPending}
        onModel={() => setModal("model")}
        onPlatform={() => setModal("platform")}
        onRefresh={() => void refreshPlatform()}
      />
      <main className="shell">
        <Hero snapshot={snapshot} />
        <SchedulerConsole
          snapshot={snapshot}
          pending={operationPending}
          onToggle={() => void toggleScheduler()}
          onConcurrency={setSchedulerConcurrency}
        />
        <Stats snapshot={snapshot} />
        <Operations
          snapshot={snapshot}
          pending={operationPending}
          onReview={(candidate, status) =>
            void reviewAnnouncement(candidate, status)
          }
        />
        <ChallengeBoard
          snapshot={snapshot}
          pending={operationPending}
          onOpen={openChallenge}
          onAction={(challenge) => void challengeAction(challenge)}
        />
      </main>
      {selectedChallengeId ? (
        <DetailDialog
          key={selectedChallengeId}
          details={details}
          loading={detailsLoading && !details}
          operationPending={operationPending}
          supportedThinkingLevels={modelSummary?.supportedThinkingLevels ?? []}
          schedulerAvailable={snapshot?.scheduler?.available === true}
          maxAttempts={snapshot?.scheduler?.maxAttempts ?? 0}
          onClose={closeChallenge}
          onRefresh={refreshDetails}
          onChallengeAction={challengeAction}
          toast={toast}
        />
      ) : null}
      {modal === "model" ? (
        <ModelDialog
          summary={modelSummary}
          onClose={() => setModal(null)}
          toast={toast}
          onSaved={(configuration, value) => {
            setModelSummary(configuration)
            applySnapshot(value)
          }}
        />
      ) : null}
      {modal === "platform" ? (
        <PlatformDialog
          summary={platformSummary}
          onClose={() => setModal(null)}
          toast={toast}
          onApplied={(setup, value) => {
            setPlatformSummary(setup)
            applySnapshot(value)
          }}
        />
      ) : null}
      <div className="toast-region" aria-live="polite">
        {toasts.map((item) => (
          <div
            className={`toast${item.error ? " is-error" : ""}`}
            key={item.id}
          >
            {item.message}
          </div>
        ))}
      </div>
    </>
  )
}

function Header(props: {
  connection: Connection
  connectionLabel: string
  generatedAt: string | null
  clock: number
  modelConfigured: boolean
  platformConfigured: boolean
  platformAvailable: boolean
  operationPending: boolean
  onModel: () => void
  onPlatform: () => void
  onRefresh: () => void
}) {
  void props.clock
  return (
    <header className="topbar">
      <a className="brand" href="/" aria-label="CTF Agent 控制台首页">
        <span className="brand-mark" aria-hidden="true">
          <svg viewBox="0 0 32 32">
            <title>CTF Agent</title>
            <path d="M4 7.5h8.5L16 4l3.5 3.5H28V16l-3.5 3.5V28H16l-3.5-3.5H4V16l3.5-3.5L4 7.5Z"></path>
            <path className="brand-mark-core" d="m11 12 4 4-4 4m6 0h5"></path>
          </svg>
        </span>
        <span>
          <strong>
            CTF<span>/</span>AGENT
          </strong>
          <small>CONTEST CONTROL</small>
        </span>
      </a>
      <div className="topbar-actions">
        <div
          className={`connection is-${props.connection}`}
          role="status"
          aria-live="polite"
        >
          <span className="connection-dot"></span>
          <span>{props.connectionLabel}</span>
        </div>
        <time
          className="last-updated"
          dateTime={props.generatedAt ?? undefined}
        >
          {props.generatedAt
            ? `更新于 ${relativeTime(props.generatedAt)}`
            : "尚未同步"}
        </time>
        {props.platformAvailable ? (
          <button
            className={`icon-button${props.platformConfigured ? " is-configured" : ""}`}
            type="button"
            aria-label="比赛平台设置"
            onClick={props.onPlatform}
          >
            <span aria-hidden="true">◇</span>
          </button>
        ) : null}
        <button
          className={`icon-button${props.modelConfigured ? " is-configured" : ""}`}
          type="button"
          aria-label="模型连接设置"
          onClick={props.onModel}
        >
          <span aria-hidden="true">⌘</span>
        </button>
        <button
          className={`icon-button${props.operationPending ? " is-loading" : ""}`}
          type="button"
          aria-label="立即刷新平台数据"
          disabled={props.operationPending}
          onClick={props.onRefresh}
        >
          <span aria-hidden="true">↻</span>
        </button>
      </div>
    </header>
  )
}

function Hero({ snapshot }: { snapshot: DashboardSnapshot | null }) {
  return (
    <section className="hero" aria-labelledby="contest-name">
      <div>
        <p className="eyebrow">
          <span>LIVE</span> OPERATION OVERVIEW
        </p>
        <h1 id="contest-name">{snapshot?.overview.name ?? "正在载入比赛…"}</h1>
        <p className="hero-copy">
          {snapshot
            ? `${snapshot.overview.id} · ${snapshot.overview.challenges} 道题 · ${snapshot.stats.attempts} 次 Agent 尝试`
            : "连接平台并整理 Agent 运行状态"}
        </p>
      </div>
      <div className="hero-signal" aria-hidden="true">
        <span></span>
        <span></span>
        <span></span>
        <span></span>
        <span></span>
      </div>
    </section>
  )
}

function SchedulerConsole(props: {
  snapshot: DashboardSnapshot | null
  pending: boolean
  onToggle: () => void
  onConcurrency: (maxConcurrent: number) => Promise<void>
}) {
  const scheduler = props.snapshot?.scheduler
  const unavailable = !scheduler?.available
  const [concurrency, setConcurrency] = useState(
    String(scheduler?.maxConcurrent ?? 8),
  )
  const [concurrencyDirty, setConcurrencyDirty] = useState(false)
  useEffect(() => {
    if (!concurrencyDirty && scheduler) {
      setConcurrency(String(scheduler.maxConcurrent))
    }
  }, [concurrencyDirty, scheduler])
  const concurrencyValue = Number(concurrency)
  const concurrencyValid =
    Number.isInteger(concurrencyValue) &&
    concurrencyValue >= 1 &&
    concurrencyValue <= 64
  const warning =
    scheduler?.lastError || (unavailable ? scheduler?.unavailableReason : "")
  return (
    <section
      className={`scheduler-console${scheduler?.autoEnabled ? " is-running" : ""}${unavailable ? " is-unavailable" : ""}`}
      aria-labelledby="scheduler-title"
    >
      <div className="scheduler-identity">
        <span className="scheduler-state-dot" aria-hidden="true"></span>
        <div>
          <span className="strip-label">SCHEDULER</span>
          <strong id="scheduler-title">
            {unavailable
              ? "调度器不可用"
              : scheduler.autoEnabled
                ? "自主调度运行中"
                : "自主调度已暂停"}
          </strong>
          <small>
            {unavailable
              ? (scheduler?.unavailableReason ?? "当前服务仅提供只读监控")
              : scheduler.autoEnabled
                ? "新题与未解题会自动进入 worker 队列"
                : "暂停会清空等待队列；已运行任务不受影响"}
          </small>
        </div>
      </div>
      <div className="scheduler-metrics" role="group" aria-label="调度队列状态">
        <div>
          <span>队列</span>
          <strong>{scheduler?.queued.length ?? "—"}</strong>
        </div>
        <div>
          <span>活跃</span>
          <strong>{scheduler?.active.length ?? "—"}</strong>
        </div>
        <div>
          <span>并发</span>
          <strong>
            {scheduler
              ? `${scheduler.active.length}/${scheduler.maxConcurrent}`
              : "—"}
          </strong>
        </div>
        <div>
          <span>重试 / 中断上限</span>
          <strong>
            {scheduler
              ? `${scheduler.maxAttempts}/${scheduler.maxSessionInterruptions}`
              : "—"}
          </strong>
        </div>
      </div>
      <div className="scheduler-actions">
        <label
          className="scheduler-concurrency"
          title="调整后立即生效；降低并发不会中断正在运行的任务"
        >
          <span>并发量</span>
          <input
            type="number"
            min="1"
            max="64"
            step="1"
            inputMode="numeric"
            aria-label="自动调度并发量"
            aria-invalid={!concurrencyValid}
            value={concurrency}
            disabled={unavailable || props.pending}
            onChange={(event) => {
              setConcurrency(event.target.value)
              setConcurrencyDirty(true)
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && concurrencyValid) {
                void props
                  .onConcurrency(concurrencyValue)
                  .then(() => setConcurrencyDirty(false))
              }
            }}
          />
        </label>
        <button
          className="scheduler-concurrency-apply"
          type="button"
          disabled={unavailable || props.pending || !concurrencyValid}
          onClick={() =>
            void props
              .onConcurrency(concurrencyValue)
              .then(() => setConcurrencyDirty(false))
          }
        >
          应用
        </button>
        <button
          className={`control-button${scheduler?.autoEnabled ? " is-pause" : ""}`}
          type="button"
          disabled={unavailable || props.pending}
          onClick={props.onToggle}
        >
          <span className="control-button-icon" aria-hidden="true">
            {scheduler?.autoEnabled ? "Ⅱ" : "▶"}
          </span>
          <span>
            {scheduler?.autoEnabled ? "暂停自主调度" : "开启自主调度"}
          </span>
        </button>
      </div>
      {warning ? <p className="scheduler-warning">{warning}</p> : null}
    </section>
  )
}

function Stats({ snapshot }: { snapshot: DashboardSnapshot | null }) {
  const stats = snapshot?.stats
  const items = [
    [
      "已解出",
      stats?.solved,
      stats ? `共 ${stats.total} 道题` : "等待数据",
      "stat-primary",
    ],
    ["执行中", stats?.active, "正在工作的 Agent", ""],
    ["队列中", stats?.queued, "等待可用 worker", ""],
    ["待调度", stats?.pending, "尚未进入队列", ""],
    ["总尝试", stats?.attempts, "跨全部题目", ""],
    ["异常", stats?.failed, "失败 / 超时 / 中断", "stat-alert"],
  ] as const
  return (
    <section className="stats-grid" aria-label="比赛统计">
      {items.map(([label, value, note, className]) => (
        <article className={`stat-card ${className}`} key={label}>
          <span className="stat-label">{label}</span>
          <strong className="stat-value">{value ?? "—"}</strong>
          <span className="stat-note">{note}</span>
        </article>
      ))}
    </section>
  )
}

function Operations(props: {
  snapshot: DashboardSnapshot | null
  pending: boolean
  onReview: (
    candidate: DashboardSnapshot["announcementCandidates"][number],
    status: "approved" | "rejected",
  ) => void
}) {
  const { snapshot } = props
  const total = snapshot?.stats.total ?? 0
  const completion =
    total === 0 ? 0 : Math.round(((snapshot?.stats.solved ?? 0) / total) * 100)
  const environments =
    snapshot?.environments.filter((item) => item.status === "running").length ??
    0
  const announcements = snapshot?.announcements ?? []
  const pendingAnnouncements =
    snapshot?.announcementCandidates.filter(
      (item) => item.approvalStatus === "pending",
    ) ?? []
  const challengeTitles = new Map(
    snapshot?.challenges.map((challenge) => [challenge.id, challenge.title]) ??
      [],
  )
  return (
    <section className="operations-strip" aria-label="运行概况">
      <div>
        <span className="strip-label">完成率</span>
        <strong>{completion}%</strong>
        <div className="progress-track" aria-hidden="true">
          <span style={{ width: `${completion}%` }}></span>
        </div>
      </div>
      <div>
        <span className="strip-label">远程环境</span>
        <strong>{environments}</strong>
        <small>个正在运行</small>
      </div>
      <details className="announcements">
        <summary>
          <span className="strip-label">平台公告</span>
          <strong>{announcements.length}</strong>
          <small>条更新 · {pendingAnnouncements.length} 条待审核</small>
        </summary>
        <div className="announcement-popover">
          {pendingAnnouncements.length > 0 ? (
            <section className="announcement-review-list">
              <span className="strip-label">待批准发送给 Solver</span>
              {pendingAnnouncements.map((item) => (
                <article
                  className="announcement-item announcement-review-item"
                  key={`${item.challengeId}:${item.key}`}
                >
                  <strong>
                    {challengeTitles.get(item.challengeId) ?? item.challengeId}{" "}
                    ·{item.title}
                  </strong>
                  <p>{item.content}</p>
                  <small>关键词：{item.matchedKeywords.join("、")}</small>
                  <div className="announcement-review-actions">
                    <button
                      className="row-action"
                      disabled={props.pending}
                      onClick={() => props.onReview(item, "approved")}
                      type="button"
                    >
                      批准发送
                    </button>
                    <button
                      className="row-action is-cancel"
                      disabled={props.pending}
                      onClick={() => props.onReview(item, "rejected")}
                      type="button"
                    >
                      忽略
                    </button>
                  </div>
                </article>
              ))}
            </section>
          ) : null}
          {announcements.length === 0 ? (
            <p className="muted">暂无公告</p>
          ) : (
            announcements.map((item) => (
              <article className="announcement-item" key={item.id}>
                <strong>{item.title}</strong>
                <p>{item.content}</p>
                <time dateTime={item.publishedAt}>
                  {new Date(item.publishedAt).toLocaleString("zh-CN")}
                </time>
              </article>
            ))
          )}
        </div>
      </details>
    </section>
  )
}

function ChallengeBoard(props: {
  snapshot: DashboardSnapshot | null
  pending: boolean
  onOpen: (id: string) => void
  onAction: (challenge: DashboardChallenge) => void
}) {
  const searchRef = useRef<HTMLInputElement>(null)
  const [search, setSearch] = useState("")
  const [status, setStatus] = useState("all")
  const [category, setCategory] = useState("all")
  const [score, setScore] = useState("all")
  const [sort, setSort] = useState("activity")

  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      const target = event.target
      if (
        event.key === "/" &&
        !(target instanceof HTMLInputElement) &&
        !(target instanceof HTMLTextAreaElement) &&
        !(target instanceof HTMLSelectElement)
      ) {
        event.preventDefault()
        searchRef.current?.focus()
      }
    }
    document.addEventListener("keydown", keyboard)
    return () => document.removeEventListener("keydown", keyboard)
  }, [])

  const challenges = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase()
    const filtered = (props.snapshot?.challenges ?? []).filter((challenge) => {
      if (
        needle &&
        !`${challenge.title} ${challenge.id}`
          .toLocaleLowerCase()
          .includes(needle)
      )
        return false
      if (category !== "all" && challenge.category !== category) return false
      if (status !== "all" && !matchesStatus(challenge.status, status))
        return false
      if (score === "high" && challenge.score < 400) return false
      if (
        score === "medium" &&
        (challenge.score < 200 || challenge.score >= 400)
      )
        return false
      if (score === "low" && challenge.score >= 200) return false
      return true
    })
    return sortChallenges(filtered, sort)
  }, [props.snapshot?.challenges, search, status, category, score, sort])

  function reset() {
    setSearch("")
    setStatus("all")
    setCategory("all")
    setScore("all")
    setSort("activity")
  }

  return (
    <section
      className="board"
      id="challenge-board"
      aria-labelledby="board-title"
    >
      <div className="board-heading">
        <div>
          <p className="section-index">01 / CHALLENGES</p>
          <h2 id="board-title">题目作战面板</h2>
        </div>
        <span className="result-count">
          {props.snapshot
            ? `显示 ${challenges.length} / ${props.snapshot.challenges.length}`
            : "载入中"}
        </span>
      </div>
      <form
        className="filters"
        role="search"
        onReset={(event) => {
          event.preventDefault()
          reset()
        }}
      >
        <label className="search-control">
          <span className="sr-only">搜索题目</span>
          <span aria-hidden="true">⌕</span>
          <input
            ref={searchRef}
            type="search"
            autoComplete="off"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索题目名称或 ID"
          />
          <kbd>/</kbd>
        </label>
        <Filter label="状态" value={status} onChange={setStatus}>
          <option value="all">全部状态</option>
          <option value="active">执行中</option>
          <option value="queued">队列中</option>
          <option value="pending">未调度</option>
          <option value="solved">已解出</option>
          <option value="failed">异常</option>
        </Filter>
        <Filter label="分类" value={category} onChange={setCategory}>
          <option value="all">全部分类</option>
          {props.snapshot?.categories.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </Filter>
        <Filter label="分值" value={score} onChange={setScore}>
          <option value="all">全部分值</option>
          <option value="high">400+</option>
          <option value="medium">200–399</option>
          <option value="low">&lt; 200</option>
        </Filter>
        <Filter label="排序" value={sort} onChange={setSort}>
          <option value="activity">最近活动</option>
          <option value="status">状态优先</option>
          <option value="score-desc">分值从高到低</option>
          <option value="score-asc">分值从低到高</option>
          <option value="title">题目名称</option>
        </Filter>
        <button className="text-button" type="reset">
          重置
        </button>
      </form>
      <div
        className="challenge-table"
        role="table"
        aria-label="CTF 题目与 Agent 状态"
      >
        <div className="challenge-head" role="row">
          <span role="columnheader">题目</span>
          <span role="columnheader">分类 / 分值</span>
          <span role="columnheader">状态</span>
          <span role="columnheader">当前进度</span>
          <span role="columnheader">知识</span>
          <span role="columnheader">活动时间</span>
          <span aria-hidden="true"></span>
        </div>
        <div role="rowgroup" aria-live="polite">
          {!props.snapshot ? (
            <>
              <LoadingRow />
              <LoadingRow />
              <LoadingRow />
            </>
          ) : (
            challenges.map((challenge, index) => (
              <ChallengeRow
                key={challenge.id}
                challenge={challenge}
                index={index}
                pending={props.pending}
                scheduler={props.snapshot?.scheduler ?? null}
                onOpen={props.onOpen}
                onAction={props.onAction}
              />
            ))
          )}
        </div>
      </div>
      {props.snapshot && challenges.length === 0 ? (
        <div className="empty-state">
          <span>∅</span>
          <h3>没有匹配的题目</h3>
          <p>调整筛选条件，或清空搜索关键词。</p>
          <button className="outline-button" type="button" onClick={reset}>
            清除筛选
          </button>
        </div>
      ) : null}
    </section>
  )
}

function Filter(props: {
  label: string
  value: string
  onChange: (value: string) => void
  children: React.ReactNode
}) {
  return (
    <label>
      <span>{props.label}</span>
      <select
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
      >
        {props.children}
      </select>
    </label>
  )
}

function ChallengeRow(props: {
  challenge: DashboardChallenge
  index: number
  pending: boolean
  scheduler: DashboardSnapshot["scheduler"]
  onOpen: (id: string) => void
  onAction: (challenge: DashboardChallenge) => void
}) {
  const challenge = props.challenge
  const active = ["queued", "preparing", "running"].includes(challenge.status)
  const exhausted = Boolean(
    props.scheduler &&
      challenge.schedulerAttempts >= props.scheduler.maxAttempts,
  )
  const action =
    !props.scheduler?.available || challenge.status === "solved"
      ? { label: "查看", details: true, disabled: false }
      : active
        ? { label: "取消", details: false, disabled: false }
        : challenge.status === "blocked"
          ? { label: "人工重启", details: false, disabled: false }
          : exhausted
            ? { label: "已耗尽", details: false, disabled: true }
            : {
                label: challenge.schedulerAttempts > 0 ? "重试" : "调度",
                details: false,
                disabled: false,
              }
  return (
    <div
      className="challenge-row"
      role="row"
      tabIndex={0}
      style={{ "--row-index": props.index } as React.CSSProperties}
      aria-label={`${challenge.title}，${STATUS_LABELS[challenge.status]}，${challenge.score} 分`}
      onClick={() => props.onOpen(challenge.id)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault()
          props.onOpen(challenge.id)
        }
      }}
    >
      <span className="challenge-name" role="cell">
        <strong>{challenge.title}</strong>
        <small>{challenge.id}</small>
      </span>
      <span className="category-score" role="cell">
        <span className="category-tag">{challenge.category}</span>
        <span className="score">{challenge.score} pt</span>
        {challenge.needsEnv ? <span className="env-tag">环境</span> : null}
      </span>
      <span className={`status-chip status-${challenge.status}`} role="cell">
        {STATUS_LABELS[challenge.status] ?? challenge.status}
      </span>
      <span className="progress-cell" role="cell">
        <strong>{challenge.progress}</strong>
        <small>
          {challenge.attempts === 0
            ? "尚无运行记录"
            : `${challenge.attempts} 次尝试 · ${challenge.sessionInterruptions} 次中断`}
        </small>
      </span>
      <span className="knowledge" role="cell">
        <span title="证据">
          <i></i>
          {challenge.evidence}
        </span>
        <span title="开放机会">
          <i></i>
          {challenge.openOpportunities}
        </span>
      </span>
      <time
        className="activity"
        role="cell"
        dateTime={challenge.lastActivityAt ?? undefined}
        title={
          challenge.lastActivityAt
            ? new Date(challenge.lastActivityAt).toLocaleString("zh-CN")
            : undefined
        }
      >
        {relativeTime(challenge.lastActivityAt)}
      </time>
      <button
        className={`row-action${active ? " is-cancel" : ""}`}
        type="button"
        disabled={props.pending || action.disabled}
        onClick={(event) => {
          event.stopPropagation()
          action.details
            ? props.onOpen(challenge.id)
            : props.onAction(challenge)
        }}
      >
        {action.label}
      </button>
    </div>
  )
}

function LoadingRow() {
  return (
    <div className="loading-row">
      <span></span>
      <span></span>
      <span></span>
      <span></span>
    </div>
  )
}

const root = document.querySelector("#root")
if (!root) throw new Error("React root 不存在")
createRoot(root).render(<App />)
