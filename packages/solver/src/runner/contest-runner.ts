import type { AgentOptions } from "@earendil-works/pi-agent-core"
import type { ChallengeSummary } from "@ctf-agent/platform"
import { type CreateSolverOptions, Project } from "../project/project.ts"
import { CtfSolverAgent, type SolverCloseReason } from "../agent/solver-agent.ts"

export interface ContestRunnerAttemptContext {
  challenge: ChallengeSummary
  attempt: number
}

export interface ContestRunnerOptions {
  /** 同时活跃的 Solver 上限。 */
  maxConcurrent: number
  /** 每道题的总尝试上限，包含 RunStore 中已有的历史尝试。 */
  maxAttempts?: number
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

export type ChallengeRunStatus = "solved" | "failed" | "cancelled" | "skipped"

export interface ChallengeRunResult {
  challengeId: string
  status: ChallengeRunStatus
  attempts: number
  runIds: string[]
  error?: string
  reason?: "platform_solved" | "store_solved" | "filtered" | "attempts_exhausted"
}

export interface ContestRunSummary {
  startedAt: string
  finishedAt: string
  total: number
  solved: number
  failed: number
  cancelled: number
  skipped: number
  attempts: number
  results: ChallengeRunResult[]
}

export interface ContestRunnerRunOptions {
  signal?: AbortSignal
}

const DEFAULT_PROMPT = "解决当前 CTF 题目。获取题目信息和附件，必要时启动远程实例，找到并提交 Flag。"

export class ChallengeTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Solver 超过单次时限 ${timeoutMs}ms`)
    this.name = "ChallengeTimeoutError"
  }
}

export class ContestRunnerCancelledError extends Error {
  constructor() {
    super("ContestRunner 已取消")
    this.name = "ContestRunnerCancelledError"
  }
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
          results.push({ challengeId: challenge.id, status: "skipped", attempts: 0, runIds: [], reason: "platform_solved" })
          continue
        }
        if (this.project.isChallengeSolved(challenge.id)) {
          results.push({ challengeId: challenge.id, status: "skipped", attempts: 0, runIds: [], reason: "store_solved" })
          continue
        }
        if (this.options.selectChallenge && !await this.options.selectChallenge(challenge)) {
          results.push({ challengeId: challenge.id, status: "skipped", attempts: 0, runIds: [], reason: "filtered" })
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
          results.push({ challengeId: challenge.id, status: "cancelled", attempts: 0, runIds: [] })
        }
      }
      return summarize(startedAt, results, challenges.map((challenge) => challenge.id))
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

  private async runChallenge(challenge: ChallengeSummary, signal: AbortSignal): Promise<ChallengeRunResult> {
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
    this.activeChallenges.add(challenge.id)
    const maxAttempts = this.options.maxAttempts ?? 1
    const runIds: string[] = []
    let attempts = 0
    let lastError: string | undefined

    try {
      let attempt = this.project.nextAttempt(challenge.id)
      if (attempt > maxAttempts) {
        return {
          challengeId: challenge.id,
          status: "failed",
          attempts,
          runIds,
          reason: "attempts_exhausted",
          error: `历史尝试次数已达到上限 ${maxAttempts}`,
        }
      }

      while (attempt <= maxAttempts) {
        if (signal.aborted) return { challengeId: challenge.id, status: "cancelled", attempts, runIds, error: lastError }
        attempts++
        const context = { challenge, attempt }
        let solver: CtfSolverAgent | undefined
        try {
          const agent = await this.options.createAgentOptions(context)
          const prompt = typeof this.options.prompt === "function"
            ? await this.options.prompt(context)
            : this.options.prompt ?? DEFAULT_PROMPT
          solver = await this.project.createSolver(challenge.id, {
            agent,
            compaction: this.options.compaction,
            attempt,
          })
          runIds.push(solver.runId)
          this.activeSolvers.set(challenge.id, solver)

          await runPromptWithDeadline(
            solver,
            prompt,
            this.options.challengeTimeoutMs ?? 30 * 60_000,
            this.options.abortGraceMs ?? 5_000,
            signal,
          )

          if (solver.submission?.status === "accepted" || solver.submission?.status === "already_solved") {
            // agent_end listener 已执行 close；显式 await 保证清理和持久化完全结算。
            await solver.close("submitted")
            return { challengeId: challenge.id, status: "solved", attempts, runIds }
          }
          const agentError = await latestAgentError(solver)
          throw new Error(agentError ?? "Agent 已结束，但没有提交正确 Flag")
        } catch (error) {
          const reason = closeReason(error, signal)
          lastError = errorText(error)
          if (solver) {
            try {
              await solver.close(reason, lastError)
            } catch (cleanupError) {
              lastError = `${lastError}; ${errorText(cleanupError)}`
            }
          }
          if (reason === "cancelled") {
            return { challengeId: challenge.id, status: "cancelled", attempts, runIds, error: lastError }
          }
          if (attempt < maxAttempts) {
            try {
              await abortableDelay(this.options.retryDelayMs ?? 0, signal)
            } catch {
              return { challengeId: challenge.id, status: "cancelled", attempts, runIds, error: lastError }
            }
          }
        } finally {
          this.activeSolvers.delete(challenge.id)
        }
        attempt++
      }
      return { challengeId: challenge.id, status: "failed", attempts, runIds, error: lastError }
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
    if (failures.length > 0) throw new AggregateError(failures, "ContestRunner 无法回收全部 Solver 资源")
  }
}

async function runPromptWithDeadline(
  solver: CtfSolverAgent,
  prompt: string,
  timeoutMs: number,
  abortGraceMs: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) throw new ContestRunnerCancelledError()
  const operation = solver.prompt(prompt)
  const settled = operation.then(
    () => ({ kind: "completed" as const }),
    (error: unknown) => ({ kind: "failed" as const, error }),
  )
  let timeout: NodeJS.Timeout | undefined
  let abort: (() => void) | undefined
  const stop = new Promise<{ kind: "timeout" } | { kind: "cancelled" }>((resolve) => {
    timeout = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs)
    abort = () => resolve({ kind: "cancelled" })
    signal.addEventListener("abort", abort, { once: true })
  })

  const outcome = await Promise.race([settled, stop])
  if (timeout) clearTimeout(timeout)
  if (abort) signal.removeEventListener("abort", abort)
  if (outcome.kind === "completed") return
  if (outcome.kind === "failed") throw outcome.error

  await solver.abort()
  await Promise.race([settled, abortableDelay(abortGraceMs)])
  if (outcome.kind === "cancelled") throw new ContestRunnerCancelledError()
  throw new ChallengeTimeoutError(timeoutMs)
}

async function latestAgentError(solver: CtfSolverAgent): Promise<string | undefined> {
  const messages = await solver.transcript()
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message?.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted")) {
      return message.errorMessage ?? `Agent ${message.stopReason}`
    }
  }
  return undefined
}

function closeReason(error: unknown, signal: AbortSignal): SolverCloseReason {
  if (signal.aborted || error instanceof ContestRunnerCancelledError) return "cancelled"
  if (error instanceof ChallengeTimeoutError) return "timed_out"
  return "failed"
}

function deduplicateChallenges(challenges: readonly ChallengeSummary[]): ChallengeSummary[] {
  const unique = new Map<string, ChallengeSummary>()
  for (const challenge of challenges) if (!unique.has(challenge.id)) unique.set(challenge.id, challenge)
  return [...unique.values()]
}

function summarize(startedAt: string, results: ChallengeRunResult[], order: readonly string[]): ContestRunSummary {
  const positions = new Map(order.map((id, index) => [id, index]))
  results.sort((left, right) => (positions.get(left.challengeId) ?? 0) - (positions.get(right.challengeId) ?? 0))
  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    total: results.length,
    solved: results.filter((result) => result.status === "solved").length,
    failed: results.filter((result) => result.status === "failed").length,
    cancelled: results.filter((result) => result.status === "cancelled").length,
    skipped: results.filter((result) => result.status === "skipped").length,
    attempts: results.reduce((sum, result) => sum + result.attempts, 0),
    results,
  }
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds === 0) return signal?.aborted ? Promise.reject(new ContestRunnerCancelledError()) : Promise.resolve()
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
