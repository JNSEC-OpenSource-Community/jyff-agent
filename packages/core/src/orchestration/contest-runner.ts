import type { CtfSolverAgent, SolverCloseReason } from "@ctf-agent/agents"
import type { ChallengeSummary } from "@ctf-agent/platform"
import { INCOMPLETE_CONTINUATION_PROMPT } from "@ctf-agent/prompts"
import type { AgentOptions } from "@earendil-works/pi-agent-core"
import type { RunStatus } from "../persistence/run-store.ts"
import type { CreateSolverOptions, Project } from "../project/project.ts"
import {
  ChallengeTimeoutError,
  ContestRunnerCancelledError,
  hasTerminalSubmission,
  runSolverPrompt,
  sessionInterruptionMessage,
} from "./solver-attempt.ts"

export { ChallengeTimeoutError, ContestRunnerCancelledError } from "./solver-attempt.ts"

export interface ContestRunnerAttemptContext {
  challenge: ChallengeSummary
  attempt: number
}

export interface ContestRunnerOptions {
  /** 同时活跃的 Solver 上限。 */
  maxConcurrent: number
  /** 每道题的总尝试上限，包含 RunStore 中已有的历史尝试。 */
  maxAttempts?: number
  /** 超过该连续异常 Session 数后进入 blocked。 */
  maxSessionInterruptions?: number
  /** 单次 Solver 尝试的硬超时。 */
  challengeTimeoutMs?: number
  /** abort 后等待 Agent 自行结束的宽限期，之后仍会强制回收资源。 */
  abortGraceMs?: number
  /** 可重试失败之间的等待时间。 */
  retryDelayMs?: number
  /** 为每个题目和 attempt 创建独立 AgentOptions。 */
  createAgentOptions(context: ContestRunnerAttemptContext): AgentOptions | Promise<AgentOptions>
  compaction?: CreateSolverOptions["compaction"]
  prompt?: string | ((context: ContestRunnerAttemptContext) => string | Promise<string>)
  selectChallenge?: (challenge: ChallengeSummary) => boolean | Promise<boolean>
}

export type ChallengeRunStatus = "solved" | "failed" | "cancelled" | "blocked" | "skipped"

export interface ChallengeRunResult {
  challengeId: string
  status: ChallengeRunStatus
  attempts: number
  runIds: string[]
  error?: string
  reason?: "platform_solved" | "store_solved" | "filtered" | "attempts_exhausted" | "blocked"
}

export interface ContestRunSummary {
  startedAt: string
  finishedAt: string
  total: number
  solved: number
  failed: number
  cancelled: number
  blocked: number
  skipped: number
  attempts: number
  results: ChallengeRunResult[]
}

export interface ContestRunnerRunOptions {
  signal?: AbortSignal
}

/**
 * 比赛级单进程调度器。
 *
 * - worker pool 限制并发；
 * - activeChallenges 保证同一 Runner 内同题互斥；
 * - RunStore 的历史 attempt 保证重启后不会重置重试预算；
 * - 每条退出路径最终都会调用 Solver.close() 强制回收资源。
 */
export class ContestRunner {
  private controller?: AbortController
  private running = false
  private readonly activeChallenges = new Set<string>()
  private readonly activeSolvers = new Map<string, CtfSolverAgent>()

  constructor(
    private readonly project: Project,
    private readonly options: ContestRunnerOptions,
  ) {
    positiveInteger(options.maxConcurrent, "maxConcurrent")
    positiveInteger(options.maxAttempts ?? 1, "maxAttempts")
    positiveInteger(options.maxSessionInterruptions ?? 3, "maxSessionInterruptions")
    positiveInteger(options.challengeTimeoutMs ?? 30 * 60_000, "challengeTimeoutMs")
    nonNegativeInteger(options.abortGraceMs ?? 5_000, "abortGraceMs")
    nonNegativeInteger(options.retryDelayMs ?? 0, "retryDelayMs")
  }

  get isRunning(): boolean {
    return this.running
  }

  get activeChallengeIds(): readonly string[] {
    return [...this.activeChallenges]
  }

