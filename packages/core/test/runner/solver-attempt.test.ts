import type { CtfSolverAgent } from "@ctf-agent/agents"
import { describe, expect, it, vi } from "vitest"
import { runSolverPrompt } from "../../src/orchestration/solver-attempt.ts"

function solverFixture(stopReasons: string[]) {
  let index = 0
  const solver = {
    thinkingLevel: "max",
    submission: undefined as { status: string } | undefined,
    prompt: vi.fn(async () => {
      const stopReason = stopReasons[index++] ?? "stop"
      if (stopReason === "submitted") {
        solver.submission = { status: "accepted" }
        return { stopReason: "stop" }
      }
      return { stopReason }
    }),
    setThinkingLevel: vi.fn(async (level: string) => {
      solver.thinkingLevel = level
    }),
    abort: vi.fn(async () => undefined),
  }
  return solver
}

describe("runSolverPrompt continuation control", () => {
  it("keeps the configured thinking level after repeated length truncation", async () => {
    const solver = solverFixture(["length", "length", "submitted"])

    await runSolverPrompt({
      solver: solver as unknown as CtfSolverAgent,
      prompt: "solve",
      timeoutMs: 5_000,
      abortGraceMs: 10,
    })

    expect(solver.prompt).toHaveBeenCalledTimes(3)
    expect(solver.setThinkingLevel).not.toHaveBeenCalled()
    expect(solver.submission).toEqual({ status: "accepted" })
  })

  it("keeps continuing past the former limit until the same run submits", async () => {
    const solver = solverFixture([
      ...Array.from({ length: 20 }, () => "stop"),
      "submitted",
    ])

    await runSolverPrompt({
      solver: solver as unknown as CtfSolverAgent,
      prompt: "solve",
      timeoutMs: 5_000,
      abortGraceMs: 10,
    })

    expect(solver.prompt).toHaveBeenCalledTimes(21)
    expect(solver.submission).toEqual({ status: "accepted" })
  })
})
