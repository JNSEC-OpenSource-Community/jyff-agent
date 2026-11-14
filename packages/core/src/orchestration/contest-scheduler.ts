import type { CtfSolverAgent, SolverCloseReason } from "@ctf-agent/agents"
import type { ChallengeSummary } from "@ctf-agent/platform"
import {
  activeSubagentsPrompt,
  BLOCKED_FINALIZATION_PROMPT,
  INCOMPLETE_CONTINUATION_PROMPT,
  WRITEUP_PROMPT,
} from "@ctf-agent/prompts"
import type { AgentOptions } from "@earendil-works/pi-agent-core"
import { shortSubagentPage } from "../collaboration/subagent-report.ts"
import type {
  RunRecord,
  RunSource,
  SchedulerMode,
  SchedulerQueueRecord,
  SchedulerQueueStage,
} from "../persistence/run-store.ts"
import type { CreateSolverOptions, Project } from "../project/project.ts"
import {
  ChallengeTimeoutError,
  hasTerminalSubmission,
  runSolverPrompt,
  sessionInterruptionMessage,
} from "./solver-attempt.ts"
import { classifySolverStop } from "./stop-classifier.ts"
import { validateChallengeWriteup } from "./writeup-validator.ts"

export type SchedulerQueueSource = Extract<RunSource, "auto" | "manual" | "retry" | "revival">
export type SchedulerPhase = "preparing" | "running" | "waiting_environment" | "cancelling"
export type SchedulerRuntimeState = "stopped" | "running" | "automatic" | "suspended"

export interface ContestSchedulerOptions {
  maxConcurrent: number
  maxAttempts?: number
  maxSessionInterruptions?: number
  challengeTimeoutMs?: number
  abortGraceMs?: number
  retryDelayMs?: number
  infrastructureRetryDelayMs?: number
  transientRetryDelaysMs?: readonly [number, number, number]
  /** Flag accepted 后执行 writeup turn；生产调度应开启。 */
  writeup?: boolean
  createAgentOptions(context: SchedulerAttemptContext): AgentOptions | Promise<AgentOptions>
  compaction?: CreateSolverOptions["compaction"]
  prompt?: string | ((context: SchedulerAttemptContext) => string | Promise<string>)
  availability?: () => SchedulerAvailability
  available?: boolean
  unavailableReason?: string
  /** Persist the new runtime concurrency limit before it becomes active. */
  onMaxConcurrentChange?: (maxConcurrent: number) => void | Promise<void>
}

export interface SchedulerAvailability {
  available: boolean
  unavailableReason?: string
}

export interface SchedulerAttemptContext {
  challenge: ChallengeSummary
  attempt: number
  source: SchedulerQueueSource
}

export interface SchedulerQueueEntry {
  challengeId: string
  source: SchedulerQueueSource
  stage: SchedulerQueueStage
  lane: "normal" | "blocked"
  manualOverride: boolean
  enqueuedAt: string
  position: number
  version: number
}

export interface SchedulerActiveEntry {
  challengeId: string
  runId: string | null
  attempt: number
  source: SchedulerQueueSource
  phase: SchedulerPhase
  startedAt: string
}

export interface ContestSchedulerSnapshot {
  available: boolean
  unavailableReason?: string
  /** 兼容旧客户端；manual/automatic 均为 true。 */
  autoEnabled: boolean
  state: SchedulerRuntimeState
  mode: SchedulerMode
  idleVersion: number
  executionVersion: number
  maxConcurrent: number
  maxAttempts: number
  maxSessionInterruptions: number
  idle: SchedulerQueueEntry[]
  queued: SchedulerQueueEntry[]
  active: SchedulerActiveEntry[]
  lastError?: string
}

export class ContestSchedulerError extends Error {
  constructor(
    readonly code:
      | "unavailable"
      | "challenge_not_found"
      | "run_not_found"
      | "run_not_retryable"
      | "already_queued"
      | "already_active"
      | "already_solved"
      | "attempts_exhausted"
      | "blocked"
      | "excluded"
      | "auto_enabled"
      | "scheduler_running"
      | "queue_version_conflict",
    message: string,
  ) {
    super(message)
    this.name = "ContestSchedulerError"
  }
}

interface QueueItem {
  challenge: ChallengeSummary
  source: SchedulerQueueSource
  stage: SchedulerQueueStage
  lane: "normal" | "blocked"
  manualOverride: boolean
  requiresAuto: boolean
  enqueuedAt: string
  version: number
  /** retryAttempt() 的恢复项只存在内存；自动恢复项仍需跟随持久队列。 */
  persisted?: boolean
  resumeRun?: RunRecord
  retryPrompt?: string
  writeupRetry?: boolean
}

interface ActiveItem {
  challenge: ChallengeSummary
  source: SchedulerQueueSource
  lane: "normal" | "blocked"
  requiresAuto: boolean
  attempt: number
  phase: SchedulerPhase
  startedAt: string
  runId: string | null
  solver?: CtfSolverAgent
  cancelRequested: boolean
  queueGeneration: number
  operation?: Promise<void>
  resumeRun?: RunRecord
  retryPrompt?: string
  writeupRetry?: boolean
  cancelRetryDelay?: () => void
}

export const DEFAULT_TRANSIENT_RETRY_DELAYS_MS = [10_000, 60_000, 300_000] as const

const RECOVERABLE_SCHEDULER_RUN_SOURCES = new Set<RunSource>(["auto", "manual", "retry", "revival"])
const RECOVERABLE_TERMINAL_RUN_STATUSES = new Set<RunRecord["status"]>([
  "failed",
  "timed_out",
  "cancelled",
  "closed",
  "interrupted",
])

/**
 * 长驻的混合调度控制面：
 * - manual 模式只执行用户从空闲队列提交的题目；automatic 模式持续补充全部可调度题；
 * - 暂停保留空闲/执行队列且不取消已经运行的任务；
 * - 同题在 idle/execution/active 阶段互斥；
 * - 失败按调度来源计入重试预算，direct/test Run 不消耗预算。
 */
export class ContestScheduler {
  private readonly idleQueue: QueueItem[] = []
  private readonly queue: QueueItem[] = []
  private readonly active = new Map<string, ActiveItem>()
  private mode: SchedulerMode
  private shuttingDown = false
  private shutdownOperation?: Promise<void>
  private pumping = false
  private lastError?: string
  private maxConcurrent: number
  private queueGeneration = 0
  private suspensionReason?: string
  private discoveringAdmission = false
  /** 正在被 resetChallenge 清空的题目：任何在途 reconcile/pump 都必须跳过，避免 wipe 期间重建 Run。 */
  private readonly resetting = new Set<string>()
  private readonly admissionDiscoveryRetryAt = new Map<string, number>()
  private readonly unsubscribeRemoteEnvironmentCapacity: () => void

  constructor(
    private readonly project: Project,
    private readonly options: ContestSchedulerOptions,
  ) {
    positiveInteger(options.maxConcurrent, "maxConcurrent")
    this.mode = project.schedulerState().mode
    this.maxConcurrent = options.maxConcurrent
    positiveInteger(options.maxAttempts ?? 2, "maxAttempts")
    positiveInteger(options.maxSessionInterruptions ?? 3, "maxSessionInterruptions")
    positiveInteger(options.challengeTimeoutMs ?? 30 * 60_000, "challengeTimeoutMs")
    nonNegativeInteger(options.abortGraceMs ?? 5_000, "abortGraceMs")
    nonNegativeInteger(options.retryDelayMs ?? 2_000, "retryDelayMs")
    nonNegativeInteger(options.infrastructureRetryDelayMs ?? 15_000, "infrastructureRetryDelayMs")
    this.unsubscribeRemoteEnvironmentCapacity = this.project.subscribeRemoteEnvironmentCapacity(
      () => this.pump(),
    )
    for (const [index, delay] of (
      options.transientRetryDelaysMs ?? DEFAULT_TRANSIENT_RETRY_DELAYS_MS
    ).entries()) {
      nonNegativeInteger(delay, `transientRetryDelaysMs[${index}]`)
    }
  }