  async run(runOptions: ContestRunnerRunOptions = {}): Promise<ContestRunSummary> {
    if (this.running) throw new Error("ContestRunner 已在运行")
    this.running = true
    const startedAt = new Date().toISOString()
    const controller = new AbortController()
    this.controller = controller
    const forwardAbort = () => controller.abort()
    runOptions.signal?.addEventListener("abort", forwardAbort, { once: true })
    if (runOptions.signal?.aborted) controller.abort()

    try {
      await this.project.refresh()
      const listed = await this.project.challenges()
      const challenges = deduplicateChallenges(listed)
      const results: ChallengeRunResult[] = []
      const pending: ChallengeSummary[] = []

      for (const challenge of challenges) {
        if (challenge.solved) {
          results.push({
            challengeId: challenge.id,
            status: "skipped",
            attempts: 0,
            runIds: [],
            reason: "platform_solved",
          })
          continue
        }
        if (this.project.isChallengeSolved(challenge.id)) {
          results.push({
            challengeId: challenge.id,
            status: "skipped",
            attempts: 0,
            runIds: [],
            reason: "store_solved",
          })
          continue
        }
        if (this.options.selectChallenge && !(await this.options.selectChallenge(challenge))) {
          results.push({
            challengeId: challenge.id,
            status: "skipped",
            attempts: 0,
            runIds: [],
            reason: "filtered",
          })
          continue
        }
        pending.push(challenge)
      }

      let nextIndex = 0
      const worker = async () => {
        while (true) {
          if (controller.signal.aborted) return
          const index = nextIndex++
          const challenge = pending[index]
          if (!challenge) return
          results.push(await this.runChallenge(challenge, controller.signal))
        }
      }
      const workers = Array.from(
        { length: Math.min(this.options.maxConcurrent, pending.length) },
        () => worker(),
      )
      await Promise.all(workers)

      // 尚未领取的题目在取消后也必须出现在完整汇总中。
      const recorded = new Set(results.map((result) => result.challengeId))
      for (const challenge of pending) {
        if (!recorded.has(challenge.id)) {
          results.push({
            challengeId: challenge.id,
            status: "cancelled",
            attempts: 0,
            runIds: [],
          })
        }
      }
      return summarize(
        startedAt,
        results,
        challenges.map((challenge) => challenge.id),
      )
    } finally {
      runOptions.signal?.removeEventListener("abort", forwardAbort)
      await this.closeActiveSolvers("cancelled", "ContestRunner 结束时仍有活跃 Solver")
      this.controller = undefined
      this.running = false
    }
  }

  async stop(): Promise<void> {
    this.controller?.abort()
    await this.closeActiveSolvers("cancelled", "ContestRunner 被停止")
  }

  private async runChallenge(
    challenge: ChallengeSummary,
    signal: AbortSignal,
  ): Promise<ChallengeRunResult> {
    if (this.activeChallenges.has(challenge.id)) {
      return {
        challengeId: challenge.id,
        status: "skipped",
        attempts: 0,
        runIds: [],
        reason: "filtered",
        error: "同一道题已有活跃 Solver",
      }
    }
    if (this.project.isChallengeBlocked(challenge.id)) {
      return {
        challengeId: challenge.id,
        status: "blocked",
        attempts: 0,
        runIds: [],
        reason: "blocked",
        error: "该题因连续 Session 异常中断已暂停，等待人工介入",
      }
    }
    this.activeChallenges.add(challenge.id)
    const maxAttempts = this.options.maxAttempts ?? 1
    const runIds: string[] = []
    let attempts = 0
    let failures = this.project
      .runs({ challengeId: challenge.id })
      .filter((run) => countsAgainstAttemptBudget(run.status)).length
    let lastError: string | undefined
    let continuation = false
    let resumeRunId: string | undefined
    let resumeAttempt: number | undefined

    try {
      if (failures >= maxAttempts) {
        return {
          challengeId: challenge.id,
          status: "failed",
          attempts,
          runIds,
          reason: "attempts_exhausted",
          error: `历史尝试次数已达到上限 ${maxAttempts}`,
        }
      }

      while (failures < maxAttempts) {
        if (signal.aborted)
          return {
            challengeId: challenge.id,
            status: "cancelled",
            attempts,
            runIds,
            error: lastError,
          }
        const resumedRunId = resumeRunId
        const attempt = resumeAttempt ?? this.project.nextAttempt(challenge.id)
        if (!resumedRunId) attempts++
        const context = { challenge, attempt }
        let solver: CtfSolverAgent | undefined
        try {
          const agent = await this.options.createAgentOptions(context)
          const prompt = continuation
            ? INCOMPLETE_CONTINUATION_PROMPT
            : typeof this.options.prompt === "function"
              ? await this.options.prompt(context)
              : (this.options.prompt ?? "Start solving this CTF challenge.")
          solver = resumedRunId
            ? await this.project.resumeSolver(resumedRunId, {
                agent,
                compaction: this.options.compaction,
              })
            : await this.project.createSolver(challenge.id, {
                agent,
                compaction: this.options.compaction,
                attempt,
              })
          if (!runIds.includes(solver.runId)) runIds.push(solver.runId)
          this.activeSolvers.set(challenge.id, solver)

          const promptRunId = solver.runId
          const outcome = await runSolverPrompt({
            solver,
            prompt,
            timeoutMs: this.options.challengeTimeoutMs ?? 30 * 60_000,
            abortGraceMs: this.options.abortGraceMs ?? 5_000,
            pauseTimeout: () => this.project.isWaitingForRemoteEnvironment(promptRunId),
            signal,
          })

          if (outcome.kind === "submitted" || hasTerminalSubmission(solver)) {
            // agent_end listener 已执行 close；显式 await 保证清理和持久化完全结算。
            await solver.close("submitted")
            return {
              challengeId: challenge.id,
              status: "solved",
              attempts,
              runIds,
            }
          }

          const interruptionCount = this.project.sessionInterruptionCount(challenge.id) + 1
          const maximum = this.options.maxSessionInterruptions ?? 3
          const blocked = interruptionCount > maximum
          lastError = sessionInterruptionMessage(
            outcome.stopReason,
            outcome.error,
            interruptionCount,
            maximum,
            blocked,
          )
          await solver.close(blocked ? "blocked" : "interrupted", lastError)
          if (blocked) {
            return {
              challengeId: challenge.id,
              status: "blocked",
              attempts,
              runIds,
              reason: "blocked",
              error: lastError,
            }
          }
          resumeRunId = solver.runId
          resumeAttempt = attempt
          continuation = true
        } catch (error) {
          const reason = closeReason(error, signal)
          lastError = errorText(error)
          if (solver && !solver.isClosed) {
            try {
              await solver.close(reason, lastError)
            } catch (cleanupError) {
              lastError = `${lastError}; ${errorText(cleanupError)}`
            }
          }
          if (resumedRunId) {
            resumeRunId = undefined
            resumeAttempt = undefined
          }
          if (reason === "cancelled") {
            return {
              challengeId: challenge.id,
              status: "cancelled",
              attempts,
              runIds,
              error: lastError,
            }
          }
          failures++
          continuation = false
          if (failures < maxAttempts) {
            try {
              await abortableDelay(this.options.retryDelayMs ?? 0, signal)
            } catch {
              return {
                challengeId: challenge.id,
                status: "cancelled",
                attempts,
                runIds,
                error: lastError,
              }
            }
          }
        } finally {
          this.activeSolvers.delete(challenge.id)
        }
      }
      return {
        challengeId: challenge.id,
        status: "failed",
        attempts,
        runIds,
        error: lastError,
      }
    } finally {
      this.activeChallenges.delete(challenge.id)
    }
  }

