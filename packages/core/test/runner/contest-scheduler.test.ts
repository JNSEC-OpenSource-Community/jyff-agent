import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { INCOMPLETE_CONTINUATION_PROMPT } from "@ctf-agent/prompts"
import type {
  CommandResult,
  DockerSandboxOptions,
  Sandbox,
} from "@ctf-agent/sandbox"
import type { AgentOptions } from "@earendil-works/pi-agent-core"
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux"
import { afterEach, describe, expect, it } from "vitest"
import {
  ContestScheduler,
  type ContestSchedulerError,
  DEFAULT_TRANSIENT_RETRY_DELAYS_MS,
} from "../../src/orchestration/contest-scheduler.ts"
import { Project } from "../../src/project/project.ts"
import { type TestChallenge, TestPlatformPlugin } from "../fake-platform.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

class SandboxTracker {
  active = 0
  maximum = 0
  closed = 0
  readonly files = new Map<string, Buffer>()

  create = async (_options: DockerSandboxOptions): Promise<Sandbox> => {
    this.active++
    this.maximum = Math.max(this.maximum, this.active)
    let closed = false
    return {
      id: `sandbox-${this.maximum}-${this.active}`,
      exec: async (args, options): Promise<CommandResult> => {
        if (args[0] !== "python3") {
          return { code: 0, stdout: "", stderr: "" }
        }
        const payload = JSON.parse(options?.input ?? "{}") as {
          op: string
          path: string
          base64?: string
        }
        if (payload.op === "read_binary") {
          const content = this.files.get(payload.path)
          return {
            code: 0,
            stdout: JSON.stringify(
              content
                ? { ok: true, value: content.toString("base64") }
                : {
                    ok: false,
                    code: "not_found",
                    message: "not found",
                    path: payload.path,
                  },
            ),
            stderr: "",
          }
        }
        if (payload.op === "replace") {
          this.files.set(
            payload.path,
            Buffer.from(payload.base64 ?? "", "base64"),
          )
        }
        return {
          code: 0,
          stdout: JSON.stringify({ ok: true, value: null }),
          stderr: "",
        }
      },
      close: async () => {
        if (closed) return
        closed = true
        this.active--
        this.closed++
      },
    }
  }
}

function challenge(
  index: number,
  options: Partial<TestChallenge> = {},
): TestChallenge {
  return {
    id: `challenge-${index}`,
    title: `Challenge ${index}`,
    category: "misc",
    score: 100 + index,
    description: "Mock challenge",
    attachments: [],
    flag: `MOCK{${index}}`,
    ...options,
  }
}

function requiredChallenge(item: TestChallenge | undefined): TestChallenge {
  if (!item) throw new Error("调度器引用了未知测试题目")
  return item
}

async function fixture(challenges: TestChallenge[], tracker: SandboxTracker) {
  const root = await mkdtemp(join(tmpdir(), "ctf-scheduler-"))
  roots.push(root)
  await mkdir(join(root, ".pi"), { recursive: true })
  await writeFile(
    join(root, ".pi", "ctf-config.json"),
    JSON.stringify({
      version: 1,
      project: { id: "scheduler-test", name: "Scheduler Test" },
      platform: { plugin: "test", config: { challenges } },
      sandbox: { image: "unused", privileged: false, networkMode: "none" },
    }),
  )
  const project = await Project.open({
    root,
    platforms: [new TestPlatformPlugin()],
    sandboxFactory: tracker.create,
    telemetry: { level: "full" },
  })
  return project
}

function solvingAgent(item: TestChallenge, delayMs = 20): AgentOptions {
  const faux = createFauxCore({ provider: `scheduler-${item.id}` })
  faux.setResponses([
    async () => {
      await new Promise((resolve) => setTimeout(resolve, delayMs))
      return fauxAssistantMessage(
        [
          fauxToolCall(
            "bash",
            { command: `printf '%s' '${item.flag}'` },
            { id: `bash-${item.id}` },
          ),
          fauxToolCall(
            "ctf_submit_flag",
            { flag: item.flag },
            { id: `submit-${item.id}` },
          ),
        ],
        { stopReason: "toolUse" },
      )
    },
    fauxAssistantMessage("done"),
  ])
  return {
    streamFn: faux.streamSimple as AgentOptions["streamFn"],
    initialState: { model: faux.getModel(), thinkingLevel: "off" },
  }
}

