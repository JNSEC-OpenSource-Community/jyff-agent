import {
  BLOCKED_FINALIZATION_PROMPT,
  type CtfSolverAgent,
  type SolverCloseReason,
} from "@ctf-agent/agents"
import type { ChallengeSummary } from "@ctf-agent/platform"
import type { AgentOptions } from "@earendil-works/pi-agent-core"
import { activeSubagentsPrompt } from "../../prompts/project.ts"
import {
  INCOMPLETE_CONTINUATION_PROMPT,
  WRITEUP_PROMPT,
} from "../../prompts/solver-attempt.ts"
import type {
  RunSource,
  SchedulerQueueRecord,
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

export type SchedulerQueueSource = Extract<
  RunSource,
  "auto" | "manual" | "retry" | "revival"
>
export type SchedulerPhase = "preparing" | "running" | "cancelling"

export interface ContestSchedulerOptions {
  maxConcurrent: number
  maxAttempts?: number
  maxSessionInterruptions?: number
  challengeTimeoutMs?: number
  abortGraceMs?: number
  retryDelayMs?: number
  infrastructureRetryDelayMs?: number
  /** Flag accepted 后执行 writeup turn；生产调度应开启。 */
  writeup?: boolean
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
  autoEnabled: boolean
  maxConcurrent: number
  maxAttempts: number
  maxSessionInterruptions: number
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
      | "attempts_exhausted"
      | "blocked"
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
  lane: "normal" | "blocked"
  manualOverride: boolean
  requiresAuto: boolean
  enqueuedAt: string
  version: number
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
}

const DEFAULT_PROMPT =
  "Solve the current CTF challenge. Inspect the initial challenge data and downloaded attachments, start the remote instance when necessary, and find and submit the flag. Keep executing concrete analysis and validation rather than ending with an unexecuted plan. Continue using tools unless the correct flag is accepted or an external blocker cannot be bypassed."

/**
 * 长驻的混合调度控制面：
 * - 自动模式把所有未解题目加入队列；
 * - 暂停自动模式会清空全部等待任务，但不会取消已经运行的任务；
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
  private maxConcurrent: number
  private queueGeneration = 0

  constructor(
    private readonly project: Project,
    private readonly options: ContestSchedulerOptions,
  ) {
    positiveInteger(options.maxConcurrent, "maxConcurrent")
    this.maxConcurrent = options.maxConcurrent
    positiveInteger(options.maxAttempts ?? 2, "maxAttempts")
    positiveInteger(
      options.maxSessionInterruptions ?? 3,
      "maxSessionInterruptions",
    )
    positiveInteger(
      options.challengeTimeoutMs ?? 30 * 60_000,
      "challengeTimeoutMs",
    )
    nonNegativeInteger(options.abortGraceMs ?? 5_000, "abortGraceMs")
    nonNegativeInteger(options.retryDelayMs ?? 2_000, "retryDelayMs")
    nonNegativeInteger(
      options.infrastructureRetryDelayMs ?? 15_000,
      "infrastructureRetryDelayMs",
    )
  }

  snapshot(): ContestSchedulerSnapshot {
    const availability = this.availability()
    return {
      available: availability.available,
      ...(availability.unavailableReason
        ? { unavailableReason: availability.unavailableReason }
        : {}),
      autoEnabled: this.autoEnabled,
      maxConcurrent: this.maxConcurrent,
      maxAttempts: this.options.maxAttempts ?? 2,
      maxSessionInterruptions: this.options.maxSessionInterruptions ?? 3,
      queued: this.queue.map((item, index) => ({
        challengeId: item.challenge.id,
        source: item.source,
        lane: item.lane,
        manualOverride: item.manualOverride,
        enqueuedAt: item.enqueuedAt,
        position: index + 1,
        version: item.version,
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
    this.queueGeneration += 1
    for (const item of this.queue)
      this.project.removeSchedulerChallenge(item.challenge.id)
    this.queue.length = 0
    return this.snapshot()
  }

  async setMaxConcurrent(
    maxConcurrent: number,
  ): Promise<ContestSchedulerSnapshot> {
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
    if (
      !this.autoEnabled ||
      this.shuttingDown ||
      !this.availability().available
    ) {
      return this.snapshot()
    }
    await this.project.refresh()
    const challenges = deduplicate(await this.project.challenges())
    const byId = new Map(
      challenges.map((challenge) => [challenge.id, challenge]),
    )

    for (const persisted of this.project.schedulerQueue()) {
      const challenge = byId.get(persisted.challengeId)
      if (
        !challenge ||
        challenge.solved ||
        this.project.isChallengeSolved(persisted.challengeId)
      ) {
        this.project.removeSchedulerChallenge(persisted.challengeId)
        continue
      }
      if (this.hasChallenge(persisted.challengeId)) continue
      this.queue.push({
        challenge,
        source: persisted.source as SchedulerQueueSource,
        lane: persisted.lane,
        manualOverride: persisted.manualOverride,
        requiresAuto:
          persisted.source !== "manual" && !persisted.manualOverride,
        enqueuedAt: persisted.enqueuedAt,
        version: persisted.version,
      })
    }

    for (const challenge of challenges) {
      if (
        challenge.solved ||
        this.project.isChallengeSolved(challenge.id) ||
        this.project.isChallengeBlocked(challenge.id) ||
        this.hasChallenge(challenge.id)
      ) {
        continue
      }
      this.enqueueChallenge(challenge, "auto", "normal", false, true)
    }

    const ordinaryOutstanding = challenges.some(
      (challenge) =>
        !challenge.solved &&
        !this.project.isChallengeSolved(challenge.id) &&
        !this.project.isChallengeBlocked(challenge.id),
    )
    if (!ordinaryOutstanding) {
      const blocked = challenges
        .filter(
          (challenge) =>
            !challenge.solved &&
            this.project.isChallengeBlocked(challenge.id) &&
            !this.hasChallenge(challenge.id),
        )
        .sort((left, right) => {
          const leftAt =
            this.project.challengeRuntimeState(left.id).blockedAt ?? ""
          const rightAt =
            this.project.challengeRuntimeState(right.id).blockedAt ?? ""
          return (
            leftAt.localeCompare(rightAt) || left.id.localeCompare(right.id)
          )
        })
      for (const challenge of blocked) {
        this.enqueueChallenge(challenge, "revival", "blocked", false, true)
      }
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
    const blocked = this.project.isChallengeBlocked(challengeId)
    if (blocked && !options.force) {
      throw new ContestSchedulerError(
        "blocked",
        "该题已 blocked；需要人工 force 将其提前到调度队列",
      )
    }
    this.enqueueChallenge(
      challenge,
      blocked ? "revival" : "manual",
      blocked ? "blocked" : "normal",
      blocked,
      false,
    )
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
    const item = this.queue.find(
      (candidate) => candidate.challenge.id === challengeId,
    )
    if (!item) {
      throw new ContestSchedulerError(
        "challenge_not_found",
        `题目不在调度队列中: ${challengeId}`,
      )
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
        throw new ContestSchedulerError(
          "queue_version_conflict",
          errorText(error),
        )
      }
      throw error
    }
    item.manualOverride = moved.manualOverride
    item.version = moved.version
    item.requiresAuto = item.requiresAuto && !moved.manualOverride
    const order = new Map(
      this.project
        .schedulerQueue()
        .map((record, index) => [record.challengeId, index]),
    )
    this.queue.sort(
      (left, right) =>
        (order.get(left.challenge.id) ?? Number.MAX_SAFE_INTEGER) -
        (order.get(right.challenge.id) ?? Number.MAX_SAFE_INTEGER),
    )
    this.pump()
    return this.snapshot()
  }

  async cancel(challengeId: string): Promise<ContestSchedulerSnapshot> {
    const queueIndex = this.queue.findIndex(
      (item) => item.challenge.id === challengeId,
    )
    if (queueIndex >= 0) {
      this.queue.splice(queueIndex, 1)
      this.project.removeSchedulerChallenge(challengeId)
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
        this.active.size < this.maxConcurrent &&
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
          lane: item.lane,
          requiresAuto: item.requiresAuto,
          attempt: this.project.nextAttempt(item.challenge.id),
          phase: "preparing",
          startedAt: new Date().toISOString(),
          runId: null,
          cancelRequested: false,
          queueGeneration: this.queueGeneration,
        }
        this.active.set(item.challenge.id, active)
        const operation = this.runItem(active)
          .catch((error: unknown) => {
            this.lastError = errorText(error)
          })
          .finally(() => {
            this.active.delete(item.challenge.id)
            if (this.autoEnabled) void this.reconcile()
            else this.pump()
          })
        active.operation = operation
      }
    } finally {
      this.pumping = false
    }
  }

  private async runItem(active: ActiveItem): Promise<void> {
    const schedulerAttemptsBefore = this.project.schedulerAttemptCount(
      active.challenge.id,
    )
    let failureReason: SolverCloseReason | undefined
    let failureMessage: string | undefined
    let retryableFailure = false
    let continuation = active.source === "retry"
    let solver: CtfSolverAgent | undefined
    let sameRunStops = 0

    if (
      active.lane === "blocked" &&
      this.project.isChallengeBlocked(active.challenge.id)
    ) {
      this.project.reviveChallenge(active.challenge.id)
    }

    while (!active.cancelRequested && !this.shuttingDown) {
      let context: SchedulerAttemptContext | undefined
      try {
        if (!solver) {
          active.attempt = this.project.nextAttempt(active.challenge.id)
          const source: SchedulerQueueSource = continuation
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
          solver = await this.project.createSolver(active.challenge.id, {
            agent,
            // Supervisor 统一管理 compact 边界，BaseAgent 不得隐式 compact。
            compaction: false,
            attempt: active.attempt,
            source,
            writeup: this.options.writeup === true,
          })
          this.lastError = undefined
          active.solver = solver
          active.runId = solver.runId
          active.phase = "running"
          this.project.removeSchedulerChallenge(active.challenge.id)
          if (active.cancelRequested) {
            await solver.close("cancelled", "在沙箱准备阶段被控制面取消")
            return
          }
        }
        const pressure = await solver.contextPressure()
        if (pressure.shouldCompact) {
          const runtime = this.project.challengeRuntimeState(
            active.challenge.id,
          )
          const eventKey = `${solver.runId}:compact:${this.project.runEvents(solver.runId).length}`
          const canCompact =
            !runtime.blocked &&
            runtime.blockScore + 2 <= runtime.effectiveBlockThreshold
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
            this.project.appendRunEvent(
              solver.runId,
              "block_finalization_failed",
              {
                eventKey,
                scoreAfter: blockEvent.scoreAfter,
                error: errorText(error),
              },
            )
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
          for (const message of this.project.compactRecoveryMessages(
            active.challenge.id,
            solver.runId,
          )) {
            solver.appendMessage(message)
          }
        }
        const prompt = continuation
          ? INCOMPLETE_CONTINUATION_PROMPT
          : typeof this.options.prompt === "function"
            ? await this.options.prompt(
                context ?? {
                  challenge: active.challenge,
                  attempt: active.attempt,
                  source: active.source,
                },
              )
            : (this.options.prompt ?? DEFAULT_PROMPT)
        const outcome = await runSolverPrompt({
          solver,
          prompt,
          timeoutMs: this.options.challengeTimeoutMs ?? 30 * 60_000,
          abortGraceMs: this.options.abortGraceMs ?? 5_000,
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
        })
        if (classification.blockDelta === 0) {
          const message = `${classification.kind}: ${classification.detail ?? outcome.stopReason}`
          this.project.appendRunEvent(solver.runId, "run_transient_failure", {
            retryable: classification.retryable,
            reason: classification.kind,
          })
          await solver.close("failed", message)
          solver = undefined
          active.solver = undefined
          if (classification.retryable) {
            retryableFailure = true
            failureReason = "failed"
            failureMessage = message
            break
          }
          this.lastError = `${active.challenge.title}: ${message}`
          return
        }

        sameRunStops += 1
        const interruptionCount =
          this.project.sessionInterruptionCount(active.challenge.id) +
          sameRunStops
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
            this.project.sessionInterruptionCount(active.challenge.id) +
            sameRunStops
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
          await this.finalizeBlockedRun(
            active,
            solver,
            failureMessage ?? "blocked",
          )
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

    const schedulerAttemptsAfter = this.project.schedulerAttemptCount(
      active.challenge.id,
    )
    if (
      failureReason !== "cancelled" &&
      (retryableFailure || schedulerAttemptsAfter > schedulerAttemptsBefore) &&
      !this.shuttingDown &&
      active.queueGeneration === this.queueGeneration &&
      (retryableFailure ||
        schedulerAttemptsAfter < (this.options.maxAttempts ?? 2)) &&
      !this.project.isChallengeSolved(active.challenge.id)
    ) {
      if (failureMessage) {
        this.lastError = `${active.challenge.title}: ${failureMessage}（等待重试）`
      }
      const configuredDelay = this.options.retryDelayMs ?? 2_000
      const delay = retryableFailure
        ? Math.max(
            this.options.infrastructureRetryDelayMs ?? 15_000,
            configuredDelay,
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
          active.lane,
          false,
          active.requiresAuto,
        )
      }
    } else if (failureMessage && failureReason !== "cancelled") {
      this.lastError = `${active.challenge.title}: ${failureMessage}`
    }
  }

  private async writeupAfterSubmission(
    active: ActiveItem,
    solver: CtfSolverAgent,
  ): Promise<void> {
    await this.project.markRunWritingWriteup(solver.runId)
    await solver.prepareWriteup()
    let prompt = WRITEUP_PROMPT
    let lastErrors: string[] = []
    for (let attempt = 0; attempt < 3; attempt++) {
      const outcome = await runSolverPrompt({
        solver,
        prompt,
        timeoutMs: Math.min(
          this.options.challengeTimeoutMs ?? 120_000,
          120_000,
        ),
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
    await solver.close("failed", error)
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
        "Report your current objective, verified findings, attempted experiments, exact results, artifacts, and next-step recommendation. Stop investigating after this report.",
        2_000,
      )
      solver.appendMessage({
        role: "user",
        content: activeSubagentsPrompt(records),
        timestamp: Date.now(),
      })
      const outcome = await runSolverPrompt({
        solver,
        prompt: BLOCKED_FINALIZATION_PROMPT,
        timeoutMs: Math.min(this.options.challengeTimeoutMs ?? 30_000, 30_000),
        abortGraceMs: this.options.abortGraceMs ?? 5_000,
      })
      if (outcome.kind === "submitted" || hasTerminalSubmission(solver)) {
        await solver.close("submitted")
        return
      }
      if (outcome.stopReason === "error" || outcome.stopReason === "aborted") {
        finalizationError =
          outcome.error ?? `Final turn stopped: ${outcome.stopReason}`
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
    lane: "normal" | "blocked",
    manualOverride: boolean,
    requiresAuto: boolean,
  ): void {
    if (this.queue.some((item) => item.challenge.id === challenge.id)) return
    const persisted = this.project.enqueueSchedulerChallenge({
      challengeId: challenge.id,
      source,
      lane,
      manualOverride,
    })
    const item: QueueItem = {
      challenge,
      source,
      lane,
      manualOverride,
      requiresAuto,
      enqueuedAt: persisted.enqueuedAt,
      version: persisted.version,
    }
    if (manualOverride) this.queue.unshift(item)
    else this.queue.push(item)
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