  private async closeActiveSolvers(reason: SolverCloseReason, error: string): Promise<void> {
    const solvers = [...this.activeSolvers.values()]
    const results = await Promise.allSettled(solvers.map((solver) => solver.close(reason, error)))
    this.activeSolvers.clear()
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason)
    if (failures.length > 0)
      throw new AggregateError(failures, "ContestRunner 无法回收全部 Solver 资源")
  }
}

function countsAgainstAttemptBudget(status: RunStatus): boolean {
  return status !== "interrupted" && status !== "blocked" && status !== "solved"
}

function closeReason(error: unknown, signal: AbortSignal): SolverCloseReason {
  if (signal.aborted || error instanceof ContestRunnerCancelledError) return "cancelled"
  if (error instanceof ChallengeTimeoutError) return "timed_out"
  return "failed"
}

function deduplicateChallenges(challenges: readonly ChallengeSummary[]): ChallengeSummary[] {
  const unique = new Map<string, ChallengeSummary>()
  for (const challenge of challenges)
    if (!unique.has(challenge.id)) unique.set(challenge.id, challenge)
  return [...unique.values()]
}

function summarize(
  startedAt: string,
  results: ChallengeRunResult[],
  order: readonly string[],
): ContestRunSummary {
  const positions = new Map(order.map((id, index) => [id, index]))
  results.sort(
    (left, right) =>
      (positions.get(left.challengeId) ?? 0) - (positions.get(right.challengeId) ?? 0),
  )
  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    total: results.length,
    solved: results.filter((result) => result.status === "solved").length,
    failed: results.filter((result) => result.status === "failed").length,
    cancelled: results.filter((result) => result.status === "cancelled").length,
    blocked: results.filter((result) => result.status === "blocked").length,
    skipped: results.filter((result) => result.status === "skipped").length,
    attempts: results.reduce((sum, result) => sum + result.attempts, 0),
    results,
  }
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds === 0)
    return signal?.aborted ? Promise.reject(new ContestRunnerCancelledError()) : Promise.resolve()
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ContestRunnerCancelledError())
      return
    }
    const timeout = setTimeout(done, milliseconds)
    const abort = () => {
      clearTimeout(timeout)
      signal?.removeEventListener("abort", abort)
      reject(new ContestRunnerCancelledError())
    }
    signal?.addEventListener("abort", abort, { once: true })
    function done() {
      signal?.removeEventListener("abort", abort)
      resolve()
    }
  })
}

function positiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} 必须是正整数`)
}

function nonNegativeInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} 必须是非负整数`)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