  snapshot(): ContestSchedulerSnapshot {
    this.syncPersistedQueueMetadata()
    const availability = this.availability()
    const state = this.project.schedulerState()
    const entry = (item: QueueItem, index: number): SchedulerQueueEntry => ({
      challengeId: item.challenge.id,
      source: item.source,
      stage: item.stage,
      lane: item.lane,
      manualOverride: item.manualOverride,
      enqueuedAt: item.enqueuedAt,
      position: index + 1,
      version: item.version,
    })
    const persistedEntry = (item: SchedulerQueueRecord, index: number): SchedulerQueueEntry => ({
      challengeId: item.challengeId,
      source: item.source as SchedulerQueueSource,
      stage: item.stage,
      lane: item.lane,
      manualOverride: item.manualOverride,
      enqueuedAt: item.enqueuedAt,
      position: index + 1,
      version: item.version,
    })
    // restore() 可能因模型或平台暂不可用而无法取得 ChallengeSummary；此时快照仍必须
    // 暴露 RunStore 中的编排意图，避免 Dashboard 把持久队列误报为空。
    const usePersistedFallback =
      this.idleQueue.length === 0 && this.queue.length === 0 && this.active.size === 0
    const idle = usePersistedFallback
      ? this.project.schedulerQueue("idle").map(persistedEntry)
      : this.idleQueue.map(entry)
    const queued = usePersistedFallback
      ? this.project.schedulerQueue("execution").map(persistedEntry)
      : this.queue.map(entry)
    const runtimeState: SchedulerRuntimeState = this.suspensionReason
      ? "suspended"
      : this.mode === "automatic"
        ? "automatic"
        : this.mode === "manual"
          ? "running"
          : "stopped"
    return {
      available: availability.available,
      ...(availability.unavailableReason
        ? { unavailableReason: availability.unavailableReason }
        : {}),
      autoEnabled: this.mode !== "stopped",
      state: runtimeState,
      mode: this.mode,
      idleVersion: state.idleVersion,
      executionVersion: state.executionVersion,
      maxConcurrent: this.maxConcurrent,
      maxAttempts: this.options.maxAttempts ?? 2,
      maxSessionInterruptions: this.options.maxSessionInterruptions ?? 3,
      idle,
      queued,
      active: [...this.active.values()].map((item) => ({
        challengeId: item.challenge.id,
        runId: item.runId,
        attempt: item.attempt,
        source: item.source,
        phase: item.phase,
        startedAt: item.startedAt,
      })),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    }
  }

  /** 恢复持久化调度意图与两阶段队列；生产创建 Scheduler 后调用一次。 */
  async restore(): Promise<ContestSchedulerSnapshot> {
    return this.reconcile()
  }

  /** 用户启动：只提交已经排好顺序的空闲队列，不隐式加入其他赛题。 */
  async start(): Promise<ContestSchedulerSnapshot> {
    this.assertAvailable()
    this.assertNotShuttingDown()
    this.assertPlanningStopped()
    this.mode = this.project.startScheduler("manual").mode
    this.promoteIdleInMemory()
    await this.reconcile()
    this.pump()
    return this.snapshot()
  }

  /** 自动模式保留给 CLI/显式自动化：持续补充所有可调度题目。 */
  async startAuto(): Promise<ContestSchedulerSnapshot> {
    this.assertAvailable()
    this.assertNotShuttingDown()
    this.mode = this.project.startScheduler("automatic").mode
    this.promoteIdleInMemory()
    await this.reconcile()
    this.pump()
    return this.snapshot()
  }

  pauseAuto(): ContestSchedulerSnapshot {
    this.mode = this.project.setSchedulerMode("stopped").mode
    // 已运行任务可以自然结束，但等待任务及其后续 retry 必须冻结到再次启动。
    for (const item of this.queue) item.requiresAuto = true
    for (const item of this.active.values()) item.requiresAuto = true
    return this.snapshot()
  }

  /** 平台暂不可用时冻结领取，不清除持久队列或调度意图。 */
  suspend(reason: string): ContestSchedulerSnapshot {
    this.suspensionReason = reason
    return this.snapshot()
  }

  /** 平台恢复后继续处理挂起前保留的队列。 */
  resume(): ContestSchedulerSnapshot {
    this.suspensionReason = undefined
    this.pump()
    return this.snapshot()
  }

  async setMaxConcurrent(maxConcurrent: number): Promise<ContestSchedulerSnapshot> {
    this.assertAvailable()
    this.assertNotShuttingDown()
    positiveInteger(maxConcurrent, "maxConcurrent")
    if (maxConcurrent > 64) throw new Error("maxConcurrent 不能超过 64")
    if (maxConcurrent === this.maxConcurrent) return this.snapshot()
    await this.options.onMaxConcurrentChange?.(maxConcurrent)
    this.maxConcurrent = maxConcurrent
    this.pump()
    return this.snapshot()
  }

  async reconcile(): Promise<ContestSchedulerSnapshot> {
    if (this.shuttingDown || !this.availability().available) return this.snapshot()
    await this.project.refresh()
    const challenges = deduplicate(await this.project.challenges())
    const byId = new Map(challenges.map((challenge) => [challenge.id, challenge]))
    const invalid = (challengeId: string): boolean => {
      const challenge = byId.get(challengeId)
      return (
        !challenge ||
        challenge.solved ||
        this.project.isChallengeSolved(challengeId) ||
        this.project.isChallengeSchedulingExcluded(challengeId)
      )
    }
    const recoverableRuns = latestRecoverableInterruptedRuns(this.project.runs())

    for (const items of [this.idleQueue, this.queue]) {
      for (let index = items.length - 1; index >= 0; index--) {
        const item = items[index]
        if (!item || !invalid(item.challenge.id)) continue
        items.splice(index, 1)
        if (item.persisted !== false) this.project.removeSchedulerChallenge(item.challenge.id)
      }
    }

    for (const persisted of this.project.schedulerQueue()) {
      if (this.resetting.has(persisted.challengeId)) continue
      const challenge = byId.get(persisted.challengeId)
      if (!challenge || invalid(persisted.challengeId)) {
        this.project.removeSchedulerChallenge(persisted.challengeId)
        continue
      }
      if (this.hasChallenge(persisted.challengeId)) continue
      const resumeRun = recoverableRuns.get(persisted.challengeId)
      if (resumeRun) recoverableRuns.delete(persisted.challengeId)
      const item: QueueItem = {
        challenge,
        source: persisted.source as SchedulerQueueSource,
        stage: persisted.stage,
        lane: persisted.lane,
        manualOverride: persisted.manualOverride,
        requiresAuto: true,
        enqueuedAt: persisted.enqueuedAt,
        version: persisted.version,
        persisted: true,
        ...(resumeRun ? { resumeRun } : {}),
      }
      if (persisted.stage === "idle") this.idleQueue.push(item)
      else this.queue.push(item)
    }

    if (this.mode !== "stopped") {
      for (const resumeRun of recoverableRuns.values()) {
        const challenge = byId.get(resumeRun.challengeId)
        if (
          !challenge ||
          invalid(challenge.id) ||
          this.project.isChallengeBlocked(challenge.id) ||
          this.hasChallenge(challenge.id)
        ) {
          continue
        }
        this.enqueueChallenge(challenge, "retry", "execution", "normal", true, true, { resumeRun })
      }
    }

    if (this.mode === "automatic") {
      for (const challenge of challenges) {
        if (
          this.resetting.has(challenge.id) ||
          challenge.solved ||
          this.project.isChallengeSolved(challenge.id) ||
          this.project.isChallengeSchedulingExcluded(challenge.id) ||
          this.project.isChallengeBlocked(challenge.id) ||
          this.hasChallenge(challenge.id)
        ) {
          continue
        }
        this.enqueueChallenge(challenge, "auto", "execution", "normal", false, true)
      }

      const ordinaryOutstanding = challenges.some(
        (challenge) =>
          !this.resetting.has(challenge.id) &&
          !challenge.solved &&
          !this.project.isChallengeSolved(challenge.id) &&
          !this.project.isChallengeSchedulingExcluded(challenge.id) &&
          !this.project.isChallengeBlocked(challenge.id),
      )
      if (!ordinaryOutstanding) {
        const blocked = challenges
          .filter(
            (challenge) =>
              !this.resetting.has(challenge.id) &&
              !challenge.solved &&
              !this.project.isChallengeSchedulingExcluded(challenge.id) &&
              this.project.isChallengeBlocked(challenge.id) &&
              !this.hasChallenge(challenge.id),
          )
          .sort((left, right) => {
            const leftAt = this.project.challengeRuntimeState(left.id).blockedAt ?? ""
            const rightAt = this.project.challengeRuntimeState(right.id).blockedAt ?? ""
            return leftAt.localeCompare(rightAt) || left.id.localeCompare(right.id)
          })
        for (const challenge of blocked) {
          this.enqueueChallenge(challenge, "revival", "execution", "blocked", false, true)
        }
      }
    }
    this.pump()
    return this.snapshot()
  }

