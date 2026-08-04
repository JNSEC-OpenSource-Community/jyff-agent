import type { CtfSolverAgent } from "@ctf-agent/agents";

export class ChallengeTimeoutError extends Error {
	constructor(readonly timeoutMs: number) {
		super(`Solver 超过单次时限 ${timeoutMs}ms`);
		this.name = "ChallengeTimeoutError";
	}
}

export class ContestRunnerCancelledError extends Error {
	constructor() {
		super("ContestRunner 已取消");
		this.name = "ContestRunnerCancelledError";
	}
}

/** Run one prompt with shared timeout/cancellation semantics used by every orchestrator. */
export async function runSolverPrompt(options: {
	solver: CtfSolverAgent;
	prompt: string;
	timeoutMs: number;
	abortGraceMs: number;
	signal?: AbortSignal;
}): Promise<void> {
	const { solver, prompt, timeoutMs, abortGraceMs, signal } = options;
	if (signal?.aborted) throw new ContestRunnerCancelledError();
	const operation = solver.prompt(prompt);
	const settled = operation.then(
		() => ({ kind: "completed" as const }),
		(error: unknown) => ({ kind: "failed" as const, error }),
	);
	let timeout: NodeJS.Timeout | undefined;
	let onAbort: (() => void) | undefined;
	const stop = new Promise<{ kind: "timeout" } | { kind: "cancelled" }>(
		(resolve) => {
			timeout = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
			if (signal) {
				onAbort = () => resolve({ kind: "cancelled" });
				signal.addEventListener("abort", onAbort, { once: true });
			}
		},
	);

	const outcome = await Promise.race([settled, stop]);
	if (timeout) clearTimeout(timeout);
	if (onAbort) signal?.removeEventListener("abort", onAbort);
	if (outcome.kind === "completed") return;
	if (outcome.kind === "failed") throw outcome.error;

	await solver.abort();
	await Promise.race([
		settled,
		new Promise((resolve) => setTimeout(resolve, abortGraceMs)),
	]);
	if (outcome.kind === "cancelled") throw new ContestRunnerCancelledError();
	throw new ChallengeTimeoutError(timeoutMs);
}

export async function latestAgentError(
	solver: CtfSolverAgent,
): Promise<string | undefined> {
	const messages = await solver.transcript();
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (
			message?.role === "assistant" &&
			(message.stopReason === "error" || message.stopReason === "aborted")
		) {
			return message.errorMessage ?? `Agent ${message.stopReason}`;
		}
	}
	return undefined;
}

export function hasTerminalSubmission(solver: CtfSolverAgent): boolean {
	return (
		solver.submission?.status === "accepted" ||
		solver.submission?.status === "already_solved"
	);
}
