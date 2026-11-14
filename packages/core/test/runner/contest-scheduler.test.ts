import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { INCOMPLETE_CONTINUATION_PROMPT } from "@ctf-agent/prompts"
import type {
  CommandResult,
  DockerSandboxOptions,
  DockerWorkspaceMount,
  Sandbox,
} from "@ctf-agent/sandbox"
import type { AgentOptions } from "@earendil-works/pi-agent-core"
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux"
import { afterEach, describe, expect, it, vi } from "vite-plus/test"
import {
  ContestScheduler,
  type ContestSchedulerError,
  DEFAULT_TRANSIENT_RETRY_DELAYS_MS,
} from "../../src/orchestration/contest-scheduler.ts"
import { Project } from "../../src/project/project.ts"
import { type TestChallenge, TestPlatformPlugin } from "../fake-platform.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
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
        if (payload.op === "info") {
          const content = this.files.get(payload.path)
          return {
            code: 0,
            stdout: JSON.stringify(
              content
                ? {
                    ok: true,
                    value: {
                      name: "file",
                      path: payload.path,
                      kind: "file",
                      size: content.byteLength,
                      mtimeMs: 0,
                    },
                  }
                : { ok: false, code: "not_found", message: "not found", path: payload.path },
            ),
            stderr: "",
          }
        }
        if (payload.op === "sha256") {
          const content = this.files.get(payload.path)
          return {
            code: 0,
            stdout: JSON.stringify(
              content
                ? { ok: true, value: createHash("sha256").update(content).digest("hex") }
                : { ok: false, code: "not_found", message: "not found", path: payload.path },
            ),
            stderr: "",
          }
        }
        if (payload.op === "replace") {
          this.files.set(payload.path, Buffer.from(payload.base64 ?? "", "base64"))
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

function challenge(index: number, options: Partial<TestChallenge> = {}): TestChallenge {
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

async function fixture(
  challenges: TestChallenge[],
  tracker: SandboxTracker,
  options: {
    maxRemoteEnvironments?: number
    removeManagedSandboxes?: (runIds: readonly string[]) => Promise<void>
    clearWorkspace?: (input: {
      image: string
      workspace: string
      workspaceMount: DockerWorkspaceMount
    }) => Promise<void>
  } = {},
) {
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
    remoteEnvironments: { maxConcurrent: options.maxRemoteEnvironments ?? 1 },
    ...(options.removeManagedSandboxes
      ? { removeManagedSandboxes: options.removeManagedSandboxes }
      : {}),
    ...(options.clearWorkspace ? { clearWorkspace: options.clearWorkspace } : {}),
  })
  return project
}