  async stage(challengeIds: readonly string[]): Promise<ContestSchedulerSnapshot> {
    this.assertAvailable()
    this.assertNotShuttingDown()
    this.assertPlanningStopped()
    const uniqueIds = [...new Set(challengeIds)]
    if (uniqueIds.length === 0) return this.snapshot()
    await this.reconcile()
    const challenges = new Map((await this.project.challenges()).map((item) => [item.id, item]))
    // refresh/challenges 都会让出事件循环；提交批量写入前必须重新校验，避免并发 start()
    // 已迁移旧计划后又插入新的 idle 项。
    this.assertAvailable()
    this.assertNotShuttingDown()
    this.assertPlanningStopped()
    const additions: Array<{ challenge: ChallengeSummary; record: SchedulerQueueRecord }> = []
    const inputs: Array<{
      challengeId: string
      source: "manual"
      stage: "idle"
      lane: "normal"
      manualOverride: false
    }> = []

    for (const challengeId of uniqueIds) {
      if (this.active.has(challengeId)) {
        throw new ContestSchedulerError("already_active", `${challengeId} 已有正在运行的 Agent`)
      }
      const existing = [...this.idleQueue, ...this.queue].find(
        (item) => item.challenge.id === challengeId,
      )
      if (existing?.stage === "idle") continue
      if (existing) {
        throw new ContestSchedulerError("already_queued", `${challengeId} 已在执行队列中`)
      }
      const challenge = challenges.get(challengeId)
      if (!challenge) {
        throw new ContestSchedulerError("challenge_not_found", `平台不存在题目: ${challengeId}`)
      }
      const disposition = this.project.challengeSchedulingDisposition(challengeId)
      if (disposition) {
        throw new ContestSchedulerError(
          "excluded",
          disposition === "solved"
            ? `${challenge.title} 已人工标记为已解出`
            : `${challenge.title} 已标记为不调度`,
        )
      }
      if (challenge.solved || this.project.isChallengeSolved(challengeId)) {
        throw new ContestSchedulerError("already_solved", `${challenge.title} 已经解出`)
      }
      if (this.project.isChallengeBlocked(challengeId)) {
        throw new ContestSchedulerError("blocked", `${challenge.title} 已 blocked，不能批量加入`)
      }
      inputs.push({
        challengeId,
        source: "manual",
        stage: "idle",
        lane: "normal",
        manualOverride: false,
      })
    }

    const records = this.project.enqueueSchedulerChallenges(inputs)
    for (const record of records) {
      const challenge = challenges.get(record.challengeId)
      if (challenge) additions.push({ challenge, record })
    }
    for (const { challenge, record } of additions) {
      if (this.hasChallenge(challenge.id)) continue
      this.idleQueue.push({
        challenge,
        source: "manual",
        stage: "idle",
        lane: "normal",
        manualOverride: false,
        requiresAuto: true,
        enqueuedAt: record.enqueuedAt,
        version: record.version,
        persisted: true,
      })
    }
    return this.snapshot()
  }

  unstage(challengeIds: readonly string[]): ContestSchedulerSnapshot {
    this.assertNotShuttingDown()
    this.assertPlanningStopped()
    const ids = new Set(challengeIds)
    this.project.removeSchedulerChallenges([...ids], "idle")
    for (let index = this.idleQueue.length - 1; index >= 0; index--) {
      const item = this.idleQueue[index]
      if (item && ids.has(item.challenge.id)) this.idleQueue.splice(index, 1)
    }
    return this.snapshot()
  }

  reorderIdle(challengeIds: readonly string[], expectedVersion: number): ContestSchedulerSnapshot {
    this.assertNotShuttingDown()
    this.assertPlanningStopped()
    let records: SchedulerQueueRecord[]
    try {
      records = this.project.reorderSchedulerStage("idle", challengeIds, expectedVersion)
    } catch (error) {
      if (errorText(error).includes("version conflict")) {
        throw new ContestSchedulerError("queue_version_conflict", errorText(error))
      }
      throw error
    }
    const byId = new Map(this.idleQueue.map((item) => [item.challenge.id, item]))
    this.idleQueue.length = 0
    for (const record of records) {
      const item = byId.get(record.challengeId)
      if (!item) continue
      item.version = record.version
      item.enqueuedAt = record.enqueuedAt
      this.idleQueue.push(item)
    }
    return this.snapshot()
  }

  async dispatch(
    challengeId: string,
    options: { force?: boolean } = {},
  ): Promise<ContestSchedulerSnapshot> {
    this.assertAvailable()
    this.assertNotShuttingDown()
    if (this.active.has(challengeId)) {
      throw new ContestSchedulerError("already_active", "该题已有正在运行的 Agent")
    }
    if (
      this.queue.some((item) => item.challenge.id === challengeId) ||
      this.idleQueue.some((item) => item.challenge.id === challengeId)
    ) {
      throw new ContestSchedulerError("already_queued", "该题已经在调度队列中")
    }
    await this.project.refresh()
    const challenge = (await this.project.challenges()).find(
      (candidate) => candidate.id === challengeId,
    )
    if (!challenge) {
      throw new ContestSchedulerError("challenge_not_found", `平台不存在题目: ${challengeId}`)
    }
    const schedulingDisposition = this.project.challengeSchedulingDisposition(challengeId)
    if (schedulingDisposition) {
      throw new ContestSchedulerError(
        "excluded",
        schedulingDisposition === "solved"
          ? "该题已人工标记为已解出；请先恢复默认调度状态"
          : "该题已标记为不调度；请先恢复默认调度状态",
      )
    }
    const solved = challenge.solved || this.project.isChallengeSolved(challengeId)
    if (solved && !options.force) {
      throw new ContestSchedulerError("already_solved", "该题已经解出；重新验证需要显式 force")
    }
    const blocked = this.project.isChallengeBlocked(challengeId)
    if (blocked && !options.force) {
      throw new ContestSchedulerError(
        "blocked",
        "该题已 blocked；需要人工 force 将其提前到调度队列",
      )
    }
    const resumeRun = blocked ? undefined : latestRecoverableRun(this.project.runs({ challengeId }))
    this.enqueueChallenge(
      challenge,
      blocked ? "revival" : "manual",
      "execution",
      blocked ? "blocked" : "normal",
      blocked,
      false,
      resumeRun ? { resumeRun } : undefined,
    )
    this.pump()
    return this.snapshot()
  }

