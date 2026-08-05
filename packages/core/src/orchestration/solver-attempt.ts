import type { CtfSolverAgent } from "@ctf-agent/agents"
import {
  INCOMPLETE_CONTINUATION_PROMPT,
  LENGTH_CONTINUATION_PROMPT,
} from "../../prompts/solver-attempt.ts"

const LENGTHS_BEFORE_THINKING_REDUCTION = 2

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

/** Run one prompt with shared timeout/cancellation semantics used by every orchestrator. */
export async function runSolverPrompt(options: {
  solver: CtfSolverAgent
  prompt: string
  timeoutMs: number
  abortGraceMs: number
  signal?: AbortSignal
}): Promise<void> {
  const { solver, prompt, timeoutMs, abortGraceMs, signal } = options
  if (signal?.aborted) throw new ContestRunnerCancelledError()
  const operation = runUntilTerminalSubmission({ solver, prompt })
  const settled = operation.then(
    () => ({ kind: "completed" as const }),
    (error: unknown) => ({ kind: "failed" as const, error }),
  )
  let timeout: NodeJS.Timeout | undefined
  let onAbort: (() => void) | undefined
  const stop = new Promise<{ kind: "timeout" } | { kind: "cancelled" }>(
    (resolve) => {
      timeout = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs)
      if (signal) {
        onAbort = () => resolve({ kind: "cancelled" })
        signal.addEventListener("abort", onAbort, { once: true })
      }
    },
  )

  const outcome = await Promise.race([settled, stop])
  if (timeout) clearTimeout(timeout)
  if (onAbort) signal?.removeEventListener("abort", onAbort)
  if (outcome.kind === "completed") return
  if (outcome.kind === "failed") throw outcome.error

  await solver.abort()
  await Promise.race([
    settled,
    new Promise((resolve) => setTimeout(resolve, abortGraceMs)),
  ])
  if (outcome.kind === "cancelled") throw new ContestRunnerCancelledError()
  throw new ChallengeTimeoutError(timeoutMs)
}

async function runUntilTerminalSubmission(options: {
  solver: CtfSolverAgent
  prompt: string
}): Promise<void> {
  const { solver } = options
  let response = await solver.prompt(options.prompt)
  let consecutiveLengthStops = 0

  while (!hasTerminalSubmission(solver)) {
    if (response.stopReason === "error" || response.stopReason === "aborted") {
      return
    }
    if (response.stopReason === "length") {
      consecutiveLengthStops++
      if (consecutiveLengthStops >= LENGTHS_BEFORE_THINKING_REDUCTION) {
        const reduced = reducedThinkingLevel(solver.thinkingLevel)
        if (reduced !== solver.thinkingLevel) {
          await solver.setThinkingLevel(reduced)
        }
        consecutiveLengthStops = 0
      }
    } else {
      consecutiveLengthStops = 0
    }
    response = await solver.prompt(
      response.stopReason === "length"
        ? LENGTH_CONTINUATION_PROMPT
        : INCOMPLETE_CONTINUATION_PROMPT,
    )
  }
}

function reducedThinkingLevel(
  level: CtfSolverAgent["thinkingLevel"],
): CtfSolverAgent["thinkingLevel"] {
  switch (level) {
    case "max":
    case "xhigh":
      return "high"
    case "high":
      return "medium"
    case "medium":
      return "low"
    default:
      return level
  }
}

export async function latestAgentError(
  solver: CtfSolverAgent,
): Promise<string | undefined> {
  const messages = await solver.transcript()
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (
      message?.role === "assistant" &&
      (message.stopReason === "error" || message.stopReason === "aborted")
    ) {
      return message.errorMessage ?? `Agent ${message.stopReason}`
    }
  }
  return undefined
}

export function hasTerminalSubmission(solver: CtfSolverAgent): boolean {
  return (
    solver.submission?.status === "accepted" ||
    solver.submission?.status === "already_solved"
  )
}
