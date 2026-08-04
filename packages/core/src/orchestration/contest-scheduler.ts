import type { CtfSolverAgent, SolverCloseReason } from "@ctf-agent/agents"
import type { ChallengeSummary } from "@ctf-agent/platform"
import type { AgentOptions } from "@earendil-works/pi-agent-core"
import type { RunSource } from "../persistence/run-store.ts"
import type { CreateSolverOptions, Project } from "../project/project.ts"
import {
  ChallengeTimeoutError,
  hasTerminalSubmission,
  latestAgentError,
  runSolverPrompt,
} from "./solver-attempt.ts"

export type SchedulerQueueSource = Extract<
  RunSource,
  "auto" | "manual" | "retry"
>
export type SchedulerPhase = "preparing" | "running" | "cancelling"

export interface ContestSchedulerOptions {
  maxConcurrent: number
  maxAttempts?: number
  challengeTimeoutMs?: number
  abortGraceMs?: number
  retryDelayMs?: number
  createAgentOptions(
    context: SchedulerAttemptContext,
  ): AgentOptions | Promise<AgentOptions>
  compaction?: CreateSolverOptions["compaction"]
  prompt?:
    | string
    | ((context: SchedulerAttemptContext) => string | Promise<string>)
  availability?: () => SchedulerAvailability
  available?: boolean
  unavailableReason?: string
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
  enqueuedAt: string
  position: number
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
  autoEnabled: boolean
  maxConcurrent: number
  maxAttempts: number
  queued: SchedulerQueueEntry[]
  active: SchedulerActiveEntry[]
  lastError?: string
}

export class ContestSchedulerError extends Error {
  constructor(
    readonly code:
      | "unavailable"
      | "challenge_not_found"
      | "already_queued"
      | "already_active"
      | "already_solved"
      | "attempts_exhausted",
    message: string,
  ) {
    super(message)
    this.name = "ContestSchedulerError"
  }
}

interface QueueItem {
  challenge: ChallengeSummary
  source: SchedulerQueueSource
  requiresAuto: boolean
  enqueuedAt: string
}

interface ActiveItem {
  challenge: ChallengeSummary
  source: SchedulerQueueSource
  requiresAuto: boolean
  attempt: number
  phase: SchedulerPhase
  startedAt: string
  runId: string | null
  solver?: CtfSolverAgent
  cancelRequested: boolean
  operation?: Promise<void>
}

const DEFAULT_PROMPT =
  "解决当前 CTF 题目。获取题目信息和附件，必要时启动远程实例，找到并提交 Flag。"

/**
 * 长驻的混合调度控制面：
 * - 自动模式把所有未解题目加入队列；
 * - 暂停自动模式时人工任务仍可运行；
 * - 同题在 queued/active 阶段互斥；
 * - 失败按调度来源计入重试预算，direct/test Run 不消耗预算。
 */
export class ContestScheduler {
  private readonly queue: QueueItem[] = []
  private readonly active = new Map<string, ActiveItem>()
  private autoEnabled = false
  private shuttingDown = false
  private pumping = false
  private lastError?: string

  constructor(
    private readonly project: Project,
    private readonly options: ContestSchedulerOptions,
  ) {
    positiveInteger(options.maxConcurrent, "maxConcurrent")
    positiveInteger(options.maxAttempts ?? 2, "maxAttempts")
    positiveInteger(
      options.challengeTimeoutMs ?? 30 * 60_000,
      "challengeTimeoutMs",
    )
    nonNegativeInteger(options.abortGraceMs ?? 5_000, "abortGraceMs")
    nonNegativeInteger(options.retryDelayMs ?? 2_000, "retryDelayMs")
  }