  async retryAttempt(
    runId: string,
    options: { prompt?: string } = {},
  ): Promise<ContestSchedulerSnapshot> {
    this.assertAvailable()
    this.assertNotShuttingDown()
    const run = this.project.runs().find((candidate) => candidate.id === runId)
    if (!run) {
      throw new ContestSchedulerError("run_not_found", `Run 不存在: ${runId}`)
    }
    const retryAcceptedWriteup =
      run.status === "solved" &&
      this.options.writeup === true &&
      this.project.runEvents(run.id).some((event) => event.type === "writeup_failed")
    if (!RETRYABLE_RUN_STATUSES.has(run.status) && !retryAcceptedWriteup) {
      throw new ContestSchedulerError(
        "run_not_retryable",
        `Run ${runId} 当前状态 ${run.status} 不允许重试`,
      )
    }
    if (this.active.has(run.challengeId)) {
      throw new ContestSchedulerError("already_active", "该题已有正在运行的 Agent")
    }
    if (
      this.queue.some((item) => item.challenge.id === run.challengeId) ||
      this.idleQueue.some((item) => item.challenge.id === run.challengeId)
    ) {
      throw new ContestSchedulerError("already_queued", "该题已经在调度队列中")
    }
    const prompt = options.prompt?.trim()
    if (prompt && prompt.length > 32_000) {
      throw new Error("重试提示词长度不能超过 32000")
    }
    await this.project.refresh()
    const challenge = (await this.project.challenges()).find(
      (candidate) => candidate.id === run.challengeId,
    )
    if (!challenge) {
      throw new ContestSchedulerError("challenge_not_found", `平台不存在题目: ${run.challengeId}`)
    }
    if (this.project.challengeSchedulingDisposition(run.challengeId)) {
      throw new ContestSchedulerError("excluded", "该题已设置人工调度状态；请先恢复默认调度状态")
    }
    const writeupRetry =
      this.options.writeup === true &&
      this.project
        .runEvents(run.id)
        .some((event) => event.type === "run_writing_writeup" || event.type === "writeup_failed")
    if (!writeupRetry && (challenge.solved || this.project.isChallengeSolved(run.challengeId))) {
      throw new ContestSchedulerError("already_solved", "该题已经解出")
    }
    const blocked = this.project.isChallengeBlocked(run.challengeId)
    this.queue.unshift({
      challenge,
      source: "retry",
      stage: "execution",
      lane: blocked ? "blocked" : "normal",
      manualOverride: true,
      requiresAuto: false,
      enqueuedAt: new Date().toISOString(),
      version: 1,
      persisted: false,
      resumeRun: run,
      ...(prompt ? { retryPrompt: prompt } : {}),
      ...(writeupRetry ? { writeupRetry: true } : {}),
    })
    this.pump()
    return this.snapshot()
  }

  reorderQueue(
    challengeId: string,
    options: {
      position: number
      expectedVersion: number
      overrideBlockedLane?: boolean
    },
  ): ContestSchedulerSnapshot {
    const item = this.queue.find((candidate) => candidate.challenge.id === challengeId)
    if (!item) {
      throw new ContestSchedulerError("challenge_not_found", `题目不在调度队列中: ${challengeId}`)
    }
    if (item.resumeRun && item.persisted === false) {
      if (item.version !== options.expectedVersion) {
        throw new ContestSchedulerError(
          "queue_version_conflict",
          `queue version conflict: expected ${options.expectedVersion}, actual ${item.version}`,
        )
      }
      const from = this.queue.indexOf(item)
      this.queue.splice(from, 1)
      const target = Math.max(0, Math.min(this.queue.length, options.position - 1))
      this.queue.splice(target, 0, item)
      item.version += 1
      return this.snapshot()
    }
    let moved: SchedulerQueueRecord
    try {
      moved = this.project.moveSchedulerChallenge({
        challengeId,
        position: options.position,
        expectedVersion: options.expectedVersion,
        overrideBlockedLane: options.overrideBlockedLane,
      })
    } catch (error) {
      if (errorText(error).includes("version conflict")) {
        throw new ContestSchedulerError("queue_version_conflict", errorText(error))
      }
      throw error
    }
    item.manualOverride = moved.manualOverride
    item.version = moved.version
    item.requiresAuto = item.requiresAuto && !moved.manualOverride
    const persisted = this.project.schedulerQueue("execution")
    this.syncPersistedQueueMetadata(persisted)
    const order = new Map(persisted.map((record, index) => [record.challengeId, index]))
    this.queue.sort(
      (left, right) =>
        (order.get(left.challenge.id) ?? Number.MAX_SAFE_INTEGER) -
        (order.get(right.challenge.id) ?? Number.MAX_SAFE_INTEGER),
    )
    this.pump()
    return this.snapshot()
  }

  /**
   * RunStore 在删除或重排条目时也会更新所有位置受影响行的版本。
   * 内存队列必须在发布 snapshot 前回灌这些版本，否则 WebUI 会用陈旧版本
   * 发起下一次正常拖动，并被持久层误判为并发冲突。
   */
  private syncPersistedQueueMetadata(
    records: SchedulerQueueRecord[] = this.project.schedulerQueue(),
  ): void {
    const byId = new Map(records.map((record) => [record.challengeId, record]))
    for (const item of [...this.idleQueue, ...this.queue]) {
      if (item.resumeRun && item.persisted === false) continue
      const record = byId.get(item.challenge.id)
      if (!record) continue
      item.stage = record.stage
      item.lane = record.lane
      item.manualOverride = record.manualOverride
      item.enqueuedAt = record.enqueuedAt
      item.version = record.version
      item.requiresAuto = item.requiresAuto && !record.manualOverride
    }
  }

  async cancel(challengeId: string): Promise<ContestSchedulerSnapshot> {
    const idleIndex = this.idleQueue.findIndex((item) => item.challenge.id === challengeId)
    if (idleIndex >= 0) {
      this.idleQueue.splice(idleIndex, 1)
      this.project.removeSchedulerChallenge(challengeId)
      return this.snapshot()
    }
    const queueIndex = this.queue.findIndex((item) => item.challenge.id === challengeId)
    if (queueIndex >= 0) {
      const [removed] = this.queue.splice(queueIndex, 1)
      if (removed && removed.persisted !== false) {
        this.project.removeSchedulerChallenge(challengeId)
      }
      return this.snapshot()
    }
    const active = this.active.get(challengeId)
    if (!active) return this.snapshot()
    active.cancelRequested = true
    active.phase = "cancelling"
    active.cancelRetryDelay?.()
    const failures: unknown[] = []
    try {
      await active.solver?.abort()
    } catch (error) {
      failures.push(error)
    }
    try {
      if (active.solver) await active.solver.close("cancelled", "由控制面取消")
    } catch (error) {
      failures.push(error)
    }
    await active.operation?.catch((error: unknown) => failures.push(error))
    if (failures.length > 0) {
      throw new AggregateError(failures, `Solver ${challengeId} 资源回收不完整`)
    }
    return this.snapshot()
  }