async function reopenFixture(root: string, tracker: SandboxTracker): Promise<Project> {
  return Project.open({
    root,
    platforms: [new TestPlatformPlugin()],
    sandboxFactory: tracker.create,
    telemetry: { level: "full" },
    remoteEnvironments: { maxConcurrent: 1 },
  })
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function environmentAgent(
  item: TestChallenge,
  options: {
    beforeSubmit?: Promise<void>
    onEnvironmentReady?: () => void
  } = {},
): AgentOptions {
  const faux = createFauxCore({ provider: `environment-${item.id}` })
  faux.setResponses([
    async () => {
      return fauxAssistantMessage(
        fauxToolCall("ctf_instance_start", {}, { id: `instance-start-${item.id}` }),
        { stopReason: "toolUse" },
      )
    },
    async () => {
      options.onEnvironmentReady?.()
      await options.beforeSubmit
      return fauxAssistantMessage(
        fauxToolCall("ctf_submit_flag", { flag: item.flag }, { id: `submit-${item.id}` }),
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

function controlledSolvingAgent(
  item: TestChallenge,
  beforeSubmit: Promise<void>,
  onStarted?: () => void,
): AgentOptions {
  const faux = createFauxCore({ provider: `controlled-${item.id}` })
  faux.setResponses([
    async () => {
      onStarted?.()
      await beforeSubmit
      return fauxAssistantMessage(
        fauxToolCall("ctf_submit_flag", { flag: item.flag }, { id: `submit-${item.id}` }),
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

function solvingAgent(item: TestChallenge, delayMs = 0): AgentOptions {
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
          fauxToolCall("ctf_submit_flag", { flag: item.flag }, { id: `submit-${item.id}` }),
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
  it("不将人工排除或标记已解出的题目加入任何调度队列", async () => {
    const skipped = challenge(90)
    const solved = challenge(91)
    const tracker = new SandboxTracker()
    const project = await fixture([skipped, solved], tracker)
    project.enqueueSchedulerChallenge({
      challengeId: skipped.id,
      source: "auto",
    })
    project.setChallengeSchedulingDisposition(skipped.id, "excluded")
    project.setChallengeSchedulingDisposition(solved.id, "solved")
    const scheduler = new ContestScheduler(project, {
      maxConcurrent: 1,
      createAgentOptions: () => solvingAgent(skipped),
    })

    try {
      await scheduler.startAuto()
      expect(scheduler.snapshot()).toMatchObject({ queued: [], active: [] })
      expect(project.schedulerQueue()).toEqual([])
      expect(project.runs()).toEqual([])
      expect(project.isChallengeSolved(solved.id)).toBe(true)
      await expect(scheduler.dispatch(skipped.id, { force: true })).rejects.toMatchObject({
        code: "excluded",
      })
      await expect(scheduler.dispatch(solved.id, { force: true })).rejects.toMatchObject({
        code: "excluded",
      })
    } finally {
      await scheduler.shutdown()
      await project.close()
    }
  })

  it("writeup 模型错误后的重试继续 writeup，而不是重新注入解题 continuation", async () => {
    const item = challenge(103)
    const tracker = new SandboxTracker()
    const project = await fixture([item], tracker)
    const faux = createFauxCore({ provider: `writeup-retry-${item.id}` })
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("ctf_submit_flag", { flag: item.flag }, { id: "submit-writeup-retry" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("writeup model failed", {
        stopReason: "error",
        errorMessage: "provider unavailable",
      }),
      fauxAssistantMessage("writeup complete", { stopReason: "stop" }),
    ])
    const scheduler = new ContestScheduler(project, {
      maxConcurrent: 1,
      maxAttempts: 1,
      writeup: true,
      createAgentOptions: () => ({
        streamFn: faux.streamSimple as AgentOptions["streamFn"],
        initialState: { model: faux.getModel(), thinkingLevel: "off" },
      }),
    })

    try {
      await scheduler.dispatch(item.id)
      await waitUntil(() => scheduler.snapshot().active.length === 0)
      const [failedRun] = project.runs({ challengeId: item.id })
      expect(failedRun).toEqual(
        expect.objectContaining({ status: "solved", closeReason: "submitted" }),
      )
      expect(project.runEvents(failedRun?.id ?? "").map((event) => event.type)).toContain(
        "writeup_failed",
      )
      expect(project.runEvents(failedRun?.id ?? "")).toContainEqual(
        expect.objectContaining({
          type: "run_submission_accepted",
          data: expect.objectContaining({ status: "accepted", flag: item.flag }),
        }),
      )

      await writeFile(
        join(failedRun?.workspace ?? "", "writeup.md"),
        `# Challenge ${item.id}\n\n## Summary\nSolved.\n## Analysis\n(None)\n## Vulnerability or Weakness\n(None)\n## Solution / Exploitation\n(None)\n## Reproduction\n(None)\n## Relevant Artifacts\n(None)\n## Flag\n${item.flag}\n`,
      )
      await scheduler.retryAttempt(failedRun?.id ?? "")
      await waitUntil(
        () => project.isChallengeSolved(item.id) && scheduler.snapshot().active.length === 0,
      )

      const [run] = project.runs({ challengeId: item.id })
      const session = await readFile(
        join(
          dirname(dirname(dirname(run?.workspace ?? ""))),
          "runs",
          run?.id ?? "missing",
          "session.jsonl",
        ),
        "utf8",
      )
      expect(session).toContain(
        "The flag was accepted. Write a complete, reproducible English writeup",
      )
      expect(session).not.toContain(INCOMPLETE_CONTINUATION_PROMPT)
      expect(run).toEqual(expect.objectContaining({ status: "solved", closeReason: "submitted" }))
    } finally {
      await scheduler.shutdown()
      await project.close()
    }
  })

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
        () => project.isChallengeSolved(item.id) && scheduler.snapshot().active.length === 0,
      )

      expect(project.runs({ challengeId: item.id })).toEqual([
        expect.objectContaining({
          id: original.runId,
          attempt: 7,
          source: "manual",
          status: "solved",
        }),
      ])
      expect(await readFile(project.runSessionPath(original.runId), "utf8")).toContain(expected)
      expect(
        project.runEvents(original.runId).filter((event) => event.type === "run_resumed"),
      ).toHaveLength(1)
    } finally {
      await scheduler.shutdown()
      await project.close()
    }
  })

  it("恢复异常中断的调度 attempt 时复用原 Run 并使用默认 continuation prompt", async () => {
    const item = challenge(104)
    const tracker = new SandboxTracker()
    const project = await fixture([item], tracker)
    const interrupted = await project.createSolver(item.id, {
      agent: solvingAgent(item),
      attempt: 1,
      source: "manual",
    })
    await interrupted.close("interrupted", "测试进程重启")
    project.startScheduler("manual")

    const scheduler = new ContestScheduler(project, {
      maxConcurrent: 1,
      maxAttempts: 1,
      createAgentOptions: () => solvingAgent(item),
    })

    try {
      await scheduler.restore()
      await waitUntil(
        () => project.isChallengeSolved(item.id) && scheduler.snapshot().active.length === 0,
      )

      expect(project.runs({ challengeId: item.id })).toEqual([
        expect.objectContaining({
          id: interrupted.runId,
          attempt: 1,
          status: "solved",
          closeReason: "submitted",
        }),
      ])
      expect(await readFile(project.runSessionPath(interrupted.runId), "utf8")).toContain(
        INCOMPLETE_CONTINUATION_PROMPT,
      )
      expect(
        project.runEvents(interrupted.runId).filter((event) => event.type === "run_resumed"),
      ).toHaveLength(1)
    } finally {
      await scheduler.shutdown()
      await project.close()
    }
  })

  it.each(["failed", "timed_out", "cancelled", "interrupted"] as const)(
    "手动派发 %s Attempt 时复用原 Run，而不是创建新 attempt",
    async (closeReason) => {
      const item = challenge(
        106 + ["failed", "timed_out", "cancelled", "interrupted"].indexOf(closeReason),
      )
      const tracker = new SandboxTracker()
      const project = await fixture([item], tracker)
      const original = await project.createSolver(item.id, {
        agent: solvingAgent(item),
        attempt: 1,
        source: "manual",
      })
      await original.close(closeReason, `测试 ${closeReason}`)
      const scheduler = new ContestScheduler(project, {
        maxConcurrent: 1,
        maxAttempts: 1,
        createAgentOptions: () => solvingAgent(item),
      })

      try {
        await scheduler.dispatch(item.id)
        await waitUntil(
          () => project.isChallengeSolved(item.id) && scheduler.snapshot().active.length === 0,
        )

        expect(project.runs({ challengeId: item.id })).toEqual([
          expect.objectContaining({
            id: original.runId,
            attempt: 1,
            status: "solved",
            closeReason: "submitted",
          }),
        ])
        expect(
          project.runEvents(original.runId).filter((event) => event.type === "run_resumed"),
        ).toHaveLength(1)
      } finally {
        await scheduler.shutdown()
        await project.close()
      }
    },
  )

  it("拒绝不存在或仍在运行的 Run 重试", async () => {
    const item = challenge(103)
    const tracker = new SandboxTracker()
    const project = await fixture([item], tracker)
    const scheduler = new ContestScheduler(project, {
      maxConcurrent: 1,
      createAgentOptions: () => solvingAgent(item, 0),
    })

    try {
      await expect(scheduler.retryAttempt("missing-run")).rejects.toMatchObject({
        code: "run_not_found",
      })
      const running = await project.createSolver(item.id, {
        agent: solvingAgent(item, 0),
        attempt: 1,
        source: "manual",
      })
      await expect(scheduler.retryAttempt(running.runId)).rejects.toMatchObject({
        code: "run_not_retryable",
      })
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
  ])("$label 时按分类在同一 Run 内 continuation", async ({ stopReason, errorMessage }) => {
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
        () => project.isChallengeSolved(item.id) && scheduler.snapshot().active.length === 0,
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
      expect(project.challengeBlockEvents(item.id)).toHaveLength(stopReason === "error" ? 0 : 1)
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
  })

  it("Request aborted 耗尽瞬时重试后恢复原 attempt，而不是创建新 attempt", async () => {
    const item = challenge(105)
    const tracker = new SandboxTracker()
    const project = await fixture([item], tracker)
    const faux = createFauxCore({ provider: "request-aborted-recovery" })
    faux.setResponses([
      ...Array.from({ length: 4 }, () =>
        fauxAssistantMessage("Request aborted", {
          stopReason: "error",
          errorMessage: "Request aborted",
        }),
      ),
      fauxAssistantMessage(
        fauxToolCall("ctf_submit_flag", { flag: item.flag }, { id: "aborted-recovery-submit" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("已提交。"),
    ])
    const scheduler = new ContestScheduler(project, {
      maxConcurrent: 1,
      maxAttempts: 1,
      retryDelayMs: 0,
      infrastructureRetryDelayMs: 0,
      transientRetryDelaysMs: [0, 0, 0],
      createAgentOptions: () => ({
        streamFn: faux.streamSimple as AgentOptions["streamFn"],
        initialState: { model: faux.getModel(), thinkingLevel: "off" },
      }),
    })

    try {
      await scheduler.dispatch(item.id)
      await waitUntil(
        () => project.isChallengeSolved(item.id) && scheduler.snapshot().active.length === 0,
      )

      const runs = project.runs({ challengeId: item.id })
      expect(runs).toEqual([
        expect.objectContaining({
          attempt: 1,
          status: "solved",
          closeReason: "submitted",
        }),
      ])
      expect(faux.state.callCount).toBe(5)
      expect(project.runEvents(runs[0]?.id ?? "").map((event) => event.type)).toContain(
        "run_resumed",
      )
      expect(await readFile(project.runSessionPath(runs[0]?.id ?? ""), "utf8")).toContain(
        INCOMPLETE_CONTINUATION_PROMPT,
      )
    } finally {
      await scheduler.shutdown()
      await project.close()
    }
  })

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

  it("瞬时 Provider 故障耗尽后仍受 attempt 预算限制，不会无限创建新 Run", async () => {
    const item = challenge(95)
    const tracker = new SandboxTracker()
    const project = await fixture([item], tracker)
    const faux = createFauxCore({ provider: "bounded-transient-retries" })
    faux.setResponses(
      Array.from({ length: 12 }, () =>
        fauxAssistantMessage("network unavailable", {
          stopReason: "error",
          errorMessage: "fetch failed",
        }),
      ),
    )
    const scheduler = new ContestScheduler(project, {
      maxConcurrent: 1,
      maxAttempts: 2,
      retryDelayMs: 0,
      infrastructureRetryDelayMs: 0,
      transientRetryDelaysMs: [0, 0, 0],
      createAgentOptions: () => ({
        streamFn: faux.streamSimple as AgentOptions["streamFn"],
        initialState: { model: faux.getModel(), thinkingLevel: "off" },
      }),
    })
    try {
      await scheduler.dispatch(item.id)
      await waitUntil(() => scheduler.snapshot().active.length === 0)

      expect(faux.state.callCount).toBe(8)
      expect(project.runs({ challengeId: item.id })).toEqual([
        expect.objectContaining({ attempt: 1, status: "failed" }),
      ])
      expect(scheduler.snapshot().queued).toEqual([])
    } finally {
      await scheduler.shutdown()
      await project.close()
    }
  })

  it("免费额度耗尽时暂停自动调度，且不再创建新请求", async () => {
    const item = challenge(94)
    const tracker = new SandboxTracker()
    const project = await fixture([item], tracker)
    const faux = createFauxCore({ provider: "free-usage-limit" })
    faux.setResponses([
      fauxAssistantMessage("quota exhausted", {
        stopReason: "error",
        errorMessage:
          '429: {"type":"FreeUsageLimitError","message":"Rate limit exceeded. Please try again later."}',
      }),
    ])
    const scheduler = new ContestScheduler(project, {
      maxConcurrent: 1,
      maxAttempts: 3,
      retryDelayMs: 0,
      transientRetryDelaysMs: [0, 0, 0],
      createAgentOptions: () => ({
        streamFn: faux.streamSimple as AgentOptions["streamFn"],
        initialState: { model: faux.getModel(), thinkingLevel: "off" },
      }),
    })
    try {
      await scheduler.startAuto()
      await waitUntil(() => scheduler.snapshot().active.length === 0)

      expect(faux.state.callCount).toBe(1)
      expect(project.runs({ challengeId: item.id })).toHaveLength(1)
      expect(scheduler.snapshot()).toMatchObject({
        available: false,
        unavailableReason: expect.stringContaining("LLM 服务需要人工处理"),
      })
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
        fauxToolCall("ctf_submit_flag", { flag: item.flag }, { id: "compact-submit" }),
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
          messages: [{ role: "user", content: "x".repeat(20_000), timestamp: 1 }],
        },
      }),
    })

    try {
      await scheduler.dispatch(item.id)
      await waitUntil(
        () => project.isChallengeSolved(item.id) && scheduler.snapshot().active.length === 0,
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
      expect(session).not.toContain('<challenge_blackboard encoding=\\"json\\">')
      expect(session.match(/<challenge_context>\\n/g)?.length).toBeGreaterThanOrEqual(2)
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
      expect(project.runEvents(blockedRun?.id ?? "").map((event) => event.type)).toEqual(
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
        () => project.isChallengeSolved(item.id) && scheduler.snapshot().active.length === 0,
      )
      expect(project.sessionInterruptionCount(item.id)).toBe(0)
      expect(project.challengeRuntimeState(item.id)).toMatchObject({
        revivalCount: 1,
        effectiveBlockThreshold: 14,
        blocked: false,
      })
      expect(project.isChallengeBlocked(item.id)).toBe(false)
      expect(project.runs({ challengeId: item.id })).toEqual([
        expect.objectContaining({ attempt: 1, status: "blocked" }),
        expect.objectContaining({ attempt: 2, status: "solved" }),
      ])
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
          project.runs().filter((run) => run.status === "solved").length === 4 &&
          scheduler.snapshot().active.length === 0,
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

  it("远程环境已满时跳过无附件环境题，并严格限制 Solver 容器数", async () => {
    const holder = challenge(201, { remote: true })
    const waiting = challenge(202, { remote: true })
    const local = challenge(203)
    const tracker = new SandboxTracker()
    const project = await fixture([holder, waiting, local], tracker, {
      maxRemoteEnvironments: 1,
    })
    const holderReady = deferred()
    const waitingReady = deferred()
    const localStarted = deferred()
    const releaseHolder = deferred()
    const releaseWaiting = deferred()
    const releaseLocal = deferred()
    const scheduler = new ContestScheduler(project, {
      maxConcurrent: 2,
      maxAttempts: 1,
      createAgentOptions: ({ challenge: summary }) => {
        if (summary.id === holder.id) {
          return environmentAgent(holder, {
            beforeSubmit: releaseHolder.promise,
            onEnvironmentReady: holderReady.resolve,
          })
        }
        if (summary.id === waiting.id) {
          return environmentAgent(waiting, {
            beforeSubmit: releaseWaiting.promise,
            onEnvironmentReady: waitingReady.resolve,
          })
        }
        return controlledSolvingAgent(local, releaseLocal.promise, localStarted.resolve)
      },
    })

    try {
      await scheduler.dispatch(holder.id)
      await holderReady.promise
      await scheduler.dispatch(waiting.id)
      await scheduler.dispatch(local.id)
      await localStarted.promise

      expect(project.runs({ challengeId: waiting.id })).toHaveLength(0)
      expect(scheduler.snapshot().active).toHaveLength(2)
      expect(tracker.maximum).toBe(2)

      releaseHolder.resolve()
      await waitingReady.promise
      expect(tracker.maximum).toBe(2)

      releaseWaiting.resolve()
      releaseLocal.resolve()
      await waitUntil(() => scheduler.snapshot().active.length === 0)
      expect(tracker.active).toBe(0)
    } finally {
      releaseHolder.resolve()
      releaseWaiting.resolve()
      releaseLocal.resolve()
      await scheduler.shutdown()
      await project.close()
    }
  })

  it("有附件环境题可在远程槽满时本地启动，等待期间仍占一个容器槽", async () => {
    const holder = challenge(205, { remote: true })
    const waiting = challenge(206, {
      remote: true,
      summaryNeedsEnv: null,
      summaryHasAttachments: null,
      attachments: [{ id: "chall", name: "chall", content: "payload" }],
    })
    const local = challenge(207)
    const tracker = new SandboxTracker()
    const project = await fixture([holder, waiting, local], tracker, {
      maxRemoteEnvironments: 1,
    })
    const holderReady = deferred()
    const releaseHolder = deferred()
    const releaseLocal = deferred()
    const localStarted = deferred()
    const scheduler = new ContestScheduler(project, {
      maxConcurrent: 2,
      maxAttempts: 1,
      createAgentOptions: ({ challenge: summary }) => {
        if (summary.id === holder.id) {
          return environmentAgent(holder, {
            beforeSubmit: releaseHolder.promise,
            onEnvironmentReady: holderReady.resolve,
          })
        }
        if (summary.id === waiting.id) return environmentAgent(waiting)
        return controlledSolvingAgent(local, releaseLocal.promise, localStarted.resolve)
      },
    })

    try {
      await scheduler.dispatch(holder.id)
      await holderReady.promise
      await scheduler.dispatch(waiting.id)
      await waitUntil(
        () =>
          scheduler.snapshot().active.find((item) => item.challengeId === waiting.id)?.phase ===
          "waiting_environment",
      )
      await scheduler.dispatch(local.id)

      expect(project.runs({ challengeId: waiting.id })).toHaveLength(1)
      expect(project.runs({ challengeId: local.id })).toHaveLength(0)
      expect(tracker.maximum).toBe(2)

      await scheduler.cancel(waiting.id)
      await localStarted.promise
      expect(tracker.maximum).toBe(2)

      releaseLocal.resolve()
      releaseHolder.resolve()
      await waitUntil(() => scheduler.snapshot().active.length === 0)
      expect(tracker.active).toBe(0)
    } finally {
      releaseHolder.resolve()
      releaseLocal.resolve()
      await scheduler.shutdown()
      await project.close()
    }
  })

  it("降低容器上限不抢占现有 Solver，活跃数回落前不启动新题", async () => {
    const first = challenge(214)
    const second = challenge(215)
    const queued = challenge(216)
    const tracker = new SandboxTracker()
    const project = await fixture([first, second, queued], tracker)
    const releaseFirst = deferred()
    const releaseSecond = deferred()
    const firstStarted = deferred()
    const secondStarted = deferred()
    let queuedStarted = false
    const scheduler = new ContestScheduler(project, {
      maxConcurrent: 2,
      maxAttempts: 1,
      createAgentOptions: ({ challenge: summary }) => {
        if (summary.id === first.id) {
          return controlledSolvingAgent(first, releaseFirst.promise, firstStarted.resolve)
        }
        if (summary.id === second.id) {
          return controlledSolvingAgent(second, releaseSecond.promise, secondStarted.resolve)
        }
        queuedStarted = true
        return solvingAgent(queued)
      },
    })

    try {
      await scheduler.startAuto()
      await Promise.all([firstStarted.promise, secondStarted.promise])
      await scheduler.setMaxConcurrent(1)

      releaseFirst.resolve()
      await waitUntil(
        () => project.isChallengeSolved(first.id) && scheduler.snapshot().active.length === 1,
      )
      expect(queuedStarted).toBe(false)

      releaseSecond.resolve()
      await waitUntil(() => queuedStarted)
      await waitUntil(() => scheduler.snapshot().active.length === 0)
      expect(tracker.maximum).toBe(2)
    } finally {
      releaseFirst.resolve()
      releaseSecond.resolve()
      await scheduler.shutdown()
      await project.close()
    }
  })

  it("无附件环境题只按远程上限开容器，同时越过它启动本地题", async () => {
    const remote = [
      challenge(208, { remote: true }),
      challenge(209, { remote: true }),
      challenge(210, { remote: true }),
      challenge(212, { remote: true }),
      challenge(213, { remote: true }),
    ]
    const local = challenge(211)
    const tracker = new SandboxTracker()
    const project = await fixture([...remote, local], tracker, { maxRemoteEnvironments: 1 })
    const releaseFirst = deferred()
    const releaseLocal = deferred()
    const localStarted = deferred()
    const scheduler = new ContestScheduler(project, {
      maxConcurrent: 2,
      maxAttempts: 1,
      createAgentOptions: ({ challenge: summary }) => {
        if (summary.id === local.id) {
          return controlledSolvingAgent(local, releaseLocal.promise, localStarted.resolve)
        }
        return environmentAgent(
          requiredChallenge(remote.find((candidate) => candidate.id === summary.id)),
          { beforeSubmit: releaseFirst.promise },
        )
      },
    })

    try {
      await scheduler.startAuto()
      await localStarted.promise
      expect(project.runs({ challengeId: remote[0]?.id })).toHaveLength(1)
      for (const item of remote.slice(1)) {
        expect(project.runs({ challengeId: item.id })).toHaveLength(0)
      }
      expect(project.runs({ challengeId: local.id })).toHaveLength(1)
      expect(scheduler.snapshot().active).toHaveLength(2)
      expect(tracker.maximum).toBe(2)
    } finally {
      releaseFirst.resolve()
      releaseLocal.resolve()
      await scheduler.shutdown()
      await project.close()
    }
  })

  it("环境需求未知且无附件时保守占远程意图，不批量创建 Sandbox", async () => {
    const remote = Array.from({ length: 8 }, (_, index) =>
      challenge(230 + index, { remote: true, summaryNeedsEnv: null }),
    )
    const tracker = new SandboxTracker()
    const project = await fixture(remote, tracker, { maxRemoteEnvironments: 1 })
    const neverSubmit = deferred()
    const scheduler = new ContestScheduler(project, {
      maxConcurrent: 2,
      maxAttempts: 1,
      createAgentOptions: ({ challenge: summary }) =>
        environmentAgent(
          requiredChallenge(remote.find((candidate) => candidate.id === summary.id)),
          { beforeSubmit: neverSubmit.promise },
        ),
    })

    try {
      await scheduler.startAuto()
      await waitUntil(() => tracker.maximum === 1)

      expect(scheduler.snapshot().active).toHaveLength(1)
      expect(scheduler.snapshot().queued).toHaveLength(7)
      expect(tracker.maximum).toBe(1)
    } finally {
      neverSubmit.resolve()
      await scheduler.shutdown()
      await project.close()
    }
  })

  it("恢复暂不可用时仍从持久层快照暴露双队列", async () => {
    const challenges = [challenge(1), challenge(2)]
    const tracker = new SandboxTracker()
    const project = await fixture(challenges, tracker)
    project.enqueueSchedulerChallenges([
      { challengeId: challenges[0]!.id, source: "manual", stage: "idle" },
      { challengeId: challenges[1]!.id, source: "manual", stage: "execution" },
    ])
    const scheduler = new ContestScheduler(project, {
      maxConcurrent: 1,
      availability: () => ({ available: false, unavailableReason: "模型未配置" }),
      createAgentOptions: ({ challenge: summary }) =>
        solvingAgent(requiredChallenge(challenges.find((item) => item.id === summary.id))),
    })

    try {
      await scheduler.restore()
      expect(scheduler.snapshot()).toMatchObject({
        available: false,
        unavailableReason: "模型未配置",
        state: "stopped",
        idle: [{ challengeId: challenges[0]!.id, stage: "idle" }],
        queued: [{ challengeId: challenges[1]!.id, stage: "execution" }],
        active: [],
      })
      expect(tracker.active).toBe(0)
    } finally {
      await scheduler.shutdown()
      await project.close()
    }
  })

  it("未启动时批量编排空闲队列，启动后按手动顺序提交且不隐式加入其他题", async () => {
    const challenges = [challenge(1), challenge(2), challenge(3)]
    const tracker = new SandboxTracker()
    const project = await fixture(challenges, tracker)
    const scheduler = new ContestScheduler(project, {
      maxConcurrent: 1,
      maxAttempts: 1,
      createAgentOptions: ({ challenge: summary }) =>
        solvingAgent(requiredChallenge(challenges.find((item) => item.id === summary.id)), 100),
    })

    try {
      await scheduler.stage([challenges[0]!.id, challenges[1]!.id])
      expect(scheduler.snapshot()).toMatchObject({
        state: "stopped",
        idle: [{ challengeId: challenges[0]!.id }, { challengeId: challenges[1]!.id }],
        queued: [],
        active: [],
      })
      expect(project.runs()).toEqual([])
      expect(tracker.active).toBe(0)

      const version = scheduler.snapshot().idleVersion
      scheduler.reorderIdle([challenges[1]!.id, challenges[0]!.id], version)
      await scheduler.start()
      expect(scheduler.snapshot()).toMatchObject({
        mode: "manual",
        idle: [],
        active: [expect.objectContaining({ challengeId: challenges[1]!.id })],
        queued: [expect.objectContaining({ challengeId: challenges[0]!.id })],
      })
      await expect(scheduler.stage([challenges[2]!.id])).rejects.toMatchObject({
        code: "scheduler_running",
      })
      await expect(scheduler.start()).rejects.toMatchObject({ code: "scheduler_running" })

      await waitUntil(
        () =>
          project.isChallengeSolved(challenges[0]!.id) &&
          project.isChallengeSolved(challenges[1]!.id) &&
          scheduler.snapshot().active.length === 0,
      )
      expect(project.runs({ challengeId: challenges[2]!.id })).toEqual([])
      expect(tracker.maximum).toBe(1)
    } finally {
      await scheduler.shutdown()
      await project.close()
    }
  })

  it("批量编排刷新期间并发启动时不会遗留新的空闲项", async () => {
    const challenges = [challenge(1)]
    const tracker = new SandboxTracker()
    const project = await fixture(challenges, tracker)
    const scheduler = new ContestScheduler(project, {
      maxConcurrent: 1,
      createAgentOptions: ({ challenge: summary }) =>
        solvingAgent(requiredChallenge(challenges.find((item) => item.id === summary.id))),
    })
    const refreshGate = deferred()
    const originalRefresh = project.refresh.bind(project)
    let refreshCalls = 0
    vi.spyOn(project, "refresh").mockImplementation(async () => {
      refreshCalls++
      if (refreshCalls === 1) await refreshGate.promise
      return originalRefresh()
    })

    try {
      const staging = scheduler.stage([challenges[0]!.id])
      const stagingRejected = expect(staging).rejects.toMatchObject({
        code: "scheduler_running",
      })
      await waitUntil(() => refreshCalls === 1)
      await scheduler.start()
      refreshGate.resolve()

      await stagingRejected
      expect(scheduler.snapshot()).toMatchObject({
        mode: "manual",
        idle: [],
        queued: [],
        active: [],
      })
      expect(project.schedulerQueue()).toEqual([])
    } finally {
      refreshGate.resolve()
      await scheduler.shutdown()
      await project.close()
    }
  })

  it("重启后恢复手动模式与执行顺序，暂停时冻结尚未领取的任务", async () => {
    const challenges = [challenge(1), challenge(2)]
    const tracker = new SandboxTracker()
    let project = await fixture(challenges, tracker)
    let scheduler = new ContestScheduler(project, {
      maxConcurrent: 1,
      maxAttempts: 1,
      createAgentOptions: ({ challenge: summary }) =>
        solvingAgent(requiredChallenge(challenges.find((item) => item.id === summary.id))),
    })
    const gate = deferred()

    try {
      await scheduler.stage(challenges.map((item) => item.id))
      project.startScheduler("manual")
      await scheduler.shutdown()
      const root = project.root
      await project.close()

      project = await reopenFixture(root, tracker)
      scheduler = new ContestScheduler(project, {
        maxConcurrent: 1,
        maxAttempts: 1,
        createAgentOptions: ({ challenge: summary }) =>
          controlledSolvingAgent(
            requiredChallenge(challenges.find((item) => item.id === summary.id)),
            gate.promise,
          ),
      })
      await scheduler.restore()
      await waitUntil(() => scheduler.snapshot().active.length === 1)

      expect(scheduler.snapshot()).toMatchObject({
        state: "running",
        mode: "manual",
        idle: [],
        active: [expect.objectContaining({ challengeId: challenges[0]!.id })],
        queued: [expect.objectContaining({ challengeId: challenges[1]!.id })],
      })

      scheduler.pauseAuto()
      gate.resolve()
      await waitUntil(() => scheduler.snapshot().active.length === 0)
      expect(scheduler.snapshot()).toMatchObject({
        state: "stopped",
        queued: [expect.objectContaining({ challengeId: challenges[1]!.id })],
      })
      expect(project.runs({ challengeId: challenges[1]!.id })).toEqual([])
    } finally {
      gate.resolve()
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

  it("暂停自主模式后保留并冻结等待队列，且不取消活跃任务", async () => {
    const challenges = [challenge(1), challenge(2)]
    const tracker = new SandboxTracker()
    const project = await fixture(challenges, tracker)
    const scheduler = new ContestScheduler(project, {
      maxConcurrent: 1,
      maxAttempts: 1,
      createAgentOptions: ({ challenge: summary }) =>
        solvingAgent(requiredChallenge(challenges.find((item) => item.id === summary.id)), 500),
    })

    try {
      await scheduler.startAuto()
      await waitUntil(
        () => scheduler.snapshot().active.length === 1 && scheduler.snapshot().queued.length === 1,
      )
      const activeId = scheduler.snapshot().active[0]?.challengeId
      const queuedId = scheduler.snapshot().queued[0]?.challengeId

      scheduler.pauseAuto()
      if (!activeId) throw new Error("自主调度未创建活跃任务")

      expect(scheduler.snapshot()).toMatchObject({
        autoEnabled: false,
        queued: [expect.objectContaining({ challengeId: queuedId })],
        active: [expect.objectContaining({ challengeId: activeId })],
      })
      expect(project.runs({ challengeId: queuedId })).toHaveLength(0)
      await scheduler.cancel(activeId)
      await waitUntil(() => scheduler.snapshot().active.length === 0)
      expect(project.runs({ challengeId: queuedId })).toHaveLength(0)
    } finally {
      await scheduler.shutdown()
      await project.close()
    }
  })

  it("仅在暂停调度后停止全部活跃 Solver，并等待 Sandbox 正常回收", async () => {
    const challenges = [challenge(1), challenge(2)]
    const tracker = new SandboxTracker()
    const project = await fixture(challenges, tracker)
    const scheduler = new ContestScheduler(project, {
      maxConcurrent: 2,
      maxAttempts: 1,
      createAgentOptions: ({ challenge: summary }) =>
        solvingAgent(requiredChallenge(challenges.find((item) => item.id === summary.id)), 500),
    })

    try {
      await scheduler.startAuto()
      await waitUntil(() => scheduler.snapshot().active.length === 2 && tracker.active === 2)
      await expect(scheduler.stopAllActive()).rejects.toMatchObject({ code: "auto_enabled" })

      scheduler.pauseAuto()
      await scheduler.stopAllActive()

      expect(scheduler.snapshot()).toMatchObject({
        autoEnabled: false,
        active: [],
        queued: [],
      })
      expect(tracker.active).toBe(0)
      expect(project.runs().map((run) => run.status)).toEqual(["cancelled", "cancelled"])
    } finally {
      await scheduler.shutdown()
      await project.close()
    }
  })

  it("暂停自主模式会保留并冻结此前补发的 manual 等待任务", async () => {
    const challenges = [challenge(1), challenge(2), challenge(3)]
    const tracker = new SandboxTracker()
    const project = await fixture(challenges, tracker)
    const scheduler = new ContestScheduler(project, {
      maxConcurrent: 1,
      maxAttempts: 1,
      createAgentOptions: ({ challenge: summary }) =>
        solvingAgent(requiredChallenge(challenges.find((item) => item.id === summary.id)), 500),
    })

    try {
      const first = requiredChallenge(challenges[0])
      const second = requiredChallenge(challenges[1])
      const third = requiredChallenge(challenges[2])
      await scheduler.dispatch(first.id)
      await waitUntil(() => scheduler.snapshot().active.length === 1)
      await scheduler.dispatch(second.id)
      await scheduler.dispatch(third.id)
      expect(scheduler.snapshot().queued.map((item) => item.source)).toEqual(["manual", "manual"])

      scheduler.pauseAuto()
      expect(scheduler.snapshot().queued.map((item) => item.challengeId)).toEqual([
        second.id,
        third.id,
      ])
      const activeId = scheduler.snapshot().active[0]?.challengeId
      if (activeId) await scheduler.cancel(activeId)
      await waitUntil(() => scheduler.snapshot().active.length === 0)
      expect(project.runs({ challengeId: second.id })).toHaveLength(0)
      expect(project.runs({ challengeId: third.id })).toHaveLength(0)
    } finally {
      await scheduler.shutdown()
      await project.close()
    }
  })

  it("重置活跃题目：终止 Agent、清空历史、回收容器并按 attempt=1 重新入队", async () => {
    const item = challenge(1)
    const tracker = new SandboxTracker()
    const removedContainers: string[][] = []
    const project = await fixture([item], tracker, {
      removeManagedSandboxes: async (runIds) => {
        removedContainers.push([...runIds])
      },
    })
    const scheduler = new ContestScheduler(project, {
      maxConcurrent: 1,
      maxAttempts: 1,
      createAgentOptions: () => solvingAgent(item, 300),
    })

    try {
      await scheduler.startAuto()
      await waitUntil(() => scheduler.snapshot().active.length === 1)
      const activeId = scheduler.snapshot().active[0]?.challengeId
      if (!activeId) throw new Error("自主调度未创建活跃任务")
      await waitUntil(() => project.runs({ challengeId: activeId }).length === 1)
      const [oldRun] = project.runs({ challengeId: activeId })
      if (!oldRun) throw new Error("调度器未创建 Run")

      await scheduler.resetChallenge(activeId)

      // 旧 Run 已彻底清空（含事件/黑板级联），其托管容器也被回收
      expect(project.runs({ challengeId: activeId }).some((run) => run.id === oldRun.id)).toBe(
        false,
      )
      expect(removedContainers).toEqual([[oldRun.id]])
      // 自动模式按新题（attempt=1）重新入队并再次启动
      await waitUntil(
        () =>
          project.runs({ challengeId: activeId }).length === 1 &&
          project.runs({ challengeId: activeId })[0]?.attempt === 1,
      )
      const [newRun] = project.runs({ challengeId: activeId })
      if (!newRun) throw new Error("重置后未重新创建 Run")
      expect(newRun.id).not.toBe(oldRun.id)
      // 新 Run 解出后无残留 sandbox
      await waitUntil(
        () => project.isChallengeSolved(activeId) && scheduler.snapshot().active.length === 0,
      )
      expect(tracker.active).toBe(0)
    } finally {
      await scheduler.shutdown()
      await project.close()
    }
  })

  it("重置仅有历史的题目：清空 solved 状态且 auto 未开启时不重新入队", async () => {
    const item = challenge(1)
    const tracker = new SandboxTracker()
    const project = await fixture([item], tracker)
    const scheduler = new ContestScheduler(project, {
      maxConcurrent: 1,
      maxAttempts: 1,
      createAgentOptions: () => solvingAgent(item),
    })

    try {
      await scheduler.dispatch(item.id)
      await waitUntil(
        () => project.isChallengeSolved(item.id) && scheduler.snapshot().active.length === 0,
      )
      const [oldRun] = project.runs({ challengeId: item.id })
      if (!oldRun) throw new Error("调度器未创建 Run")

      await scheduler.resetChallenge(item.id)

      expect(project.runs({ challengeId: item.id }).some((run) => run.id === oldRun.id)).toBe(false)
      expect(project.runs({ challengeId: item.id })).toEqual([])
      expect(project.isChallengeSolved(item.id)).toBe(false)
      // auto 未开启：不自动重新入队
      expect(scheduler.snapshot().queued.map((q) => q.challengeId)).not.toContain(item.id)
      expect(tracker.active).toBe(0)
    } finally {
      await scheduler.shutdown()
      await project.close()
    }
  })

  it("workspace 清理失败时保留 Run 历史并向调用方报错", async () => {
    const item = challenge(1)
    const tracker = new SandboxTracker()
    const project = await fixture([item], tracker, {
      clearWorkspace: async () => {
        throw new Error("workspace cleanup failed")
      },
    })
    const scheduler = new ContestScheduler(project, {
      maxConcurrent: 1,
      maxAttempts: 1,
      createAgentOptions: () => solvingAgent(item),
    })

    try {
      await scheduler.dispatch(item.id)
      await waitUntil(
        () => project.isChallengeSolved(item.id) && scheduler.snapshot().active.length === 0,
      )
      const before = project.runs({ challengeId: item.id })
      await expect(scheduler.resetChallenge(item.id)).rejects.toThrow("workspace cleanup failed")
      expect(project.runs({ challengeId: item.id })).toEqual(before)
    } finally {
      await scheduler.shutdown()
      await project.close()
    }
  })

  it("领取和重排队列后发布所有受影响条目的最新版本", async () => {
    const challenges = [challenge(1), challenge(2), challenge(3), challenge(4)]
    const tracker = new SandboxTracker()
    const project = await fixture(challenges, tracker)
    const scheduler = new ContestScheduler(project, {
      maxConcurrent: 1,
      maxAttempts: 1,
      createAgentOptions: ({ challenge: summary }) =>
        solvingAgent(requiredChallenge(challenges.find((item) => item.id === summary.id)), 500),
    })

    try {
      await scheduler.startAuto()
      await waitUntil(
        () =>
          typeof scheduler.snapshot().active[0]?.runId === "string" &&
          scheduler.snapshot().queued.length === 3,
      )

      const before = scheduler.snapshot().queued
      expect(before.every((item) => item.version > 1)).toBe(true)
      const moved = before.at(-1)
      if (!moved) throw new Error("自主调度未创建等待队列")

      const afterFirstMove = scheduler.reorderQueue(moved.challengeId, {
        position: 1,
        expectedVersion: moved.version,
      }).queued
      const displaced = afterFirstMove.find((item) => item.challengeId === before[0]?.challengeId)
      if (!displaced) throw new Error("重排后缺少被挤动的题目")
      expect(displaced.version).toBeGreaterThan(before[0]?.version ?? 0)

      expect(() =>
        scheduler.reorderQueue(displaced.challengeId, {
          position: 3,
          expectedVersion: displaced.version,
        }),
      ).not.toThrow()
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
        solvingAgent(requiredChallenge(challenges.find((item) => item.id === summary.id)), 300),
    })

    try {
      await scheduler.startAuto()
      await waitUntil(
        () => scheduler.snapshot().active.length === 1 && scheduler.snapshot().queued.length === 2,
      )
      await scheduler.setMaxConcurrent(2)
      await waitUntil(() => scheduler.snapshot().active.length === 2)
      expect(scheduler.snapshot().maxConcurrent).toBe(2)
      expect(persisted).toEqual([2])
      await expect(scheduler.setMaxConcurrent(0)).rejects.toThrow("正整数")
      await expect(scheduler.setMaxConcurrent(65)).rejects.toThrow("不能超过 64")
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

  it("平台挂起时保留内存和 SQLite 中的等待队列", async () => {
    const first = challenge(1)
    const queued = challenge(2)
    const challenges = [first, queued]
    const project = await fixture(challenges, new SandboxTracker())
    const scheduler = new ContestScheduler(project, {
      maxConcurrent: 1,
      createAgentOptions: ({ challenge: summary }) =>
        solvingAgent(
          requiredChallenge(challenges.find((challenge) => challenge.id === summary.id)),
          500,
        ),
    })
    try {
      await scheduler.dispatch(first.id)
      await waitUntil(() => scheduler.snapshot().active.length === 1)
      await scheduler.dispatch(queued.id)
      expect(scheduler.snapshot().queued).toHaveLength(1)
      scheduler.suspend("platform offline")
      expect(scheduler.snapshot()).toMatchObject({
        available: false,
        unavailableReason: "platform offline",
        queued: [{ challengeId: queued.id }],
      })
      expect(project.schedulerQueue()).toEqual(
        expect.arrayContaining([expect.objectContaining({ challengeId: queued.id })]),
      )
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
        () => project.isChallengeSolved(item.id) && scheduler.snapshot().active.length === 0,
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
        () => project.isChallengeBlocked(item.id) && scheduler.snapshot().active.length === 0,
      )

      const runs = project.runs({ challengeId: item.id })
      expect(runs).toEqual([expect.objectContaining({ attempt: 1, status: "blocked" })])
      expect(project.runEvents(runs[0]?.id ?? "").map((event) => event.type)).toContain(
        "run_creation_blocked",
      )
    } finally {
      await scheduler.shutdown()
      await project.close()
    }
  })
})

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("等待调度状态超时")
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}
