import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BaseAgent } from "@ctf-agent/agents"
import type {
  CommandResult,
  DockerSandboxOptions,
  Sandbox,
  SandboxExecOptions,
} from "@ctf-agent/sandbox"
import type { AgentOptions } from "@earendil-works/pi-agent-core"
import type { Model } from "@earendil-works/pi-ai"
import { afterEach, describe, expect, it } from "vitest"
import { RunStore } from "../../src/persistence/run-store.ts"
import { Project } from "../../src/project/project.js"
import { testPlatform } from "../fake-platform.ts"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

class FakeSandbox implements Sandbox {
  readonly id = "fake-container"
  readonly writes = new Map<string, string>()
  closed = false
  async exec(
    args: string[],
    options?: SandboxExecOptions,
  ): Promise<CommandResult> {
    if (args[0] === "python3") {
      const payload = JSON.parse(options?.input ?? "{}") as {
        op?: string
        path?: string
        base64?: string
      }
      if (
        (payload.op === "write" || payload.op === "replace") &&
        payload.path &&
        payload.base64
      ) {
        this.writes.set(payload.path, payload.base64)
      }
      return {
        code: 0,
        stdout: JSON.stringify({
          ok: true,
          value: payload.op === "canonical" ? payload.path : null,
        }),
        stderr: "",
      }
    }
    return { code: 0, stdout: "", stderr: "" }
  }
  async close(): Promise<void> {
    this.closed = true
  }
}

const model: Model<"openai-completions"> = {
  id: "reasoning-model",
  name: "Reasoning model",
  api: "openai-completions",
  provider: "test",
  baseUrl: "https://invalid.test",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 64_000,
  maxTokens: 4_096,
}

const agentOptions = {
  streamFn: (() => {
    throw new Error("本测试不调用模型")
  }) as AgentOptions["streamFn"],
  initialState: { model },
} satisfies AgentOptions

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ctf-project-"))
  roots.push(root)
  await writeFile(join(root, ".gitignore"), "")
  await mkdir(join(root, ".pi"), { recursive: true })
  await writeFile(
    join(root, ".pi", "ctf-config.json"),
    JSON.stringify({
      version: 1,
      project: { id: "test-project", name: "Test Project" },
      platform: { plugin: "test", config: {} },
      sandbox: { image: "test-image", privileged: true, networkMode: "none" },
    }),
  )
  await mkdir(join(root, ".pi", "skills", "reverse"), { recursive: true })
  await writeFile(
    join(root, ".pi", "skills", "reverse", "SKILL.md"),
    "---\nname: reverse\ndescription: Analyze challenge binaries\n---\n# Reverse",
  )
  return root
}