describe("ContestScheduler", () => {
  it.each([
    {
      label: "默认 continuation prompt",
      prompt: undefined,
      expected: INCOMPLETE_CONTINUATION_PROMPT,
    },
    {
      label: "用户提供的 prompt",
      prompt: "Re-check the decoded payload before submitting the flag.",
      expected: "Re-check the decoded payload before submitting the flag.",
    },
  ])("使用$label重试原 attempt 和 Pi session", async ({ prompt, expected }) => {
    const item = challenge(prompt ? 102 : 101)
    const tracker = new SandboxTracker()
    const project = await fixture([item], tracker)
    const original = await project.createSolver(item.id, {
      agent: solvingAgent(item, 0),
      attempt: 7,
      source: "manual",
    })
    await original.close("failed", "等待人工重试")
    const scheduler = new ContestScheduler(project, {
      maxConcurrent: 1,
      createAgentOptions: () => solvingAgent(item, 0),
    })

    try {
      await scheduler.retryAttempt(original.runId, { prompt })
      await waitUntil(
        () =>
          project.isChallengeSolved(item.id) &&
          scheduler.snapshot().active.length === 0,
      )

      expect(project.runs({ challengeId: item.id })).toEqual([
        expect.objectContaining({
          id: original.runId,
          attempt: 7,
          source: "manual",
          status: "solved",
        }),
      ])
      expect(
        await readFile(project.runSessionPath(original.runId), "utf8"),
      ).toContain(expected)
      expect(
        project
          .runEvents(original.runId)
          .filter((event) => event.type === "run_resumed"),
      ).toHaveLength(1)
    } finally {
      await scheduler.shutdown()
      await project.close()
    }
  })

  it("拒绝不存在或仍在运行的 Run 重试", async () => {
    const item = challenge(103)
    const tracker = new SandboxTracker()
    const project = await fixture([item], tracker)
    const scheduler = new ContestScheduler(project, {
      maxConcurrent: 1,
      createAgentOptions: () => solvingAgent(item, 0),
    })

    try {
      await expect(scheduler.retryAttempt("missing-run")).rejects.toMatchObject(
        {
          code: "run_not_found",
        },
      )
      const running = await project.createSolver(item.id, {
        agent: solvingAgent(item, 0),
        attempt: 1,
        source: "manual",
      })
      await expect(scheduler.retryAttempt(running.runId)).rejects.toMatchObject(
        { code: "run_not_retryable" },
      )
      await running.close("manual")
    } finally {
      await scheduler.shutdown()
      await project.close()
    }
  })

  it.each([
    { label: "输出达到 token 上限", stopReason: "length" as const },
    { label: "模型过早正常结束", stopReason: "stop" as const },
    {
      label: "WebSocket 断连",
      stopReason: "error" as const,
      errorMessage: "websocket disconnected",
    },
  ])(
    "$label 时按分类在同一 Run 内 continuation",
    async ({ stopReason, errorMessage }) => {
      const item = challenge(99)
      const tracker = new SandboxTracker()
      const project = await fixture([item], tracker)
      let sessions = 0
      const scheduler = new ContestScheduler(project, {
        maxConcurrent: 1,
        maxAttempts: 1,
        retryDelayMs: 0,
        infrastructureRetryDelayMs: 0,
        transientRetryDelaysMs: [0, 0, 0],
        createAgentOptions: () => {
          sessions++
          const faux = createFauxCore({
            provider: `continuation-${stopReason}`,
          })
          faux.setResponses([
            fauxAssistantMessage("分析尚未完成。", {
              stopReason,
              ...(errorMessage ? { errorMessage } : {}),
            }),
            fauxAssistantMessage(
              fauxToolCall(
                "ctf_submit_flag",
                { flag: item.flag },
                { id: `continued-submit-${stopReason}` },
              ),
              { stopReason: "toolUse" },
            ),
            fauxAssistantMessage("已提交。"),
          ])
          return {
            streamFn: faux.streamSimple as AgentOptions["streamFn"],
            initialState: { model: faux.getModel(), thinkingLevel: "off" },
          }
        },
      })

      try {
        await scheduler.dispatch(item.id)
        await waitUntil(
          () =>
            project.isChallengeSolved(item.id) &&
            scheduler.snapshot().active.length === 0,
        )

        const runs = project.runs({ challengeId: item.id })
        expect(runs).toEqual([
          expect.objectContaining({
            attempt: 1,
            status: "solved",
            closeReason: "submitted",
          }),
        ])
        expect(sessions).toBe(1)
        const continuedRun = runs[0]
        const continuedSession = await readFile(
          join(
            dirname(dirname(dirname(continuedRun?.workspace ?? ""))),
            "runs",
            continuedRun?.id ?? "missing",
            "session.jsonl",
          ),
          "utf8",
        )
        expect(continuedSession).toContain(INCOMPLETE_CONTINUATION_PROMPT)
        expect(project.sessionInterruptionCount(item.id)).toBe(0)
        expect(project.challengeBlockEvents(item.id)).toHaveLength(
          stopReason === "error" ? 0 : 1,
        )
        expect(
          project
            .runEvents(continuedRun?.id ?? "")
            .filter((event) => event.type === "run_transient_failure"),
        ).toHaveLength(stopReason === "error" ? 1 : 0)
        expect(project.schedulerAttemptCount(item.id)).toBe(1)
      } finally {
        await scheduler.shutdown()
        await project.close()
      }
    },
  )

  it("同一 attempt 对连续 fetch failed 仅提供三次退避重试", async () => {
    expect(DEFAULT_TRANSIENT_RETRY_DELAYS_MS).toEqual([10_000, 60_000, 300_000])
    const item = challenge(96)
    const tracker = new SandboxTracker()
    const project = await fixture([item], tracker)
    const faux = createFauxCore({ provider: "transient-exhaustion" })
    faux.setResponses(
      Array.from({ length: 4 }, () =>
        fauxAssistantMessage("network unavailable", {
          stopReason: "error",
          errorMessage: "fetch failed",
        }),
      ),
    )
    const scheduler = new ContestScheduler(project, {
      maxConcurrent: 1,
      maxAttempts: 1,
      transientRetryDelaysMs: [0, 0, 0],
      createAgentOptions: () => ({
        streamFn: faux.streamSimple as AgentOptions["streamFn"],
        initialState: { model: faux.getModel(), thinkingLevel: "off" },
      }),
    })
    try {
      await scheduler.dispatch(item.id)
      await waitUntil(() => scheduler.snapshot().active.length === 0)

      const [run] = project.runs({ challengeId: item.id })
      expect(run).toMatchObject({
        attempt: 1,
        status: "failed",
        closeReason: "failed",
      })
      expect(faux.state.callCount).toBe(4)
      const failures = project
        .runEvents(run?.id ?? "")
        .filter((event) => event.type === "run_transient_failure")
      expect(failures.map((event) => event.data)).toEqual([
        expect.objectContaining({ failureNumber: 1, retryScheduled: true }),
        expect.objectContaining({ failureNumber: 2, retryScheduled: true }),
        expect.objectContaining({ failureNumber: 3, retryScheduled: true }),
        expect.objectContaining({ failureNumber: 4, retryScheduled: false }),
      ])
      expect(project.challengeBlockEvents(item.id)).toHaveLength(0)
    } finally {
      await scheduler.shutdown()
      await project.close()
    }
  })

  it("在 compact 边界记录 delta=2 并继续同一 Run", async () => {
    const item = challenge(97)
    const tracker = new SandboxTracker()
    const project = await fixture([item], tracker)
    const faux = createFauxCore({
      provider: "compact-boundary",
      models: [
        {
          id: "compact-model",
          contextWindow: 22_000,
          maxTokens: 4_096,
        },
      ],
    })
    faux.setResponses([
      fauxAssistantMessage("开始分析。"),
      fauxAssistantMessage("compact summary"),
      fauxAssistantMessage(
        fauxToolCall(
          "ctf_submit_flag",
          { flag: item.flag },
          { id: "compact-submit" },
        ),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("已提交。"),
    ])
    const scheduler = new ContestScheduler(project, {
      maxConcurrent: 1,
      createAgentOptions: () => ({
        streamFn: faux.streamSimple as AgentOptions["streamFn"],
        initialState: {
          model: faux.getModel(),
          thinkingLevel: "off",
          messages: [
            { role: "user", content: "x".repeat(20_000), timestamp: 1 },
          ],
        },
      }),
    })

    try {
      await scheduler.dispatch(item.id)
      await waitUntil(
        () =>
          project.isChallengeSolved(item.id) &&
          scheduler.snapshot().active.length === 0,
      )
      const [run] = project.runs({ challengeId: item.id })
      expect(run).toBeDefined()
      const session = await readFile(
        join(
          dirname(dirname(dirname(run?.workspace ?? ""))),
          "runs",
          run?.id ?? "missing",
          "session.jsonl",
        ),
        "utf8",
      )
      expect(session).not.toContain(
        '<challenge_blackboard encoding=\\"json\\">',
      )
      expect(
        session.match(/<challenge_context>\\n/g)?.length,
      ).toBeGreaterThanOrEqual(2)
      expect(session).toContain("compact summary")
      expect(session).toContain('<active_subagents encoding=\\"json\\">')
      expect(session).toContain("<challenge_announcements>")
      const recoveredTurn = session
        .split(/\r?\n/)
        .find(
          (line) =>
            line.includes("<challenge_context>") &&
            line.includes("<challenge_announcements>") &&
            line.includes("<active_subagents") &&
            line.includes(INCOMPLETE_CONTINUATION_PROMPT),
        )
      expect(recoveredTurn).toBeDefined()
      expect(project.challengeBlockEvents(item.id)).toEqual([
        expect.objectContaining({ delta: 1, reason: "model_stop" }),
        expect.objectContaining({
          delta: 2,
          reason: "context_pressure",
          compactPerformed: true,
        }),
      ])
      expect(faux.state.callCount).toBe(3)
    } finally {
      await scheduler.shutdown()
      await project.close()
    }
  })

  it("连续 Session 中断超过阈值后 blocked，并可由人工 force 重置", async () => {
    const item = challenge(98)
    const tracker = new SandboxTracker()
    const project = await fixture([item], tracker)
    let solveAfterIntervention = false
    const scheduler = new ContestScheduler(project, {
      maxConcurrent: 1,
      maxAttempts: 1,
      maxSessionInterruptions: 1,
      createAgentOptions: () => {
        if (solveAfterIntervention) return solvingAgent(item, 0)
        const faux = createFauxCore({ provider: "always-interrupted" })
        faux.setResponses([fauxAssistantMessage("还没有 flag")])
        return {
          streamFn: faux.streamSimple as AgentOptions["streamFn"],
          initialState: { model: faux.getModel(), thinkingLevel: "off" },
        }
      },
    })

    try {
      await scheduler.dispatch(item.id)
      await waitUntil(
        () =>
          project.runs({ challengeId: item.id }).at(-1)?.status === "blocked" &&
          scheduler.snapshot().active.length === 0,
      )

      expect(project.runs({ challengeId: item.id })).toEqual([
        expect.objectContaining({ status: "blocked", closeReason: "blocked" }),
      ])
      expect(project.sessionInterruptionCount(item.id)).toBe(0)
      expect(project.challengeBlockEvents(item.id)).toHaveLength(2)
      const blockedRun = project.runs({ challengeId: item.id })[0]
      expect(
        project.runEvents(blockedRun?.id ?? "").map((event) => event.type),
      ).toEqual(
        expect.arrayContaining(["run_blocking", "block_finalization_failed"]),
      )
      expect(project.isChallengeBlocked(item.id)).toBe(true)
      expect(project.challengeRuntimeState(item.id).blockScore).toBe(2)
      expect(project.schedulerAttemptCount(item.id)).toBe(0)
      await expect(scheduler.dispatch(item.id)).rejects.toMatchObject({
        code: "blocked",
      })

      solveAfterIntervention = true
      await scheduler.dispatch(item.id, { force: true })
      await waitUntil(
        () =>
          project.isChallengeSolved(item.id) &&
          scheduler.snapshot().active.length === 0,
      )
      expect(project.sessionInterruptionCount(item.id)).toBe(0)
      expect(project.challengeRuntimeState(item.id)).toMatchObject({
        revivalCount: 1,
        effectiveBlockThreshold: 14,
        blocked: false,
      })
      expect(project.isChallengeBlocked(item.id)).toBe(false)
    } finally {
      await scheduler.shutdown()
      await project.close()
    }
  })

  it("自动模式按并发上限调度全部未解题，并记录 auto 来源", async () => {
    const challenges = [challenge(1), challenge(2), challenge(3), challenge(4)]
    const byId = new Map(challenges.map((item) => [item.id, item]))
    const tracker = new SandboxTracker()
    const project = await fixture(challenges, tracker)
    const scheduler = new ContestScheduler(project, {
      maxConcurrent: 2,
      maxAttempts: 2,
      createAgentOptions: ({ challenge: summary }) =>
        solvingAgent(requiredChallenge(byId.get(summary.id))),
    })

    try {
      await scheduler.startAuto()
      await waitUntil(
        () =>
          project.runs().filter((run) => run.status === "solved").length ===
            4 && scheduler.snapshot().active.length === 0,
      )

      expect(scheduler.snapshot()).toMatchObject({
        autoEnabled: true,
        queued: [],
        active: [],
      })
      expect(project.runs()).toHaveLength(4)
      expect(project.runs().every((run) => run.source === "auto")).toBe(true)
      const [firstRun] = project.runs()
      if (!firstRun) throw new Error("调度器未创建 Run")
      expect(project.runEvents(firstRun.id)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "tool_started",
            data: expect.objectContaining({
              toolName: "bash",
              args: {
                command: `printf '%s' '${byId.get(firstRun.challengeId)?.flag}'`,
              },
            }),
          }),
          expect.objectContaining({
            type: "flag_submitted",
            data: expect.objectContaining({
              flag: byId.get(firstRun.challengeId)?.flag,
              status: "accepted",
            }),
          }),
        ]),
      )
      expect(tracker.maximum).toBeLessThanOrEqual(2)
      expect(tracker.maximum).toBeGreaterThan(1)
    } finally {
      await scheduler.shutdown()
      await project.close()
    }
  })

  it("自主模式暂停时仍允许人工调度，并可取消活跃题目", async () => {
    const item = challenge(1)
    const tracker = new SandboxTracker()
    const project = await fixture([item], tracker)
    const scheduler = new ContestScheduler(project, {
      maxConcurrent: 1,
      maxAttempts: 2,
      createAgentOptions: () => solvingAgent(item, 500),
    })

    try {
      expect(scheduler.snapshot().autoEnabled).toBe(false)
      await scheduler.dispatch(item.id)
      await waitUntil(() => scheduler.snapshot().active[0]?.runId !== null)
      expect(scheduler.snapshot().active[0]?.source).toBe("manual")

      await scheduler.cancel(item.id)
      await waitUntil(() => scheduler.snapshot().active.length === 0)
      expect(project.runs()).toEqual([
        expect.objectContaining({
          challengeId: item.id,
          source: "manual",
          status: "cancelled",
          closeReason: "cancelled",
        }),
      ])
      expect(tracker.active).toBe(0)
    } finally {
      await scheduler.shutdown()
      await project.close()
    }
  })

  it("暂停自主模式后清空等待队列，但不取消活跃任务", async () => {
    const challenges = [challenge(1), challenge(2)]
    const tracker = new SandboxTracker()
    const project = await fixture(challenges, tracker)
    const scheduler = new ContestScheduler(project, {
      maxConcurrent: 1,
      maxAttempts: 1,
      createAgentOptions: ({ challenge: summary }) =>
        solvingAgent(
          requiredChallenge(challenges.find((item) => item.id === summary.id)),
          500,
        ),
    })

    try {
      await scheduler.startAuto()
      await waitUntil(
        () =>
          scheduler.snapshot().active.length === 1 &&
          scheduler.snapshot().queued.length === 1,
      )
      const activeId = scheduler.snapshot().active[0]?.challengeId
      const queuedId = scheduler.snapshot().queued[0]?.challengeId

      scheduler.pauseAuto()
      if (!activeId) throw new Error("自主调度未创建活跃任务")

      expect(scheduler.snapshot()).toMatchObject({
        autoEnabled: false,
        queued: [],
        active: [expect.objectContaining({ challengeId: activeId })],
      })
      expect(project.runs({ challengeId: queuedId })).toHaveLength(0)
      await scheduler.cancel(activeId)
      await waitUntil(() => scheduler.snapshot().active.length === 0)
    } finally {
      await scheduler.shutdown()
      await project.close()
    }
  })

  it("暂停自主模式会同时清除此前补发的 manual 等待任务", async () => {
    const challenges = [challenge(1), challenge(2), challenge(3)]
    const tracker = new SandboxTracker()
    const project = await fixture(challenges, tracker)
    const scheduler = new ContestScheduler(project, {
      maxConcurrent: 1,
      maxAttempts: 1,
      createAgentOptions: ({ challenge: summary }) =>
        solvingAgent(
          requiredChallenge(challenges.find((item) => item.id === summary.id)),
          500,
        ),
    })

    try {
      const first = requiredChallenge(challenges[0])
      const second = requiredChallenge(challenges[1])
      const third = requiredChallenge(challenges[2])
      await scheduler.dispatch(first.id)
      await waitUntil(() => scheduler.snapshot().active.length === 1)
      await scheduler.dispatch(second.id)
      await scheduler.dispatch(third.id)
      expect(scheduler.snapshot().queued.map((item) => item.source)).toEqual([
        "manual",
        "manual",
      ])

      scheduler.pauseAuto()
      expect(scheduler.snapshot().queued).toEqual([])
      const activeId = scheduler.snapshot().active[0]?.challengeId
      if (activeId) await scheduler.cancel(activeId)
    } finally {
      await scheduler.shutdown()
      await project.close()
    }
  })

  it("运行时更新并发上限并立即补充 worker", async () => {
    const challenges = [challenge(1), challenge(2), challenge(3)]
    const tracker = new SandboxTracker()
    const project = await fixture(challenges, tracker)
    const persisted: number[] = []
    const scheduler = new ContestScheduler(project, {
      maxConcurrent: 1,
      maxAttempts: 1,
      onMaxConcurrentChange: (value) => {
        persisted.push(value)
      },
      createAgentOptions: ({ challenge: summary }) =>
        solvingAgent(
          requiredChallenge(challenges.find((item) => item.id === summary.id)),
          300,
        ),
    })

    try {
      await scheduler.startAuto()
      await waitUntil(
        () =>
          scheduler.snapshot().active.length === 1 &&
          scheduler.snapshot().queued.length === 2,
      )
      await scheduler.setMaxConcurrent(2)
      await waitUntil(() => scheduler.snapshot().active.length === 2)
      expect(scheduler.snapshot().maxConcurrent).toBe(2)
      expect(persisted).toEqual([2])
      await expect(scheduler.setMaxConcurrent(0)).rejects.toThrow("正整数")
      await expect(scheduler.setMaxConcurrent(65)).rejects.toThrow(
        "不能超过 64",
      )
    } finally {
      await scheduler.shutdown()
      await project.close()
    }
  })

  it("未配置模型时拒绝控制操作", async () => {
    const item = challenge(1)
    const project = await fixture([item], new SandboxTracker())
    const scheduler = new ContestScheduler(project, {
      maxConcurrent: 1,
      available: false,
      unavailableReason: "missing model",
      createAgentOptions: () => solvingAgent(item),
    })
    try {
      await expect(scheduler.startAuto()).rejects.toMatchObject({
        code: "unavailable",
      } satisfies Partial<ContestSchedulerError>)
      await expect(scheduler.dispatch(item.id)).rejects.toMatchObject({
        code: "unavailable",
      } satisfies Partial<ContestSchedulerError>)
    } finally {
      await scheduler.shutdown()
      await project.close()
    }
  })

  it("运行时配置模型后立即开放调度操作", async () => {
    const item = challenge(1)
    const project = await fixture([item], new SandboxTracker())
    let configured = false
    const scheduler = new ContestScheduler(project, {
      maxConcurrent: 1,
      availability: () => ({
        available: configured,
        ...(configured ? {} : { unavailableReason: "missing model" }),
      }),
      createAgentOptions: () => solvingAgent(item),
    })
    try {
      expect(scheduler.snapshot()).toMatchObject({
        available: false,
        unavailableReason: "missing model",
      })
      await expect(scheduler.dispatch(item.id)).rejects.toMatchObject({
        code: "unavailable",
      } satisfies Partial<ContestSchedulerError>)

      configured = true
      expect(scheduler.snapshot().available).toBe(true)
      await scheduler.dispatch(item.id)
      await waitUntil(
        () =>
          project.runs().some((run) => run.status === "solved") &&
          scheduler.snapshot().active.length === 0,
      )
      expect(project.runs()[0]).toMatchObject({
        challengeId: item.id,
        status: "solved",
      })
    } finally {
      await scheduler.shutdown()
      await project.close()
    }
  })

  it("首次创建时附件下载失败可重试且不消耗解题预算", async () => {
    const item = challenge(1, {
      attachments: [{ id: "chall", name: "chall", content: "payload" }],
      failures: { download: 1 },
    })
    const tracker = new SandboxTracker()
    const project = await fixture([item], tracker)
    const scheduler = new ContestScheduler(project, {
      maxConcurrent: 1,
      maxAttempts: 1,
      retryDelayMs: 0,
      infrastructureRetryDelayMs: 0,
      createAgentOptions: () => solvingAgent(item),
    })
    try {
      await scheduler.startAuto()
      await waitUntil(
        () =>
          project.isChallengeSolved(item.id) &&
          scheduler.snapshot().active.length === 0,
      )

      expect(project.runs({ challengeId: item.id })).toEqual([
        expect.objectContaining({
          attempt: 1,
          status: "failed",
          error: expect.stringContaining("测试故障"),
        }),
        expect.objectContaining({ attempt: 2, status: "solved" }),
      ])
      expect(project.schedulerAttemptCount(item.id)).toBe(1)
    } finally {
      await scheduler.shutdown()
      await project.close()
    }
  })

  it("首次创建时非附件错误直接阻塞且不创建新 attempt", async () => {
    const item = challenge(2, {
      failures: { bind: 1 },
      retryableFailures: { bind: true },
    })
    const tracker = new SandboxTracker()
    const project = await fixture([item], tracker)
    const scheduler = new ContestScheduler(project, {
      maxConcurrent: 1,
      maxAttempts: 3,
      retryDelayMs: 0,
      infrastructureRetryDelayMs: 0,
      createAgentOptions: () => solvingAgent(item),
    })
    try {
      await scheduler.dispatch(item.id)
      await waitUntil(
        () =>
          project.isChallengeBlocked(item.id) &&
          scheduler.snapshot().active.length === 0,
      )

      const runs = project.runs({ challengeId: item.id })
      expect(runs).toEqual([
        expect.objectContaining({ attempt: 1, status: "blocked" }),
      ])
      expect(
        project.runEvents(runs[0]?.id ?? "").map((event) => event.type),
      ).toContain("run_creation_blocked")
    } finally {
      await scheduler.shutdown()
      await project.close()
    }
  })
})

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("等待调度状态超时")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