  /** 调度暂停后，正常停止当前所有 Solver，并等待其 SubAgent、远程环境与 Sandbox 回收。 */
  async stopAllActive(): Promise<ContestSchedulerSnapshot> {
    this.assertNotShuttingDown()
    if (this.mode !== "stopped") {
      throw new ContestSchedulerError("auto_enabled", "请先暂停调度，再停止所有 Solver")
    }
    const challengeIds = [...this.active.keys()]
    const settled = await Promise.allSettled(
      challengeIds.map(async (challengeId) => await this.cancel(challengeId)),
    )
    const failures = settled
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason)
    if (failures.length > 0) {
      throw new AggregateError(failures, "部分 Solver 资源回收失败")
    }
    return this.snapshot()
  }

  /** 完全重置单题：终止活跃/排队 Run，清空本地状态，自动模式开启则按新题重新入队。 */
  async resetChallenge(challengeId: string): Promise<ContestSchedulerSnapshot> {
    this.resetting.add(challengeId)
    try {
      // (a) 摘除内存队列项 + 持久化 scheduler_queue 行（含 resumeRun：其指向的 Run 即将被删）
      const idleIndex = this.idleQueue.findIndex((item) => item.challenge.id === challengeId)
      if (idleIndex >= 0) this.idleQueue.splice(idleIndex, 1)
      const queueIndex = this.queue.findIndex((item) => item.challenge.id === challengeId)
      if (queueIndex >= 0) this.queue.splice(queueIndex, 1)
      this.project.removeSchedulerChallenge(challengeId)

      // (b) 终止活跃 Run（abort + close "cancelled" → 回收 sandbox + 释放远程环境租约）
      const active = this.active.get(challengeId)
      if (active) {
        active.cancelRequested = true
        active.phase = "cancelling"
        active.cancelRetryDelay?.()
        await active.solver?.abort()
        if (active.solver) await active.solver.close("cancelled", "重置题目：运行已停止")
        await active.operation?.catch(() => undefined)
      }

      // (c) wipe DB + 磁盘 + 内存状态
      await this.project.resetChallenge(challengeId)
    } finally {
      this.resetting.delete(challengeId)
    }

    // (d) 自动重新入队（reconcile 自判 autoEnabled/availability；晚到的在途 reconcile 经
    //     hasChallenge/去重不会重复入队）
    if (this.mode !== "stopped") await this.reconcile()
    return this.snapshot()
  }

  async shutdown(): Promise<void> {
    if (this.shutdownOperation) return this.shutdownOperation
    this.shutdownOperation = this.performShutdown()
    return this.shutdownOperation
  }

  private async performShutdown(): Promise<void> {
    this.shuttingDown = true
    this.unsubscribeRemoteEnvironmentCapacity()
    this.mode = "stopped"
    this.idleQueue.length = 0
    this.queue.length = 0
    const active = [...this.active.values()]
    for (const item of active) {
      item.cancelRequested = true
      item.phase = "cancelling"
      item.cancelRetryDelay?.()
    }
    const settled = await Promise.allSettled(
      active.map(async (item) => {
        const failures: unknown[] = []
        try {
          await item.solver?.abort()
        } catch (error) {
          failures.push(error)
        }
        try {
          if (item.solver) await item.solver.close("cancelled", "调度控制面关闭")
        } catch (error) {
          failures.push(error)
        }
        await item.operation?.catch((error: unknown) => failures.push(error))
        if (failures.length > 0) {
          throw new AggregateError(failures, `Solver ${item.challenge.id} 资源回收不完整`)
        }
      }),
    )
    const failures = settled
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason)
    if (failures.length > 0) {
      throw new AggregateError(failures, "调度控制面关闭时部分 Solver 资源回收失败")
    }
  }

  private hasChallenge(challengeId: string): boolean {
    return (
      this.active.has(challengeId) ||
      this.idleQueue.some((item) => item.challenge.id === challengeId) ||
      this.queue.some((item) => item.challenge.id === challengeId)
    )
  }

  private pump(): void {
    if (this.pumping || this.shuttingDown || !this.availability().available) return
    this.pumping = true
    try {
      // maxConcurrent 是本地 Solver/Sandbox 的硬上限。等待远程环境的 Run 仍占用
      // 自己的 Sandbox，因此 active 数永远不会像旧 execution-permit 模型一样膨胀。
      while (this.active.size < this.maxConcurrent && this.availability().available) {
        const index = this.queue.findIndex(
          (item) =>
            !this.resetting.has(item.challenge.id) &&
            (!item.requiresAuto || this.mode !== "stopped") &&
            this.canAdmit(item),
        )
        if (index < 0) break
        const [item] = this.queue.splice(index, 1)
        if (!item) break
        const active: ActiveItem = {
          challenge: item.challenge,
          source: item.source,
          lane: item.lane,
          requiresAuto: item.requiresAuto,
          attempt: item.resumeRun?.attempt ?? this.project.nextAttempt(item.challenge.id),
          phase: "preparing",
          startedAt: new Date().toISOString(),
          runId: null,
          cancelRequested: false,
          queueGeneration: this.queueGeneration,
          ...(item.resumeRun ? { resumeRun: item.resumeRun } : {}),
          ...(item.retryPrompt ? { retryPrompt: item.retryPrompt } : {}),
          ...(item.writeupRetry ? { writeupRetry: true } : {}),
        }
        this.active.set(item.challenge.id, active)
        const operation = this.runItem(active)
          .catch((error: unknown) => {
            this.lastError = errorText(error)
          })
          .finally(() => {
            this.active.delete(item.challenge.id)
            this.pump()
            if (this.mode !== "stopped") void this.reconcile()
          })
        active.operation = operation
      }
    } finally {
      this.pumping = false
    }
  }

  private async runItem(active: ActiveItem): Promise<void> {
    const schedulerAttemptsBefore = this.project.schedulerAttemptCount(active.challenge.id)
    let failureReason: SolverCloseReason | undefined
    let failureMessage: string | undefined
    let retryableFailure = false
    let continuation = active.source === "retry" || active.resumeRun !== undefined
    let solver: CtfSolverAgent | undefined
    let sameRunStops = 0
    let compactRecovery: string | undefined
    let transientRetries = 0
    let transientRetriesExhausted = false
    const transientRetryDelays =
      this.options.transientRetryDelaysMs ?? DEFAULT_TRANSIENT_RETRY_DELAYS_MS

    if (active.lane === "blocked" && this.project.isChallengeBlocked(active.challenge.id)) {
      this.project.reviveChallenge(active.challenge.id)
    }

    while (!active.cancelRequested && !this.shuttingDown) {
      let context: SchedulerAttemptContext | undefined
      try {
        if (!solver) {
          const resumed = active.resumeRun
          active.attempt = resumed?.attempt ?? this.project.nextAttempt(active.challenge.id)
          const source: SchedulerQueueSource = resumed
            ? "retry"
            : continuation
              ? "retry"
              : active.source
          active.source = source
          context = {
            challenge: active.challenge,
            attempt: active.attempt,
            source,
          }
          const agent = await this.options.createAgentOptions(context)
          if (active.cancelRequested) return
          solver = resumed
            ? await this.project.resumeSolver(resumed.id, {
                agent,
                // Supervisor 统一管理 compact 边界，BaseAgent 不得隐式 compact。
                compaction: false,
                writeup: this.options.writeup === true,
                executionGate: this.executionGate(active),
              })
            : await this.project.createSolver(active.challenge.id, {
                agent,
                compaction: false,
                attempt: active.attempt,
                source,
                writeup: this.options.writeup === true,
                executionGate: this.executionGate(active),
              })
          active.resumeRun = undefined
          this.lastError = undefined
          active.solver = solver
          active.runId = solver.runId
          active.phase = "running"
          this.project.removeSchedulerChallenge(active.challenge.id)
          if (active.cancelRequested) {
            await solver.close("cancelled", "在沙箱准备阶段被控制面取消")
            return
          }
          if (active.writeupRetry) {
            active.writeupRetry = false
            const retryPrompt = active.retryPrompt
            active.retryPrompt = undefined
            await this.writeupAfterSubmission(active, solver, retryPrompt)
            return
          }
        }
        const pressure = await solver.contextPressure()
        if (pressure.shouldCompact) {
          const runtime = this.project.challengeRuntimeState(active.challenge.id)
          const eventKey = `${solver.runId}:compact:${this.project.runEvents(solver.runId).length}`
          const canCompact =
            !runtime.blocked && runtime.blockScore + 2 <= runtime.effectiveBlockThreshold
          if (!canCompact) {
            const blockEvent = this.project.recordChallengeBlockEvent({
              challengeId: active.challenge.id,
              runId: solver.runId,
              eventKey,
              delta: 2,
              reason: "context_pressure",
              compactPerformed: false,
            })
            this.project.appendRunEvent(solver.runId, "solver_compaction", {
              eventKey,
              compactPerformed: false,
              scoreAfter: blockEvent.scoreAfter,
            })
            await this.finalizeBlockedRun(
              active,
              solver,
              "Context pressure exceeded the block threshold before compaction",
            )
            solver = undefined
            active.solver = undefined
            return
          }
          try {
            await solver.compact()
          } catch (error) {
            const blockEvent = this.project.recordChallengeBlockEvent({
              challengeId: active.challenge.id,
              runId: solver.runId,
              eventKey,
              delta: 2,
              reason: "compaction_failed",
              compactPerformed: false,
            })
            this.project.appendRunEvent(solver.runId, "block_finalization_failed", {
              eventKey,
              scoreAfter: blockEvent.scoreAfter,
              error: errorText(error),
            })
            await this.finalizeBlockedRun(active, solver, errorText(error))
            solver = undefined
            active.solver = undefined
            return
          }
          const blockEvent = this.project.recordChallengeBlockEvent({
            challengeId: active.challenge.id,
            runId: solver.runId,
            eventKey,
            delta: 2,
            reason: "context_pressure",
            compactPerformed: true,
          })
          this.project.appendRunEvent(solver.runId, "solver_compaction", {
            eventKey,
            compactPerformed: true,
            scoreAfter: blockEvent.scoreAfter,
          })
          compactRecovery = this.project.compactRecoveryPrompt(active.challenge.id, solver.runId)
        }
        const retryPrompt = active.retryPrompt
        active.retryPrompt = undefined
        const nextPrompt =
          retryPrompt ??
          (continuation
            ? INCOMPLETE_CONTINUATION_PROMPT
            : typeof this.options.prompt === "function"
              ? await this.options.prompt(
                  context ?? {
                    challenge: active.challenge,
                    attempt: active.attempt,
                    source: active.source,
                  },
                )
              : (this.options.prompt ?? "Start solving this CTF challenge."))
        const prompt = compactRecovery ? `${compactRecovery}\n\n${nextPrompt}` : nextPrompt
        compactRecovery = undefined
        const promptRunId = solver.runId
        const outcome = await runSolverPrompt({
          solver,
          prompt,
          timeoutMs: this.options.challengeTimeoutMs ?? 30 * 60_000,
          abortGraceMs: this.options.abortGraceMs ?? 5_000,
          pauseTimeout: () =>
            active.phase === "waiting_environment" ||
            this.project.isWaitingForRemoteEnvironment(promptRunId),
        })
        if (outcome.kind === "submitted" || hasTerminalSubmission(solver)) {
          if (this.options.writeup === true) {
            await this.writeupAfterSubmission(active, solver)
          } else {
            await solver.close("submitted")
          }
          return
        }

        const classification = classifySolverStop({
          stopReason: outcome.stopReason,
          ...(outcome.error ? { error: outcome.error } : {}),
          ...(active.cancelRequested ? { operatorCancel: true } : {}),
          ...(this.shuttingDown ? { processShutdown: true } : {}),
        })
        if (
          classification.kind === "operator_cancel" ||
          classification.kind === "process_shutdown"
        ) {
          return
        }
        if (classification.requiresConfiguration) {
          const message = `${classification.kind}: ${classification.detail ?? outcome.stopReason}`
          this.suspend(`LLM 服务需要人工处理: ${message}`)
          this.project.appendRunEvent(solver.runId, "run_transient_failure", {
            retryable: false,
            reason: classification.kind,
            requiresConfiguration: true,
            sameAttempt: true,
          })
          await solver.close("failed", message)
          solver = undefined
          active.solver = undefined
          this.lastError = `${active.challenge.title}: ${message}`
          return
        }
        if (classification.blockDelta === 0) {
          const message = `${classification.kind}: ${classification.detail ?? outcome.stopReason}`
          const retryDelay = transientRetryDelays[transientRetries]
          const retryScheduled = classification.retryable && retryDelay !== undefined
          const requestAborted = isRequestAborted(
            classification.detail ?? outcome.error ?? outcome.stopReason,
          )
          this.project.appendRunEvent(solver.runId, "run_transient_failure", {
            retryable: classification.retryable,
            reason: classification.kind,
            failureNumber: transientRetries + 1,
            retryScheduled,
            retryDelayMs: retryScheduled ? retryDelay : null,
            sameAttempt: true,
          })
          if (retryScheduled) {
            transientRetries++
            continuation = true
            active.phase = "running"
            const elapsed = await this.waitForRetryDelay(active, retryDelay)
            if (!elapsed) return
            continue
          }
          if (requestAborted && classification.retryable) {
            const interruptionCount = this.project.sessionInterruptionCount(active.challenge.id) + 1
            const maximum = this.options.maxSessionInterruptions ?? 3
            const blocked = interruptionCount > maximum
            const recoveryMessage = sessionInterruptionMessage(
              "aborted",
              classification.detail ?? outcome.error,
              interruptionCount,
              maximum,
              blocked,
            )
            await solver.close(blocked ? "blocked" : "interrupted", recoveryMessage)
            solver = undefined
            active.solver = undefined
            retryableFailure = false
            failureReason = blocked ? "blocked" : "interrupted"
            failureMessage = recoveryMessage
            if (blocked) this.lastError = `${active.challenge.title}: ${recoveryMessage}`
            break
          }
          await solver.close("failed", message)
          solver = undefined
          active.solver = undefined
          retryableFailure = false
          transientRetriesExhausted = classification.retryable
          failureReason = "failed"
          failureMessage = message
          if (classification.retryable) break
          this.lastError = `${active.challenge.title}: ${message}`
          return
        }

        sameRunStops += 1
        const interruptionCount =
          this.project.sessionInterruptionCount(active.challenge.id) + sameRunStops
        const maximum = this.options.maxSessionInterruptions ?? 3
        const eventKey = `${solver.runId}:stop:${this.project.runEvents(solver.runId).length}`
        const blockEvent = this.project.recordChallengeBlockEvent({
          challengeId: active.challenge.id,
          runId: solver.runId,
          eventKey,
          delta: classification.blockDelta,
          reason: classification.kind,
          compactPerformed: false,
        })
        this.project.appendRunEvent(solver.runId, "solver_stop", {
          eventKey,
          reason: classification.kind,
          blockDelta: classification.blockDelta,
          blocked: this.project.isChallengeBlocked(active.challenge.id),
        })
        const blocked =
          blockEvent.scoreAfter > blockEvent.threshold ||
          this.project.isChallengeBlocked(active.challenge.id) ||
          interruptionCount > maximum
        const message = sessionInterruptionMessage(
          outcome.stopReason,
          outcome.error,
          interruptionCount,
          maximum,
          blocked,
        )
        if (blocked) {
          await this.finalizeBlockedRun(active, solver, message)
          solver = undefined
          active.solver = undefined
          this.lastError = `${active.challenge.title}: ${message}`
          return
        }
        continuation = true
        active.phase = "running"
      } catch (error) {
        const classification = classifySolverStop({
          error,
          ...(active.cancelRequested ? { operatorCancel: true } : {}),
          ...(error instanceof ChallengeTimeoutError ? { timedOut: true } : {}),
          ...(this.shuttingDown ? { processShutdown: true } : {}),
        })
        retryableFailure = classification.retryable
        failureReason = active.cancelRequested
          ? "cancelled"
          : error instanceof ChallengeTimeoutError
            ? "timed_out"
            : "failed"
        failureMessage = classification.detail ?? errorText(error)
        if (classification.requiresConfiguration) {
          this.suspend(`LLM 服务需要人工处理: ${failureMessage}`)
        }
        if (
          solver &&
          classification.blockDelta === 0 &&
          classification.retryable &&
          !active.cancelRequested &&
          !this.shuttingDown
        ) {
          const retryDelay = transientRetryDelays[transientRetries]
          const retryScheduled = retryDelay !== undefined
          const requestAborted = isRequestAborted(classification.detail ?? errorText(error))
          this.project.appendRunEvent(solver.runId, "run_transient_failure", {
            retryable: true,
            reason: classification.kind,
            failureNumber: transientRetries + 1,
            retryScheduled,
            retryDelayMs: retryScheduled ? retryDelay : null,
            sameAttempt: true,
          })
          if (retryScheduled) {
            transientRetries++
            continuation = true
            failureReason = undefined
            failureMessage = undefined
            retryableFailure = false
            const elapsed = await this.waitForRetryDelay(active, retryDelay)
            if (!elapsed) return
            continue
          }
          if (requestAborted) {
            const interruptionCount = this.project.sessionInterruptionCount(active.challenge.id) + 1
            const maximum = this.options.maxSessionInterruptions ?? 3
            const blocked = interruptionCount > maximum
            const recoveryMessage = sessionInterruptionMessage(
              "aborted",
              classification.detail ?? errorText(error),
              interruptionCount,
              maximum,
              blocked,
            )
            await solver.close(blocked ? "blocked" : "interrupted", recoveryMessage)
            solver = undefined
            active.solver = undefined
            retryableFailure = false
            failureReason = blocked ? "blocked" : "interrupted"
            failureMessage = recoveryMessage
            break
          }
          retryableFailure = false
        }
        if (
          solver &&
          classification.blockDelta === 1 &&
          !active.cancelRequested &&
          !this.shuttingDown
        ) {
          const eventKey = `${solver.runId}:stop:${this.project.runEvents(solver.runId).length}`
          const blockEvent = this.project.recordChallengeBlockEvent({
            challengeId: active.challenge.id,
            runId: solver.runId,
            eventKey,
            delta: classification.blockDelta,
            reason: classification.kind,
            compactPerformed: false,
          })
          this.project.appendRunEvent(solver.runId, "solver_stop", {
            eventKey,
            reason: classification.kind,
            blockDelta: classification.blockDelta,
            blocked: this.project.isChallengeBlocked(active.challenge.id),
          })
          sameRunStops += 1
          const interruptionCount =
            this.project.sessionInterruptionCount(active.challenge.id) + sameRunStops
          const maximum = this.options.maxSessionInterruptions ?? 3
          if (
            blockEvent.scoreAfter <= blockEvent.threshold &&
            !this.project.isChallengeBlocked(active.challenge.id) &&
            interruptionCount <= maximum
          ) {
            continuation = true
            failureReason = undefined
            failureMessage = undefined
            retryableFailure = false
            continue
          }
          failureReason = "blocked"
          failureMessage = sessionInterruptionMessage(
            classification.kind,
            failureMessage,
            interruptionCount,
            maximum,
            true,
          )
        }
        if (failureReason === "blocked" && solver && !solver.isClosed) {
          await this.finalizeBlockedRun(active, solver, failureMessage ?? "blocked")
          solver = undefined
        } else if (solver && !solver.isClosed) {
          await solver.close(failureReason, failureMessage)
          solver = undefined
        }
        break
      } finally {
        if (!solver) active.solver = undefined
      }
    }

    if (active.cancelRequested || this.shuttingDown) return

    const schedulerAttemptsAfter = this.project.schedulerAttemptCount(active.challenge.id)
    const recoverableRun = latestRecoverableRuns(this.project.runs()).get(active.challenge.id)
    const resumeRun =
      active.runId && recoverableRun?.id === active.runId ? recoverableRun : undefined
    const canResumeRun = resumeRun !== undefined && !hasRunResumed(this.project, resumeRun.id)
    if (
      failureReason !== "cancelled" &&
      failureReason !== "blocked" &&
      (canResumeRun ||
        (resumeRun === undefined &&
          (retryableFailure || schedulerAttemptsAfter > schedulerAttemptsBefore))) &&
      !this.shuttingDown &&
      this.availability().available &&
      active.queueGeneration === this.queueGeneration &&
      // 瞬时 Provider 故障已经在同一个 Run 内完成有限次退避重试；恢复
      // 原 Run 同样只占用一次 attempt 预算，且同一个 Run 自动恢复一次后
      // 不再无限循环。没有可恢复 Run 的创建失败仍受 attempt 预算约束。
      schedulerAttemptsAfter < (this.options.maxAttempts ?? 2) &&
      !this.project.isChallengeSolved(active.challenge.id) &&
      !this.project.isChallengeBlocked(active.challenge.id)
    ) {
      if (failureMessage) {
        this.lastError = `${active.challenge.title}: ${failureMessage}（等待重试）`
      }
      const configuredDelay = this.options.retryDelayMs ?? 2_000
      const delay = retryableFailure
        ? Math.max(
            this.options.infrastructureRetryDelayMs ?? 15_000,
            configuredDelay,
            ...(transientRetriesExhausted ? [transientRetryDelays.at(-1) ?? 0] : []),
          )
        : configuredDelay
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
      if (
        !active.cancelRequested &&
        !this.shuttingDown &&
        active.queueGeneration === this.queueGeneration &&
        !this.queue.some((item) => item.challenge.id === active.challenge.id)
      ) {
        this.enqueueChallenge(
          active.challenge,
          "retry",
          "execution",
          active.lane,
          false,
          active.requiresAuto,
          resumeRun ? { resumeRun } : undefined,
        )
      }
    } else if (failureMessage && failureReason !== "cancelled") {
      this.lastError = `${active.challenge.title}: ${failureMessage}`
    }
  }

  private async writeupAfterSubmission(
    active: ActiveItem,
    solver: CtfSolverAgent,
    retryPrompt?: string,
  ): Promise<void> {
    await solver.prepareWriteup()
    await this.project.markRunWritingWriteup(solver.runId)
    let prompt = retryPrompt
      ? `${WRITEUP_PROMPT}\n\nAdditional instructions:\n${retryPrompt}`
      : WRITEUP_PROMPT
    let lastErrors: string[] = []
    for (let attempt = 0; attempt < 3; attempt++) {
      const outcome = await runSolverPrompt({
        solver,
        prompt,
        timeoutMs: Math.min(this.options.challengeTimeoutMs ?? 120_000, 120_000),
        abortGraceMs: this.options.abortGraceMs ?? 5_000,
        ignoreExistingSubmission: true,
      })
      if (outcome.kind === "submitted") {
        lastErrors = ["writeup turn attempted another submission"]
      } else {
        const validation = await validateChallengeWriteup(solver.workspace)
        if (validation.valid) {
          await solver.close("submitted")
          return
        }
        lastErrors = validation.errors
        this.project.appendRunEvent(solver.runId, "writeup_validation_failed", {
          attempt: attempt + 1,
          errors: validation.errors,
          path: validation.path,
        })
      }
      prompt = [
        "The writeup validation failed. Fix /workspace/writeup.md and do not submit another flag.",
        `Validation errors: ${lastErrors.join("; ")}`,
        "Use the read/write/edit tools only, then finish the writeup turn.",
      ].join("\n")
      if (outcome.stopReason === "error" || outcome.stopReason === "aborted") {
        break
      }
    }
    const error = `writeup validation failed: ${lastErrors.join("; ")}`
    this.project.appendRunEvent(solver.runId, "writeup_failed", {
      challengeId: active.challenge.id,
      errors: lastErrors,
    })
    await solver.close("submitted", error)
  }

  private async finalizeBlockedRun(
    active: ActiveItem,
    solver: CtfSolverAgent,
    trigger: string,
  ): Promise<void> {
    let finalizationError: string | undefined
    try {
      this.project.forceChallengeBlocked({
        challengeId: active.challenge.id,
        runId: solver.runId,
      })
      await this.project.markRunBlocking(solver.runId, trigger)
      const records = await this.project.finalizeSubagents(
        solver.runId,
        "Report your current objective, verified findings, attempted experiments, exact results, artifacts, and next-step recommendation. Terminate processes you started and remove disposable temporary files; list the exact path and purpose of every retained artifact. Stop investigating after this report.",
        30_000,
      )
      const outcome = await runSolverPrompt({
        solver,
        // 收尾指令和 SubAgent 快照属于同一轮，但必须有独立根节点，
        // 否则 WebUI 会把整条消息误识别为 active_subagents 卡片。
        prompt: [
          "<blocked_finalization>",
          activeSubagentsPrompt(shortSubagentPage(solver.runId, records)),
          BLOCKED_FINALIZATION_PROMPT,
          "</blocked_finalization>",
        ].join("\n\n"),
        timeoutMs: Math.min(this.options.challengeTimeoutMs ?? 30_000, 30_000),
        abortGraceMs: this.options.abortGraceMs ?? 5_000,
      })
      if (outcome.kind === "submitted" || hasTerminalSubmission(solver)) {
        await solver.close("submitted")
        return
      }
      if (outcome.stopReason === "error" || outcome.stopReason === "aborted") {
        finalizationError = outcome.error ?? `Final turn stopped: ${outcome.stopReason}`
        this.project.appendRunEvent(solver.runId, "block_finalization_failed", {
          trigger,
          error: finalizationError,
        })
      }
    } catch (error) {
      finalizationError = errorText(error)
      try {
        this.project.appendRunEvent(solver.runId, "block_finalization_failed", {
          trigger,
          error: finalizationError,
        })
      } catch {
        // 保留原始收尾错误，close callback 仍会持久化 Run 终态。
      }
    }
    await solver.close("blocked", finalizationError ?? trigger)
  }

  private enqueueChallenge(
    challenge: ChallengeSummary,
    source: SchedulerQueueSource,
    stage: SchedulerQueueStage,
    lane: "normal" | "blocked",
    manualOverride: boolean,
    requiresAuto: boolean,
    options: { resumeRun?: RunRecord } = {},
  ): void {
    if (
      this.idleQueue.some((item) => item.challenge.id === challenge.id) ||
      this.queue.some((item) => item.challenge.id === challenge.id)
    ) {
      return
    }
    const persisted = this.project.enqueueSchedulerChallenge({
      challengeId: challenge.id,
      source,
      stage,
      lane,
      manualOverride,
    })
    const item: QueueItem = {
      challenge,
      source,
      stage,
      lane,
      manualOverride,
      requiresAuto,
      enqueuedAt: persisted.enqueuedAt,
      version: persisted.version,
      persisted: true,
      ...(options.resumeRun ? { resumeRun: options.resumeRun } : {}),
    }
    const target = stage === "idle" ? this.idleQueue : this.queue
    if (manualOverride) target.unshift(item)
    else target.push(item)
  }

  private promoteIdleInMemory(): void {
    for (const item of this.idleQueue.splice(0)) {
      item.stage = "execution"
      item.requiresAuto = true
      this.queue.push(item)
    }
    this.syncPersistedQueueMetadata(this.project.schedulerQueue("execution"))
  }

  private canAdmit(item: QueueItem): boolean {
    // 本地题和有附件题不消耗“预期远程槽”，可在平台实例已满时继续利用 Sandbox。
    if (item.challenge.needsEnv === false || item.challenge.hasAttachments === true) return true

    // 无附件环境题（以及平台无法判定的保守项）在创建 Sandbox 前先预留远程意图。
    // 不能只看协调器当前 occupied：同一轮 pump 内，刚启动的 Solver 尚未来得及调用
    // ctf_instance_start，否则仍会瞬间创建 maxConcurrent 个等环境的容器。
    const capacity = this.project.remoteEnvironmentCapacity()
    const admittedRemoteOnly = [...this.active.values()].filter(
      (active) => active.challenge.needsEnv !== false && active.challenge.hasAttachments !== true,
    ).length
    const available = Math.max(capacity.occupied, admittedRemoteOnly) < capacity.maximum
    if (!available && item.challenge.needsEnv === undefined) {
      this.discoverSchedulingHint(item)
    }
    return available
  }

  private discoverSchedulingHint(item: QueueItem): void {
    if (
      this.discoveringAdmission ||
      (this.admissionDiscoveryRetryAt.get(item.challenge.id) ?? 0) > Date.now()
    ) {
      return
    }
    this.discoveringAdmission = true
    void this.project
      .challengeSchedulingHint(item.challenge.id)
      .then((hint) => {
        this.admissionDiscoveryRetryAt.delete(item.challenge.id)
        Object.assign(item.challenge, hint)
      })
      .catch((error: unknown) => {
        this.admissionDiscoveryRetryAt.set(item.challenge.id, Date.now() + 30_000)
        this.lastError = `${item.challenge.title}: 无法读取调度提示：${errorText(error)}`
      })
      .finally(() => {
        this.discoveringAdmission = false
        this.pump()
      })
  }

  private executionGate(active: ActiveItem): NonNullable<CreateSolverOptions["executionGate"]> {
    return {
      suspend: () => this.suspendExecutionForEnvironment(active),
      resume: async (signal) => await this.resumeExecutionAfterEnvironment(active, signal),
    }
  }

  private suspendExecutionForEnvironment(active: ActiveItem): void {
    if (active.cancelRequested || this.shuttingDown) throw abortError("调度任务已取消")
    active.phase = "waiting_environment"
  }

  private async resumeExecutionAfterEnvironment(
    active: ActiveItem,
    signal?: AbortSignal,
  ): Promise<void> {
    if (
      active.cancelRequested ||
      this.shuttingDown ||
      signal?.aborted ||
      this.active.get(active.challenge.id) !== active
    ) {
      throw abortError("调度任务已取消")
    }
    active.phase = "running"
  }

  private waitForRetryDelay(active: ActiveItem, delayMs: number): Promise<boolean> {
    if (active.cancelRequested || this.shuttingDown) return Promise.resolve(false)
    if (delayMs === 0) {
      return Promise.resolve(true)
    }
    return new Promise((resolve) => {
      let settled = false
      const finish = (elapsed: boolean) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        if (active.cancelRetryDelay === cancel) {
          active.cancelRetryDelay = undefined
        }
        resolve(elapsed)
      }
      const timeout = setTimeout(() => finish(true), delayMs)
      const cancel = () => finish(false)
      active.cancelRetryDelay = cancel
    })
  }

  private assertAvailable(): void {
    const availability = this.availability()
    if (availability.available) return
    throw new ContestSchedulerError("unavailable", availability.unavailableReason ?? "调度器未配置")
  }

  private availability(): SchedulerAvailability {
    if (this.suspensionReason) {
      return {
        available: false,
        unavailableReason: this.suspensionReason,
      }
    }
    return (
      this.options.availability?.() ?? {
        available: this.options.available ?? true,
        ...(this.options.unavailableReason
          ? { unavailableReason: this.options.unavailableReason }
          : {}),
      }
    )
  }

  private assertPlanningStopped(): void {
    if (this.mode === "stopped") return
    throw new ContestSchedulerError("scheduler_running", "请先暂停调度，再修改空闲队列")
  }

  private assertNotShuttingDown(): void {
    if (this.shuttingDown) throw new Error("调度器正在关闭")
  }
}