describe("Project", () => {
  it("控制面传入配置时无需磁盘中的 .pi/ctf-config.json", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctf-project-config-"))
    roots.push(root)
    const stateDirectory = join(root, "isolated-state")
    const project = await Project.open({
      root,
      stateDirectory,
      config: {
        version: 1,
        project: { id: "in-memory", name: "In-memory Config" },
        platform: { plugin: "test", config: {} },
        sandbox: {
          image: "test-image",
          privileged: false,
          networkMode: "none",
        },
      },
      platforms: [testPlatform],
      sandboxFactory: async () => new FakeSandbox(),
    })
    try {
      expect(project.config.project).toEqual({
        id: "in-memory",
        name: "In-memory Config",
      })
      expect(project.agentDirectory).toBe(stateDirectory)
      await expect(
        access(join(stateDirectory, "runs.sqlite")),
      ).resolves.toBeUndefined()
    } finally {
      await project.close()
    }
  })

  it("keeps Pi skill diagnostics observable without rejecting project startup", async () => {
    const root = await fixture()
    await mkdir(join(root, ".pi", "skills", "invalid"), { recursive: true })
    await writeFile(
      join(root, ".pi", "skills", "invalid", "SKILL.md"),
      "---\nname: INVALID\ndescription: bad\n---\nbody",
    )
    const project = await Project.open({
      root,
      platforms: [testPlatform],
      sandboxFactory: async () => new FakeSandbox(),
    })
    try {
      expect(project.diagnostics()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "skill",
            path: expect.stringContaining("invalid"),
          }),
        ]),
      )
    } finally {
      await project.close()
    }
  })

  it("为新 Run 应用控制面提供的 SubAgent role 模型绑定", async () => {
    const root = await fixture()
    const project = await Project.open({
      root,
      platforms: [testPlatform],
      sandboxFactory: async () => new FakeSandbox(),
      subagents: {
        modelForRole: (role) =>
          role === "explorer" ? "worker-provider/worker-model" : undefined,
      },
    })
    try {
      expect(project.availableSubagents()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "explorer",
            model: "worker-provider/worker-model",
          }),
        ]),
      )
    } finally {
      await project.close()
    }
  })

  it("创建题目绑定的 Agent、持久化 workspace，并在 close 后仅删除容器", async () => {
    const root = await fixture()
    const sandbox = new FakeSandbox()
    let received: DockerSandboxOptions | undefined
    const project = await Project.open({
      root,
      platforms: [testPlatform],
      sandboxFactory: async (options) => {
        received = options
        return sandbox
      },
    })

    const solver = await project.createSolver("warmup-flag", {
      agent: agentOptions,
    })
    expect(solver).toBeInstanceOf(BaseAgent)
    expect(solver.challenge.id).toBe("warmup-flag")
    const toolNames = solver.state.tools.map((tool) => tool.name)
    expect(toolNames).toEqual(
      expect.arrayContaining(["read", "write", "edit", "list", "bash"]),
    )
    expect(toolNames).not.toContain("ctf_instance_start")
    expect(toolNames).not.toContain("ctf_challenge_info")
    expect(toolNames).not.toContain("ctf_download_attachment")
    expect(toolNames).not.toContain("load_skill")
    expect(toolNames).toEqual(
      expect.arrayContaining([
        "blackboard_read",
        "blackboard_record",
        "blackboard_manage",
      ]),
    )
    expect(solver.state.systemPrompt).toContain("<available_skills>")
    expect(solver.state.systemPrompt).toContain(
      "/workspace/.skills/skill-1/SKILL.md",
    )
    expect(solver.state.systemPrompt).not.toContain(
      '<challenge_blackboard encoding="json">',
    )
    const blackboardMessage = solver.state.messages.find(
      (message) =>
        message.role === "user" &&
        typeof message.content === "string" &&
        message.content.includes('<challenge_blackboard encoding="json">'),
    )
    expect(blackboardMessage).toBeUndefined()
    const challengeMessage = solver.state.messages.find(
      (message) =>
        message.role === "user" &&
        typeof message.content === "string" &&
        message.content.includes("<challenge_context"),
    )
    expect(challengeMessage).toBeDefined()
    const challengeContent =
      challengeMessage?.role === "user" &&
      typeof challengeMessage.content === "string"
        ? challengeMessage.content
        : ""
    expect(challengeContent).toContain('path="/workspace/attachments/flag.txt"')
    expect(sandbox.writes.get("/workspace/attachments/flag.txt")).toBe(
      Buffer.from("TEST{fixture}").toString("base64"),
    )
    expect(project.blackboard("warmup-flag")).toEqual({
      evidence: [],
      opportunities: [],
    })
    expect(received).toMatchObject({
      projectId: "test-project",
      image: "test-image",
      privileged: true,
      networkMode: "none",
    })
    const activeExportMetadata = await project.runSessionExportMetadata(
      solver.runId,
    )
    expect(activeExportMetadata).toMatchObject({
      systemPrompt: solver.state.systemPrompt,
      tools: expect.arrayContaining([
        expect.objectContaining({ name: "ctf_submit_flag" }),
      ]),
    })

    await solver.close()
    expect(sandbox.closed).toBe(true)
    await expect(
      project.runSessionExportMetadata(solver.runId),
    ).resolves.toEqual(activeExportMetadata)
    expect(project.runs()).toEqual([
      expect.objectContaining({
        challengeId: "warmup-flag",
        attempt: 1,
        status: "closed",
        closeReason: "manual",
      }),
    ])
    const run = JSON.parse(
      await readFile(
        join(root, ".ctf-agent", "runs", solver.runId, "run.json"),
        "utf8",
      ),
    )
    expect(run.workspace).toContain("workspace")
    await expect(access(run.workspace)).resolves.toBeUndefined()
    await expect(
      access(join(run.workspace, ".skills", "skill-1", "SKILL.md")),
    ).resolves.toBeUndefined()
    expect(project.runEvents(solver.runId).map((event) => event.type)).toEqual([
      "run_created",
      "run_started",
      "run_finished",
    ])
    await project.close()
  })

  it("将 Solver 的 Pi 生命周期旁路投影到隔离的实时订阅", async () => {
    const root = await fixture()
    const project = await Project.open({
      root,
      platforms: [testPlatform],
      sandboxFactory: async () => new FakeSandbox(),
    })
    try {
      const solver = await project.createSolver("warmup-flag", {
        agent: agentOptions,
      })
      const received: string[] = []
      const unrelated: string[] = []
      const unsubscribe = project.subscribeAgentStream(
        { runId: solver.runId },
        (event) => received.push(event.type),
      )
      project.subscribeAgentStream({ runId: "another-run" }, (event) =>
        unrelated.push(event.type),
      )

      await expect(solver.prompt("continue")).resolves.toMatchObject({
        role: "assistant",
        stopReason: "error",
        errorMessage: "本测试不调用模型",
      })
      unsubscribe()

      expect(received).toContain("agent_started")
      expect(received).toContain("agent_finished")
      expect(unrelated).toEqual([])
    } finally {
      await project.close()
    }
  })

  it("webAccessConfig 启用时注入 web 工具，禁用时不注入", async () => {
    const root = await fixture()

    const enabled = await Project.open({
      root,
      platforms: [testPlatform],
      sandboxFactory: async () => new FakeSandbox(),
      webAccessConfig: (workspace, signal) => ({
        providers: ["brave"],
        workflow: "none",
        resolveSecret: (provider) =>
          provider === "brave" ? "test-brave-key" : undefined,
        workspaceHostPath: workspace,
        sessionSignal: signal,
      }),
    })
    try {
      const solver = await enabled.createSolver("warmup-flag", {
        agent: agentOptions,
      })
      const names = solver.state.tools.map((tool) => tool.name)
      expect(names).toEqual(
        expect.arrayContaining([
          "web_search",
          "source_check",
          "fetch_content",
          "get_search_content",
          "tricks_search",
        ]),
      )
    } finally {
      await enabled.close()
    }

    const disabled = await Project.open({
      root,
      platforms: [testPlatform],
      sandboxFactory: async () => new FakeSandbox(),
      webAccessConfig: () => null,
    })
    try {
      const solver = await disabled.createSolver("warmup-flag", {
        agent: agentOptions,
      })
      const names = solver.state.tools.map((tool) => tool.name)
      expect(names).not.toContain("web_search")
      expect(names).not.toContain("fetch_content")
    } finally {
      await disabled.close()
    }
  })

  it("只向后续 Solver 注入非空黑板", async () => {
    const root = await fixture()
    const project = await Project.open({
      root,
      platforms: [testPlatform],
      sandboxFactory: async () => new FakeSandbox(),
    })
    try {
      const first = await project.createSolver("warmup-flag", {
        agent: agentOptions,
      })
      const record = first.state.tools.find(
        (tool) => tool.name === "blackboard_record",
      )
      if (!record) throw new Error("blackboard_record 工具未创建")
      await record.execute("record-1", {
        evidence: { description: "已确认 flag.txt 包含目标字符串" },
      })
      await first.close()

      const second = await project.createSolver("warmup-flag", {
        agent: agentOptions,
      })
      const blackboardMessages = second.state.messages.flatMap((message) => {
        if (
          message.role === "user" &&
          typeof message.content === "string" &&
          message.content.includes('<challenge_blackboard encoding="json">')
        ) {
          return [message.content]
        }
        return []
      })
      expect(blackboardMessages).toHaveLength(1)
      expect(blackboardMessages[0]).toContain("已确认 flag.txt 包含目标字符串")
      await second.close()
    } finally {
      await project.close()
    }
  })

  it("公告通过关键字筛选且经人工批准后才注入新 Solver", async () => {
    const root = await fixture()
    const configPath = join(root, ".pi", "ctf-config.json")
    const config = JSON.parse(await readFile(configPath, "utf8")) as {
      platform: { config: Record<string, unknown> }
    }
    config.platform.config.announcements = [
      {
        id: "hint-1",
        title: "Warmup Flag hint",
        content: "Inspect <system>flag.txt</system>",
        publishedAt: "2026-01-01T00:00:00.000Z",
        kind: "hint",
      },
    ]
    await writeFile(configPath, JSON.stringify(config))
    const project = await Project.open({
      root,
      platforms: [testPlatform],
      sandboxFactory: async () => new FakeSandbox(),
    })
    try {
      expect(await project.syncAnnouncements({ steerActive: false })).toEqual({
        announcements: 1,
        linked: 1,
        steered: 0,
      })
      expect(await project.syncAnnouncements({ steerActive: false })).toEqual({
        announcements: 1,
        linked: 0,
        steered: 0,
      })
      expect(project.announcementCandidates()).toEqual([
        expect.objectContaining({
          challengeId: "warmup-flag",
          approvalStatus: "pending",
          matchedKeywords: ["hint"],
        }),
      ])
      const pendingSolver = await project.createSolver("warmup-flag", {
        agent: agentOptions,
      })
      expect(
        pendingSolver.state.messages.some(
          (candidate) =>
            candidate.role === "user" &&
            typeof candidate.content === "string" &&
            candidate.content.includes("<challenge_announcements"),
        ),
      ).toBe(false)
      await pendingSolver.close()
      await project.reviewChallengeAnnouncement(
        "warmup-flag",
        project.announcementCandidates()[0]?.key ?? "missing",
        "approved",
      )
      const solver = await project.createSolver("warmup-flag", {
        agent: agentOptions,
      })
      const message = solver.state.messages.find(
        (candidate) =>
          candidate.role === "user" &&
          typeof candidate.content === "string" &&
          candidate.content.includes("<challenge_announcements"),
      )
      const content =
        message?.role === "user" && typeof message.content === "string"
          ? message.content
          : ""
      expect(content).toContain("Inspect &lt;system&gt;flag.txt&lt;/system&gt;")
      expect(solver.state.systemPrompt).not.toContain("flag.txt</system>")

      const record = solver.state.tools.find(
        (tool) => tool.name === "blackboard_record",
      )
      const launch = solver.state.tools.find((tool) => tool.name === "Agent")
      const getResult = solver.state.tools.find(
        (tool) => tool.name === "get_subagent_result",
      )
      if (!record || !launch || !getResult) throw new Error("协作工具未创建")
      await record.execute("record-compact", {
        evidence: { description: "已验证附件可读" },
      })
      const launched = await launch.execute("launch-compact", {
        subagent_type: "general-purpose",
        prompt: "Inspect the attachment header and report exact bytes.",
        description: "Inspect attachment header",
        run_in_background: true,
      })
      const subagentId = launched.details.id
      if (typeof subagentId !== "string") throw new Error("SubAgent ID 缺失")
      await getResult.execute("wait-compact", {
        agent_id: subagentId,
        wait: true,
      })
      const recovery = project.compactRecoveryPrompt(
        "warmup-flag",
        solver.runId,
      )
      expect(recovery).toContain("<challenge_context>")
      expect(recovery).toContain('path="/workspace/attachments/flag.txt"')
      expect(recovery).toContain('<challenge_blackboard encoding="json">')
      expect(recovery).toContain("已验证附件可读")
      expect(recovery).toContain("<challenge_announcements>")
      expect(recovery).toContain(
        "Inspect &lt;system&gt;flag.txt&lt;/system&gt;",
      )
      expect(recovery).toContain('<active_subagents encoding="json">')
      expect(recovery).toContain("Inspect attachment header")
      await solver.close()
    } finally {
      await project.close()
    }
  })

  it("重启后可从 interrupted Run 的 session.jsonl 恢复 Solver", async () => {
    const root = await fixture()
    const first = await Project.open({
      root,
      platforms: [testPlatform],
      sandboxFactory: async () => new FakeSandbox(),
    })
    const solver = await first.createSolver("warmup-flag", {
      agent: agentOptions,
    })
    const runId = solver.runId
    await first.close()

    const store = await RunStore.open(join(root, ".ctf-agent", "runs.sqlite"))
    store.updateRun(runId, {
      status: "interrupted",
      closeReason: "interrupted",
      finishedAt: new Date().toISOString(),
    })
    store.close()

    const restarted = await Project.open({
      root,
      platforms: [testPlatform],
      sandboxFactory: async () => new FakeSandbox(),
    })
    try {
      const resumed = await restarted.resumeSolver(runId, {
        agent: agentOptions,
      })
      expect(resumed.runId).toBe(runId)
      expect(resumed.restored).toBe(true)
      const resumedRun = restarted.runs().find((run) => run.id === runId)
      expect(resumedRun?.status).toBe("running")
      expect(resumedRun?.closeReason).toBeUndefined()
      await resumed.close()
    } finally {
      await restarted.close()
    }
  })
})

