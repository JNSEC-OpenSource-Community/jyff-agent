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
  it("远程环境排队期间暂停 Solver 工作时限", async () => {
    let finish!: (value: { stopReason: string }) => void
    const waiting = true
    const solver = solverFixture([])
    solver.prompt.mockImplementationOnce(
      async () =>
        await new Promise<{ stopReason: string }>((resolve) => {
          finish = resolve
        }),
    )
    const operation = runSolverPrompt({
      solver: solver as unknown as CtfSolverAgent,
      prompt: "verify",
      timeoutMs: 20,
      abortGraceMs: 10,
      pauseTimeout: () => waiting,
    })

    await new Promise((resolve) => setTimeout(resolve, 40))
    finish({ stopReason: "stop" })

    await expect(operation).resolves.toEqual({
      kind: "interrupted",
      stopReason: "stop",
    })
    expect(solver.abort).not.toHaveBeenCalled()
  })

  it("将未提交 Flag 的正常结束交给新 Session 续跑", async () => {
    const solver = solverFixture(["length"])

    const outcome = await runSolverPrompt({
      solver: solver as unknown as CtfSolverAgent,
      prompt: "solve",
      timeoutMs: 5_000,
      abortGraceMs: 10,
    })

    expect(outcome).toEqual({ kind: "interrupted", stopReason: "length" })
    expect(solver.prompt).toHaveBeenCalledTimes(1)
    expect(solver.setThinkingLevel).not.toHaveBeenCalled()
  })

  it("提交成功时返回 terminal outcome", async () => {
    const solver = solverFixture(["submitted"])

    const outcome = await runSolverPrompt({
      solver: solver as unknown as CtfSolverAgent,
      prompt: "solve",
      timeoutMs: 5_000,
      abortGraceMs: 10,
    })

    expect(outcome).toEqual({ kind: "submitted", stopReason: "stop" })
    expect(solver.prompt).toHaveBeenCalledTimes(1)
    expect(solver.submission).toEqual({ status: "accepted" })
  })

  it("将模型流抛错归类为可续跑的 Session 中断", async () => {
    const solver = solverFixture([])
    solver.prompt.mockRejectedValueOnce(new Error("websocket disconnected"))

    await expect(
      runSolverPrompt({
        solver: solver as unknown as CtfSolverAgent,
        prompt: "solve",
        timeoutMs: 5_000,
        abortGraceMs: 10,
      }),
    ).resolves.toEqual({
      kind: "interrupted",
      stopReason: "error",
      error: "websocket disconnected",
    })
  })
})