  snapshot(): ContestSchedulerSnapshot {
    const availability = this.availability()
    return {
      available: availability.available,
      ...(availability.unavailableReason
        ? { unavailableReason: availability.unavailableReason }
        : {}),
      autoEnabled: this.autoEnabled,
      maxConcurrent: this.options.maxConcurrent,
      maxAttempts: this.options.maxAttempts ?? 2,
      queued: this.queue.map((item, index) => ({
        challengeId: item.challenge.id,
        source: item.source,
        enqueuedAt: item.enqueuedAt,
        position: index + 1,
      })),
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

  async startAuto(): Promise<ContestSchedulerSnapshot> {
    this.assertAvailable()
    this.assertNotShuttingDown()
    this.autoEnabled = true
    await this.reconcile()
    this.pump()
    return this.snapshot()
  }

  pauseAuto(): ContestSchedulerSnapshot {
    this.autoEnabled = false
    return this.snapshot()
  }

  async reconcile(): Promise<ContestSchedulerSnapshot> {
    if (
      !this.autoEnabled ||
      this.shuttingDown ||
      !this.availability().available
    ) {
      return this.snapshot()
    }
    await this.project.refresh()
    const challenges = deduplicate(await this.project.challenges())
    for (const challenge of challenges) {
      if (challenge.solved || this.project.isChallengeSolved(challenge.id))
        continue
      if (this.hasChallenge(challenge.id)) continue
      if (
        this.project.schedulerAttemptCount(challenge.id) >=
        (this.options.maxAttempts ?? 2)
      ) {
        continue
      }
      this.queue.push({
        challenge,
        source: "auto",
        requiresAuto: true,
        enqueuedAt: new Date().toISOString(),
      })
    }
    this.pump()
    return this.snapshot()
  }

  async dispatch(
    challengeId: string,
    options: { force?: boolean } = {},
  ): Promise<ContestSchedulerSnapshot> {
    this.assertAvailable()
    this.assertNotShuttingDown()
    if (this.active.has(challengeId)) {
      throw new ContestSchedulerError(
        "already_active",
        "该题已有正在运行的 Agent",
      )
    }
    if (this.queue.some((item) => item.challenge.id === challengeId)) {
      throw new ContestSchedulerError("already_queued", "该题已经在调度队列中")
    }
    await this.project.refresh()
    const challenge = (await this.project.challenges()).find(
      (candidate) => candidate.id === challengeId,
    )
    if (!challenge) {
      throw new ContestSchedulerError(
        "challenge_not_found",
        `平台不存在题目: ${challengeId}`,
      )
    }
    const solved =
      challenge.solved || this.project.isChallengeSolved(challengeId)
    if (solved && !options.force) {
      throw new ContestSchedulerError(
        "already_solved",
        "该题已经解出；重新验证需要显式 force",
      )
    }
    const attempts = this.project.schedulerAttemptCount(challengeId)
    if (attempts >= (this.options.maxAttempts ?? 2) && !options.force) {
      throw new ContestSchedulerError(
        "attempts_exhausted",
        `该题调度尝试已达到上限 ${this.options.maxAttempts ?? 2}`,
      )
    }
    this.queue.push({
      challenge,
      source: "manual",
      requiresAuto: false,
      enqueuedAt: new Date().toISOString(),
    })
    this.pump()
    return this.snapshot()
  }

  async cancel(challengeId: string): Promise<ContestSchedulerSnapshot> {
    const queueIndex = this.queue.findIndex(
      (item) => item.challenge.id === challengeId,
    )
    if (queueIndex >= 0) {
      this.queue.splice(queueIndex, 1)
      return this.snapshot()
    }
    const active = this.active.get(challengeId)
    if (!active) return this.snapshot()
    active.cancelRequested = true
    active.phase = "cancelling"
    active.solver?.abort()
    if (active.solver) await active.solver.close("cancelled", "由控制面取消")
    await active.operation?.catch(() => undefined)
    return this.snapshot()
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) {
      await Promise.allSettled(
        [...this.active.values()]
          .map((item) => item.operation)
          .filter(
            (operation): operation is Promise<void> => operation !== undefined,
          ),
      )
      return
    }
    this.shuttingDown = true
    this.autoEnabled = false
    this.queue.length = 0
    const active = [...this.active.values()]
    for (const item of active) {
      item.cancelRequested = true
      item.phase = "cancelling"
      item.solver?.abort()
    }
    await Promise.allSettled(
      active.map(async (item) => {
        if (item.solver) await item.solver.close("cancelled", "调度控制面关闭")
        await item.operation
      }),
    )
  }

  private hasChallenge(challengeId: string): boolean {
    return (
      this.active.has(challengeId) ||
      this.queue.some((item) => item.challenge.id === challengeId)
    )
  }

  private pump(): void {
    if (this.pumping || this.shuttingDown || !this.availability().available)
      return
    this.pumping = true
    try {
      while (
        this.active.size < this.options.maxConcurrent &&
        this.availability().available
      ) {
        const index = this.queue.findIndex(
          (item) => !item.requiresAuto || this.autoEnabled,
        )
        if (index < 0) break
        const [item] = this.queue.splice(index, 1)
        if (!item) break
        const active: ActiveItem = {
          challenge: item.challenge,
          source: item.source,
          requiresAuto: item.requiresAuto,
          attempt: this.project.nextAttempt(item.challenge.id),
          phase: "preparing",
          startedAt: new Date().toISOString(),
          runId: null,
          cancelRequested: false,
        }
        this.active.set(item.challenge.id, active)
        const operation = this.runItem(active)
          .catch((error: unknown) => {
            this.lastError = errorText(error)
          })
          .finally(() => {
            this.active.delete(item.challenge.id)
            this.pump()
          })
        active.operation = operation
      }
    } finally {
      this.pumping = false
    }
  }

  private async runItem(active: ActiveItem): Promise<void> {
    let solver: CtfSolverAgent | undefined
    const schedulerAttemptsBefore = this.project.schedulerAttemptCount(
      active.challenge.id,
    )
    let failureReason: SolverCloseReason | undefined
    let failureMessage: string | undefined
    try {
      const context: SchedulerAttemptContext = {
        challenge: active.challenge,
        attempt: active.attempt,
        source: active.source,
      }
      const agent = await this.options.createAgentOptions(context)
      if (active.cancelRequested) return
      solver = await this.project.createSolver(active.challenge.id, {
        agent,
        compaction: this.options.compaction,
        attempt: active.attempt,
        source: active.source,
      })
      active.solver = solver
      active.runId = solver.runId
      active.phase = "running"
      if (active.cancelRequested) {
        await solver.close("cancelled", "在沙箱准备阶段被控制面取消")
        return
      }
      const prompt =
        typeof this.options.prompt === "function"
          ? await this.options.prompt(context)
          : (this.options.prompt ?? DEFAULT_PROMPT)
      await runSolverPrompt({
        solver,
        prompt,
        timeoutMs: this.options.challengeTimeoutMs ?? 30 * 60_000,
        abortGraceMs: this.options.abortGraceMs ?? 5_000,
      })
      if (hasTerminalSubmission(solver)) {
        await solver.close("submitted")
        return
      }
      throw new Error(
        (await latestAgentError(solver)) ?? "Agent 已结束，但没有提交正确 Flag",
      )
    } catch (error) {
      failureReason = active.cancelRequested
        ? "cancelled"
        : error instanceof ChallengeTimeoutError
          ? "timed_out"
          : "failed"
      failureMessage = errorText(error)
      if (solver) await solver.close(failureReason, failureMessage)
    } finally {
      active.solver = undefined
    }

    if (
      failureReason !== "cancelled" &&
      this.project.schedulerAttemptCount(active.challenge.id) >
        schedulerAttemptsBefore &&
      !this.shuttingDown &&
      this.project.schedulerAttemptCount(active.challenge.id) <
        (this.options.maxAttempts ?? 2) &&
      !this.project.isChallengeSolved(active.challenge.id)
    ) {
      const delay = this.options.retryDelayMs ?? 2_000
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
      if (
        !this.queue.some((item) => item.challenge.id === active.challenge.id)
      ) {
        this.queue.push({
          challenge: active.challenge,
          source: "retry",
          requiresAuto: active.requiresAuto,
          enqueuedAt: new Date().toISOString(),
        })
      }
    } else if (failureMessage && failureReason !== "cancelled") {
      this.lastError = `${active.challenge.title}: ${failureMessage}`
    }
  }

  private assertAvailable(): void {
    const availability = this.availability()
    if (availability.available) return
    throw new ContestSchedulerError(
      "unavailable",
      availability.unavailableReason ?? "调度器未配置",
    )
  }

  private availability(): SchedulerAvailability {
    return (
      this.options.availability?.() ?? {
        available: this.options.available ?? true,
        ...(this.options.unavailableReason
          ? { unavailableReason: this.options.unavailableReason }
          : {}),
      }
    )
  }

  private assertNotShuttingDown(): void {
    if (this.shuttingDown) throw new Error("调度器正在关闭")
  }
}

function deduplicate(
  challenges: readonly ChallengeSummary[],
): ChallengeSummary[] {
  const unique = new Map<string, ChallengeSummary>()
  for (const challenge of challenges)
    if (!unique.has(challenge.id)) unique.set(challenge.id, challenge)
  return [...unique.values()]
}

function positiveInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value <= 0)
    throw new Error(`${field} 必须是正整数`)
}

function nonNegativeInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0)
    throw new Error(`${field} 必须是非负整数`)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
