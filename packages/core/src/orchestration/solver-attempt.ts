import type { CtfSolverAgent } from "@ctf-agent/agents"

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

export type SolverPromptOutcome =
  | { kind: "submitted"; stopReason: string }
  | {
      kind: "interrupted"
      stopReason: string
      error?: string
    }

/** Run one prompt with shared timeout/cancellation semantics used by every orchestrator. */
export async function runSolverPrompt(options: {
  solver: CtfSolverAgent
  prompt: string
  timeoutMs: number
  abortGraceMs: number
  signal?: AbortSignal
}): Promise<SolverPromptOutcome> {
  const { solver, prompt, timeoutMs, abortGraceMs, signal } = options
  if (signal?.aborted) throw new ContestRunnerCancelledError()
  const operation = solver.prompt(prompt)
  const settled = operation.then(
    (response) => ({ kind: "completed" as const, response }),
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
  if (outcome.kind === "completed") {
    return hasTerminalSubmission(solver)
      ? { kind: "submitted", stopReason: outcome.response.stopReason }
      : {
          kind: "interrupted",
          stopReason: outcome.response.stopReason,
          ...(outcome.response.errorMessage
            ? { error: outcome.response.errorMessage }
            : {}),
        }
  }
  if (outcome.kind === "failed") {
    return {
      kind: "interrupted",
      stopReason: "error",
      error: errorText(outcome.error),
    }
  }

  await solver.abort()
  await Promise.race([
    settled,
    new Promise((resolve) => setTimeout(resolve, abortGraceMs)),
  ])
  if (outcome.kind === "cancelled") throw new ContestRunnerCancelledError()
  throw new ChallengeTimeoutError(timeoutMs)
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

export function sessionInterruptionMessage(
  stopReason: string,
  error: string | undefined,
  count: number,
  maximum: number,
  blocked: boolean,
): string {
  const detail = error ? `: ${error}` : ""
  return blocked
    ? `Session 异常中断 ${count} 次，已超过阈值 ${maximum}，Agent 已设为 blocked（${stopReason}${detail}）`
    : `Session 异常中断 ${count}/${maximum}（${stopReason}${detail}），将创建全新 Session 继续`
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