async function projectWithSolver() {
  const root = await fixture()
  const project = await Project.open({
    root,
    platforms: [testPlatform],
    sandboxFactory: async () => new FakeSandbox(),
  })
  const solver = await project.createSolver("warmup-flag", {
    agent: agentOptions,
  })
  return { root, project, solver }
}

describe("Project.sendMessage(题目级人工干涉对话框)", () => {
  it("向活跃 solver 发送消息:返回 runId、落 human_message 事件并进入 steer 队列", async () => {
    const { project, solver } = await projectWithSolver()
    try {
      const delivered = await project.sendMessage("warmup-flag", "先检查文件头")
      expect(delivered).toEqual({ runId: solver.runId })
      expect(solver.hasQueuedMessages()).toBe(true)

      const human = project
        .runEvents(solver.runId)
        .find((event) => event.type === "human_message")
      expect(human).toBeDefined()
      expect(human?.data).toMatchObject({ text: "先检查文件头" })
      if (!human) throw new Error("human_message 事件未持久化")
      expect(typeof (human.data as { ts: string }).ts).toBe("string")
    } finally {
      await solver.close()
      await project.close()
    }
  })

  it("空文本被拒绝(code=invalid_message)", async () => {
    const { project, solver } = await projectWithSolver()
    try {
      await expect(
        project.sendMessage("warmup-flag", "   "),
      ).rejects.toMatchObject({
        code: "invalid_message",
      })
    } finally {
      await solver.close()
      await project.close()
    }
  })

  it("solver 关闭后发送被拒绝(code=no_active_run)", async () => {
    const { project, solver } = await projectWithSolver()
    await solver.close()
    await expect(
      project.sendMessage("warmup-flag", "继续"),
    ).rejects.toMatchObject({
      code: "no_active_run",
    })
    await project.close()
  })

  it("未知题目 ID 发送被拒绝(code=no_active_run)", async () => {
    const { project, solver } = await projectWithSolver()
    try {
      await expect(
        project.sendMessage("missing-id", "继续"),
      ).rejects.toMatchObject({
        code: "no_active_run",
      })
    } finally {
      await solver.close()
      await project.close()
    }
  })
})