function deduplicate(challenges: readonly ChallengeSummary[]): ChallengeSummary[] {
  const unique = new Map<string, ChallengeSummary>()
  for (const challenge of challenges)
    if (!unique.has(challenge.id)) unique.set(challenge.id, challenge)
  return [...unique.values()]
}

function latestRecoverableInterruptedRuns(runs: readonly RunRecord[]): Map<string, RunRecord> {
  return latestRecoverableRuns(runs.filter((run) => run.status === "interrupted"))
}

/**
 * 所有非 blocked 的调度终态都可以沿用原 attempt 与 JSONL session。
 * 这既覆盖进程退出产生的 interrupted，也覆盖人工取消、超时和普通失败；
 * blocked 是唯一不自动恢复的终态。
 */
function latestRecoverableRun(runs: readonly RunRecord[]): RunRecord | undefined {
  const latest = [...runs].sort(compareRunOrder).at(-1)
  return latest && isRecoverableRun(latest) ? latest : undefined
}

function latestRecoverableRuns(runs: readonly RunRecord[]): Map<string, RunRecord> {
  const candidates = runs.filter(isRecoverableRun).sort(compareRunOrder)
  return new Map(candidates.map((run) => [run.challengeId, run]))
}

function isRecoverableRun(run: RunRecord): boolean {
  return (
    RECOVERABLE_TERMINAL_RUN_STATUSES.has(run.status) &&
    run.closeReason !== "blocked" &&
    RECOVERABLE_SCHEDULER_RUN_SOURCES.has(run.source)
  )
}

function compareRunOrder(left: RunRecord, right: RunRecord): number {
  return left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id)
}

function hasRunResumed(project: Project, runId: string): boolean {
  return project.runEvents(runId).some((event) => event.type === "run_resumed")
}

const RETRYABLE_RUN_STATUSES = new Set<RunRecord["status"]>([
  "failed",
  "timed_out",
  "cancelled",
  "closed",
  "interrupted",
  "blocked",
])

function positiveInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${field} 必须是正整数`)
}

function nonNegativeInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${field} 必须是非负整数`)
}

function isRequestAborted(detail: string | undefined): boolean {
  return (
    /\b(?:request|operation)(?: was)? aborted\b/i.test(detail ?? "") ||
    /^\s*aborted\s*$/i.test(detail ?? "")
  )
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function abortError(message: string): Error {
  return Object.assign(new Error(message), { name: "AbortError" })
}