describe("Project.setThinkingLevel(运行中切换思考强度)", () => {
  it("切换活跃 solver 的思考强度并落 thinking_level_update 事件", async () => {
    const { project, solver } = await projectWithSolver()
    try {
      const delivered = await project.setThinkingLevel("warmup-flag", "max")
      expect(delivered).toEqual({ runId: solver.runId })
      expect(solver.state.thinkingLevel).toBe("high")

      const event = project
        .runEvents(solver.runId)
        .find((event) => event.type === "thinking_level_update")
      expect(event).toBeDefined()
      expect(event?.data).toMatchObject({ level: "high" })
    } finally {
      await solver.close()
      await project.close()
    }
  })

  it("非法档位被拒绝(code=invalid_level)", async () => {
    const { project, solver } = await projectWithSolver()
    try {
      await expect(
        project.setThinkingLevel("warmup-flag", "ultra" as never),
      ).rejects.toMatchObject({
        code: "invalid_level",
      })
    } finally {
      await solver.close()
      await project.close()
    }
  })

  it("solver 关闭后切换被拒绝(code=no_active_run)", async () => {
    const { project, solver } = await projectWithSolver()
    await solver.close()
    await expect(
      project.setThinkingLevel("warmup-flag", "low"),
    ).rejects.toMatchObject({
      code: "no_active_run",
    })
    await project.close()
  })
})
