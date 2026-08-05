import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import {
  type AgentSkill,
  CtfSolverAgent,
  type DiscoveredSubagentRoles,
  discoverProjectSkillsWithDiagnostics,
  discoverSubagentRoles,
  isThinkingLevel,
  materializeSkills,
  resolveThinkingLevel,
  type SolverCloseDetails,
  type SubagentRole,
} from "@ctf-agent/agents"
import {
  type Announcement,
  type ChallengeSummary,
  type ContestOverview,
  isRetryablePlatformError,
  type PlatformPlugin,
  type PlatformProject,
  type RemoteEnvironment,
} from "@ctf-agent/platform"
import {
  DockerSandbox,
  type DockerSandboxOptions,
  type DockerWorkspaceMount,
  newRunId,
  type Sandbox,
} from "@ctf-agent/sandbox"
import type {
  AgentHarnessEvent,
  AgentMessage,
  AgentOptions,
  ThinkingLevel,
} from "@earendil-works/pi-agent-core"
import {
  BLACKBOARD_SYSTEM_GUIDANCE,
  blackboardSnapshotPrompt,
  CHALLENGE_CONTEXT_SYSTEM_GUIDANCE,
  challengeAnnouncementsPrompt,
  challengeContextPrompt,
  subagentDelegationPrompt,
} from "../../prompts/index.ts"
import { extractAssistantText, extractThinkingText } from "../agent/thinking.ts"
import {
  BLACKBOARD_INJECTION_MAX_CHARACTERS,
  createBlackboardTools,
  serializeBlackboard,
} from "../collaboration/blackboard.ts"
import {
  CtfSubagentManager,
  createSubagentManagerTools,
  type SubagentRecord,
} from "../collaboration/subagent-manager.ts"
import {
  announcementRevision,
  classifyAnnouncement,
  matchAnnouncementChallenges,
} from "../orchestration/announcement-matcher.ts"
import {
  validateChallengeWriteup,
  type WriteupValidationResult,
} from "../orchestration/writeup-validator.ts"
import {
  type EnqueueSchedulerChallenge,
  type MoveSchedulerChallenge,
  type RunEvent,
  type RunFilter,
  type RunRecord,
  type RunSource,
  type RunStatus,
  RunStore,
  type SchedulerQueueRecord,
} from "../persistence/run-store.ts"
import { downloadChallengeAttachments } from "./attachments.ts"
import {
  challengeWorkspaceKey,
  challengeWorkspacePath,
} from "./challenge-workspace.ts"
import {
  findProjectRoot,
  loadProjectConfig,
  type ProjectConfig,
  parseProjectConfig,
} from "./config.ts"

export interface OpenProjectOptions {
  root?: string
  /** 已由控制面加载的配置；提供时不再从 .pi/ctf-config.json 重读。 */
  config?: ProjectConfig
  platforms: readonly PlatformPlugin[]
  /** Resolve a named secret without placing credentials in project config. */
  resolveSecret?: (name: string) => string | undefined
  sandboxFactory?: (options: DockerSandboxOptions) => Promise<Sandbox>
  /** 在 .pi/skills 与 .agents/skills 外额外发现的 skill 目录。 */
  skillPaths?: readonly string[]
  /** 控制面运行在容器中时，将 Run workspace 映射为 Docker daemon 可见的挂载。 */
  workspaceMount?: (context: {
    runId: string
    workspace: string
    relativeWorkspace: string
  }) => DockerWorkspaceMount
  telemetry?: ProjectTelemetryOptions
  subagents?: {
    maxConcurrent?: number
  }
}

export interface ProjectTelemetryOptions {
  level?: "safe" | "full"
  maxTextLength?: number
}

export interface ProjectDiagnostic {
  code: "skill" | "subagent" | "telemetry"
  message: string
  createdAt: string
  path?: string
  runId?: string
}

export interface CreateSolverOptions {
  agent: AgentOptions
  /** 使用 Pi 原生 session-tree compaction；默认开启。 */
  compaction?: boolean
  /** 提交 flag 后保留 Solver 执行 writeup turn。 */
  writeup?: boolean
  /** Runner 的第几次尝试；直接调用时由 RunStore 自动递增。 */
  attempt?: number
  source?: RunSource
}

/**
 * Project 是比赛的基本单元：它拥有完整平台 API 与持久化；Solver 永远只获得单题 capability。
 */
export class Project {
  readonly root: string
  readonly config: ProjectConfig
  private readonly solvers = new Set<CtfSolverAgent>()
  private readonly subagentManagers = new Map<string, CtfSubagentManager>()
  private readonly diagnosticLog: ProjectDiagnostic[]
  private closed = false
  private constructor(
    root: string,
    config: ProjectConfig,
    private readonly platform: PlatformProject,
    private readonly sandboxFactory: (
      options: DockerSandboxOptions,
    ) => Promise<Sandbox>,
    private readonly skills: readonly AgentSkill[],
    private readonly subagentRoles: ReadonlyMap<string, SubagentRole>,
    private readonly runStore: RunStore,
    private readonly workspaceMount: OpenProjectOptions["workspaceMount"],
    private readonly telemetry: Required<ProjectTelemetryOptions>,
    private readonly subagentRuntime: {
      maxConcurrent: number
    },
    diagnostics: readonly ProjectDiagnostic[],
  ) {
    this.root = root
    this.config = config
    this.diagnosticLog = [...diagnostics]
  }

  static async open(options: OpenProjectOptions): Promise<Project> {
    const root = options.config
      ? resolve(options.root ?? process.cwd())
      : await findProjectRoot(options.root)
    const config = options.config
      ? parseProjectConfig(options.config)
      : await loadProjectConfig(root)
    const plugin = options.platforms.find(
      (candidate) => candidate.id === config.platform.plugin,
    )
    if (!plugin) throw new Error(`未注册平台插件: ${config.platform.plugin}`)
    const platformConfig = plugin.config.parse(config.platform.config)
    const platform = await plugin.connect({
      project: config.project,
      config: platformConfig,
      resolveSecret: options.resolveSecret ?? (() => undefined),
    })
    let runStore: RunStore | undefined
    try {
      const [discovered, discoveredSubagents] = await Promise.all([
        discoverProjectSkillsWithDiagnostics(root, options.skillPaths),
        discoverSubagentRoles(root),
      ])
      const agentDirectory = join(root, ".ctf-agent")
      await mkdir(agentDirectory, { recursive: true })
      runStore = await RunStore.open(join(agentDirectory, "runs.sqlite"))
      // Project.open 只可能发生在新进程/新控制面中；遗留活跃记录不可继续信任。
      runStore.markInterruptedRuns()
      runStore.markInterruptedSubagents()
      return new Project(
        root,
        config,
        platform,
        options.sandboxFactory ?? DockerSandbox.create,
        discovered.skills,
        discoveredSubagents.roles,
        runStore,
        options.workspaceMount,
        {
          level: options.telemetry?.level ?? "safe",
          maxTextLength: Math.max(
            240,
            options.telemetry?.maxTextLength ?? 8_000,
          ),
        },
        {
          maxConcurrent: Math.max(1, options.subagents?.maxConcurrent ?? 4),
        },
        projectDiagnostics(discovered, discoveredSubagents),
      )
    } catch (error) {
      const failures: unknown[] = [error]
      try {
        runStore?.close()
      } catch (cleanupError) {
        failures.push(cleanupError)
      }
      try {
        await platform.close()
      } catch (cleanupError) {
        failures.push(cleanupError)
      }
      if (failures.length > 1)
        throw new AggregateError(
          failures,
          "Project 初始化失败，且资源回收不完整",
        )
      throw error
    }
  }

  get agentDirectory(): string {
    return join(this.root, ".ctf-agent")
  }
  tldr(challengeId: string) {
    return this.runStore.tldr(challengeId)
  }
  upsertTldr(input: Parameters<RunStore["upsertTldr"]>[0]) {
    return this.runStore.upsertTldr(input)
  }
  tldrSessionPath(challengeId: string): string {
    return join(
      challengeWorkspacePath(this.agentDirectory, challengeId),
      "tldr",
      "session.jsonl",
    )
  }
  async challengeWriteup(challengeId: string): Promise<{
    validation: WriteupValidationResult
    content: string | null
  }> {
    const workspace = challengeWorkspacePath(this.agentDirectory, challengeId)
    const validation = await validateChallengeWriteup(workspace)
    if (!validation.valid) return { validation, content: null }
    return {
      validation,
      content: await readFile(validation.path, "utf8"),
    }
  }

  async refresh(): Promise<ContestOverview> {
    return this.platform.refresh()
  }
  async overview(): Promise<ContestOverview> {
    return this.platform.getOverview()
  }
  async challenges(): Promise<ChallengeSummary[]> {
    return this.platform.listChallenges()
  }
  async announcements(): Promise<Announcement[]> {
    return this.platform.listAnnouncements()
  }
  async syncAnnouncements(options: { steerActive?: boolean } = {}): Promise<{
    announcements: number
    linked: number
    steered: number
  }> {
    const [announcements, challenges] = await Promise.all([
      this.platform.listAnnouncements(),
      this.platform.listChallenges(),
    ])
    let linked = 0
    let steered = 0
    for (const announcement of announcements) {
      const classification = classifyAnnouncement(announcement)
      const revision = announcementRevision(announcement)
      this.runStore.persistContestAnnouncement({
        key: revision.key,
        platformAnnouncementId: announcement.id,
        revisionHash: revision.revisionHash,
        title: announcement.title,
        content: announcement.content,
        publishedAt: announcement.publishedAt,
        kind: classification.kind,
        classificationReason: classification.reason,
        ignored: classification.ignored,
      })
      if (classification.ignored) continue
      for (const match of matchAnnouncementChallenges(
        announcement,
        challenges,
      )) {
        const created = this.runStore.linkChallengeAnnouncement({
          challengeId: match.challengeId,
          announcementKey: revision.key,
          matchType: match.matchType,
          matchedValue: match.matchedValue,
        })
        if (!created) continue
        linked += 1
        if (options.steerActive === false) continue
        const message = challengeAnnouncementsPrompt([
          {
            key: revision.key,
            title: announcement.title,
            content: announcement.content,
            publishedAt: announcement.publishedAt,
            kind: classification.kind,
          },
        ])
        for (const solver of [...this.solvers]) {
          if (solver.challenge.id !== match.challengeId || solver.isClosed) {
            continue
          }
          await solver.steer(message)
          this.runStore.appendEvent(solver.runId, "announcement_steered", {
            announcementKey: revision.key,
            matchType: match.matchType,
          })
          steered += 1
        }
      }
    }
    return { announcements: announcements.length, linked, steered }
  }
  availableSkills(): readonly AgentSkill[] {
    return this.skills
  }
  async environments(): Promise<RemoteEnvironment[]> {
    return this.platform.listRemoteEnvironments()
  }
  async destroyEnvironment(id: string): Promise<void> {
    await this.platform.destroyRemoteEnvironment(id)
  }
  runs(filter: RunFilter = {}): RunRecord[] {
    return this.runStore.listRuns(filter)
  }
  runEvents(runId: string): RunEvent[] {
    return this.runStore.events(runId)
  }
  latestRunEvent(runId: string): RunEvent | undefined {
    return this.runStore.latestEvent(runId)
  }
  appendRunEvent(runId: string, type: string, data?: unknown): RunEvent {
    return this.runStore.appendEvent(runId, type, data)
  }
  subagents(runId: string): SubagentRecord[] {
    return this.runStore.subagents(runId)
  }
  availableSubagents(): SubagentRole[] {
    return [...this.subagentRoles.values()].filter((role) => role.enabled)
  }
  async steerSubagent(
    runId: string,
    subagentId: string,
    message: string,
  ): Promise<SubagentRecord> {
    const manager = this.subagentManagers.get(runId)
    if (!manager) throw subagentUnavailable(runId)
    return manager.steer(subagentId, message)
  }
  async cancelSubagent(
    runId: string,
    subagentId: string,
  ): Promise<SubagentRecord> {
    const manager = this.subagentManagers.get(runId)
    if (!manager) throw subagentUnavailable(runId)
    return manager.cancel(subagentId)
  }
  isChallengeSolved(challengeId: string): boolean {
    return this.runStore.isSolved(challengeId)
  }
  nextAttempt(challengeId: string): number {
    return this.runStore.nextAttempt(challengeId)
  }
  schedulerAttemptCount(challengeId: string): number {
    return this.runStore.schedulerAttemptCount(challengeId)
  }
  sessionInterruptionCount(challengeId: string): number {
    return this.runStore.sessionInterruptionCount(challengeId)
  }
  isChallengeBlocked(challengeId: string): boolean {
    return this.runStore.isChallengeBlocked(challengeId)
  }
  resetSessionInterruptions(challengeId: string): void {
    this.runStore.resetSessionInterruptions(challengeId)
  }
  schedulerQueue(): SchedulerQueueRecord[] {
    return this.runStore.schedulerQueue()
  }
  enqueueSchedulerChallenge(
    input: EnqueueSchedulerChallenge,
  ): SchedulerQueueRecord {
    return this.runStore.enqueueSchedulerChallenge(input)
  }
  moveSchedulerChallenge(input: MoveSchedulerChallenge): SchedulerQueueRecord {
    return this.runStore.moveSchedulerChallenge(input)
  }
  removeSchedulerChallenge(challengeId: string): boolean {
    return this.runStore.removeSchedulerChallenge(challengeId)
  }
  reviveChallenge(challengeId: string) {
    return this.runStore.reviveChallenge(challengeId)
  }
  challengeRuntimeState(challengeId: string) {
    return this.runStore.challengeRuntimeState(challengeId)
  }
  recordChallengeBlockEvent(
    input: Parameters<RunStore["recordChallengeBlockEvent"]>[0],
  ) {
    return this.runStore.recordChallengeBlockEvent(input)
  }
  challengeBlockEvents(challengeId: string) {
    return this.runStore.challengeBlockEvents(challengeId)
  }
  async markRunWritingWriteup(runId: string): Promise<RunRecord> {
    const run = this.runStore.updateRun(
      runId,
      { status: "writing_writeup", error: null },
      "run_writing_writeup",
    )
    await this.persistRecord(run, join(this.agentDirectory, "runs", runId))
    return run
  }
  async markRunBlocking(runId: string, error?: string): Promise<RunRecord> {
    const run = this.runStore.updateRun(
      runId,
      { status: "blocking", error: error ?? null },
      "run_blocking",
      { error: error ?? null },
    )
    await this.persistRecord(run, join(this.agentDirectory, "runs", runId))
    return run
  }
  async finalizeSubagents(
    runId: string,
    reportPrompt: string,
    graceMs: number,
  ): Promise<SubagentRecord[]> {
    const manager = this.subagentManagers.get(runId)
    if (!manager) return this.runStore.subagents(runId)
    const records = manager.list()
    await Promise.all(
      records
        .filter((record) => record.status === "running")
        .map(async (record) => {
          try {
            await manager.steer(record.id, reportPrompt)
          } catch {
            // worker 可能在 steer 前已自然结束，最终 snapshot 会读取最新状态。
          }
        }),
    )
    await Promise.all(
      records
        .filter(
          (record) => record.status === "running" || record.status === "queued",
        )
        .map(async (record) => {
          await Promise.race([
            manager.wait(record.id).catch(() => undefined),
            new Promise<void>((resolve) => setTimeout(resolve, graceMs)),
          ])
        }),
    )
    return manager.list()
  }
  blackboard(challengeId: string) {
    return this.runStore.getBlackboardSummary(challengeId)
  }
  blackboardStats() {
    return this.runStore.getBlackboardStats()
  }
  diagnostics(): readonly ProjectDiagnostic[] {
    return [...this.diagnosticLog]
  }

  /**
   * 向该题当前活跃的 solver 发送人工消息(题目级对话框入口)。
   * 消息经 pi-agent steer() 在下一 turn 边界注入,并先落 human_message 事件。
   * 无活跃 solver → 抛 code:"no_active_run";空文本 → 抛 code:"invalid_message"。
   * 整个临界区同步完成(appendEvent 与 steer 均为同步调用),杜绝检查与注入之间的交错。
   */
  async sendMessage(
    challengeId: string,
    text: string,
  ): Promise<{ runId: string }> {
    const trimmed = text.trim()
    if (!trimmed) {
      throw Object.assign(new Error("消息不能为空"), {
        code: "invalid_message",
      })
    }
    for (const solver of [...this.solvers].reverse()) {
      if (solver.challenge.id !== challengeId || solver.isClosed) continue
      try {
        this.runStore.appendEvent(solver.runId, "human_message", {
          text: trimmed,
          ts: new Date().toISOString(),
        })
      } catch {
        // runStore 已关闭 ≈ Project 正在关闭,视同无活跃 solver
        throw noActiveRunError()
      }
      await solver.queueUserMessage(trimmed)
      return { runId: solver.runId }
    }
    throw noActiveRunError()
  }

  /**
   * 切换该题当前活跃 solver 的思考强度,当前 run 的下一 turn 边界生效
   * (CtfSolverAgent.prepareNextTurn 包装注入)。先落 thinking_level_update 事件再赋值,
   * 事件经 appendEvent 旁路(RunStore 透传),不走 solver 事件流(裸 Agent 空闲时
   * processEvents 抛错)。无活跃 solver → 抛 code:"no_active_run";非法档位 → code:"invalid_level"。
   */
  async setThinkingLevel(
    challengeId: string,
    level: ThinkingLevel,
  ): Promise<{ runId: string }> {
    if (!isThinkingLevel(level)) {
      throw Object.assign(new Error(`不支持的思考强度: ${level}`), {
        code: "invalid_level",
      })
    }
    for (const solver of [...this.solvers].reverse()) {
      if (solver.challenge.id !== challengeId || solver.isClosed) continue
      const resolvedLevel = resolveThinkingLevel(solver.model, level)
      try {
        this.runStore.appendEvent(solver.runId, "thinking_level_update", {
          level: resolvedLevel,
          ts: new Date().toISOString(),
        })
      } catch {
        throw noActiveRunError()
      }
      await solver.setThinkingLevel(resolvedLevel)
      return { runId: solver.runId }
    }
    throw noActiveRunError()
  }

  async createSolver(
    challengeId: string,
    options: CreateSolverOptions,
  ): Promise<CtfSolverAgent> {
    return this.createSolverForRun(challengeId, options)
  }

  /**
   * Reopen an interrupted solver from its persisted JSONL session. The caller
   * supplies the live model transport again; credentials are intentionally not
   * persisted with the session.
   */
  async resumeSolver(
    runId: string,
    options: Omit<CreateSolverOptions, "attempt" | "source">,
  ): Promise<CtfSolverAgent> {
    const run = this.runStore.getRun(runId)
    if (run?.status !== "interrupted") {
      throw new Error(`Run ${runId} 不存在或当前不可恢复`)
    }
    return this.createSolverForRun(run.challengeId, options, run)
  }

  private async createSolverForRun(
    challengeId: string,
    options: CreateSolverOptions,
    resumed?: RunRecord,
  ): Promise<CtfSolverAgent> {
    if (this.closed) throw new Error("Project 已关闭")
    const runId = resumed?.id ?? newRunId()
    const runDirectory = join(this.agentDirectory, "runs", runId)
    const workspace =
      resumed?.workspace ??
      challengeWorkspacePath(this.agentDirectory, challengeId)
    // Run session 与题目级持久 workspace 分离；后者跨复活复用。
    await Promise.all([
      mkdir(runDirectory, { recursive: true }),
      mkdir(workspace, { recursive: true }),
    ])
    if (!resumed) {
      const record = this.runStore.createRun({
        id: runId,
        challengeId,
        workspace,
        attempt: options.attempt ?? this.runStore.nextAttempt(challengeId),
        source: options.source ?? "direct",
      })
      await this.persistRecord(record, runDirectory)
    }

    let capability:
      | Awaited<ReturnType<PlatformProject["bindChallenge"]>>
      | undefined
    let sandbox: Sandbox | undefined
    let subagentManager: CtfSubagentManager | undefined
    try {
      capability = await this.platform.bindChallenge(challengeId)
      const challenge = await capability.getInfo()

      // 确保黑板 origin 存在，并准备自动注入内容
      this.runStore.ensureOrigin(challengeId, runId, {
        title: challenge.title,
        category: challenge.category,
        score: challenge.score,
        description: challenge.description,
        attachments: challenge.attachments.map((a) => ({
          name: a.name,
          size: a.size,
        })),
      })
      const blackboardInject = injectBlackboard(this.runStore, challengeId)
      const blackboardMessages: AgentMessage[] =
        !resumed && blackboardInject
          ? [{ role: "user", content: blackboardInject, timestamp: Date.now() }]
          : []
      const persistedAnnouncements =
        this.runStore.challengeAnnouncements(challengeId)
      const announcementMessages: AgentMessage[] =
        !resumed && persistedAnnouncements.length > 0
          ? [
              {
                role: "user",
                content: challengeAnnouncementsPrompt(persistedAnnouncements),
                timestamp: Date.now(),
              },
            ]
          : []

      // skills 的脚本/参考资料必须在容器内可见，不能把宿主机路径注入给 Agent。
      const skills = await materializeSkills(this.skills, workspace)
      sandbox = await this.sandboxFactory({
        projectId: this.config.project.id,
        runId,
        image: this.config.sandbox.image,
        workspace,
        workspaceMount: this.workspaceMount?.({
          runId,
          workspace,
          relativeWorkspace: `challenges/${challengeWorkspaceKey(challengeId)}/workspace`,
        }),
        privileged: this.config.sandbox.privileged,
        networkMode: this.config.sandbox.networkMode,
      })
      const downloadedAttachments = await downloadChallengeAttachments({
        capability,
        attachments: challenge.attachments,
        sandbox,
      })
      const challengeMessages: AgentMessage[] = resumed
        ? []
        : [
            {
              role: "user",
              content: challengeContextPrompt(challenge, downloadedAttachments),
              timestamp: Date.now(),
            },
          ]

      subagentManager = new CtfSubagentManager({
        projectId: this.config.project.id,
        runId,
        runDirectory,
        challenge,
        sandbox,
        agent: options.agent,
        roles: this.subagentRoles,
        skills,
        maxConcurrent: this.subagentRuntime.maxConcurrent,
        onRecord: (subagent, event) => {
          try {
            this.runStore.upsertSubagent(subagent)
            this.runStore.appendEvent(runId, `subagent_${event}`, {
              subagentId: subagent.id,
              role: subagent.role,
              description: subagent.description,
              status: subagent.status,
              activeTool: subagent.activeTool,
              turns: subagent.turns,
              toolUses: subagent.toolUses,
              totalTokens: subagent.totalTokens,
            })
          } catch (error) {
            this.recordDiagnostic("telemetry", error, runId)
          }
        },
      })
      if (resumed) subagentManager.restore(this.runStore.subagents(runId))

      let solver!: CtfSolverAgent
      solver = await CtfSolverAgent.create({
        identity: {
          projectId: this.config.project.id,
          runId,
          runDirectory,
          workspace,
          challenge,
        },
        capability,
        sandbox,
        agent: {
          ...options.agent,
          initialState: {
            ...options.agent.initialState,
            tools: [
              ...(options.agent.initialState?.tools ?? []),
              ...createBlackboardTools({
                runStore: this.runStore,
                challengeId,
                runId,
              }),
              ...createSubagentManagerTools(subagentManager),
            ],
            systemPrompt: [
              options.agent.initialState?.systemPrompt,
              CHALLENGE_CONTEXT_SYSTEM_GUIDANCE,
              BLACKBOARD_SYSTEM_GUIDANCE,
              subagentDelegationPrompt(subagentManager.availableRoles()),
            ]
              .filter(Boolean)
              .join("\n\n"),
            messages: [
              ...(options.agent.initialState?.messages ?? []),
              ...challengeMessages,
              ...blackboardMessages,
              ...announcementMessages,
            ],
          },
        },
        features: {
          skills,
          compaction: options.compaction,
          closeOnSubmission: options.writeup !== true,
        },
        onBeforeCleanup: () => subagentManager?.close(),
        onClosed: async (details) => {
          this.solvers.delete(solver)
          this.subagentManagers.delete(runId)
          const eventType =
            details.reason === "interrupted"
              ? "run_interrupted"
              : details.reason === "blocked"
                ? "run_blocked"
                : "run_finished"
          const updated = this.runStore.updateRun(
            runId,
            {
              status: runStatus(details),
              closeReason: details.reason,
              error: details.error ?? null,
              cleanupError:
                details.cleanupErrors.length > 0
                  ? details.cleanupErrors.join("\n")
                  : null,
              finishedAt: new Date().toISOString(),
            },
            eventType,
            details,
          )
          await this.persistRecord(updated, runDirectory)
        },
      })
      subagentManager.attachParent(solver)
      const telemetryCalls = new Map<
        string,
        { toolName: string; args: unknown }
      >()
      // pi 在 message_end 中提供完整的 thinking block。按 turn 持久化一条，避免
      // reasoning token 逐片写入 SQLite，导致事件表/WAL 和 Dashboard 查询爆炸。
      solver.subscribe((event) => {
        if (event.type === "message_end" && solver.thinkingLevel !== "off") {
          try {
            const thinking = extractThinkingText(event.message)
            if (thinking) {
              this.runStore.appendEvent(runId, "agent_thinking", {
                text: thinking,
                ts: new Date().toISOString(),
              })
            }
          } catch (error) {
            this.recordDiagnostic("telemetry", error, runId)
          }
        }
        // assistant 文本回复不 gate 于 thinkingLevel:对话框的 agent_message
        // 事件必须始终可见(人工干涉的前提是能看到回复)。
        if (event.type === "message_end") {
          try {
            const text = extractAssistantText(event.message)
            if (text) {
              this.runStore.appendEvent(runId, "agent_message", {
                text,
                ts: new Date().toISOString(),
              })
            }
          } catch (error) {
            this.recordDiagnostic("telemetry", error, runId)
          }
        }
        // token 消耗记录:不 gate 于 thinkingLevel(用量与思维链开关无关,off 也要记)。
        // 部分 provider 可能不返回 usage(运行时为 undefined),缺失即跳过,导出按存在值汇总。
        if (
          event.type === "message_end" &&
          event.message.role === "assistant" &&
          event.message.usage
        ) {
          try {
            const { usage } = event.message
            this.runStore.appendEvent(runId, "agent_usage", {
              input: usage.input,
              output: usage.output,
              cacheRead: usage.cacheRead,
              cacheWrite: usage.cacheWrite,
              ...(usage.reasoning === undefined
                ? {}
                : { reasoning: usage.reasoning }),
              totalTokens: usage.totalTokens,
              cost: usage.cost,
              ts: new Date().toISOString(),
            })
          } catch (error) {
            this.recordDiagnostic("telemetry", error, runId)
          }
        }
        const progress = progressEvents(event, this.telemetry, telemetryCalls)
        for (const item of progress) {
          try {
            this.runStore.appendEvent(runId, item.type, item.data)
          } catch (error) {
            this.recordDiagnostic("telemetry", error, runId)
          }
        }
      })
      const running = this.runStore.updateRun(
        runId,
        {
          status: "running",
          closeReason: null,
          error: null,
          cleanupError: null,
          finishedAt: null,
          startedAt: new Date().toISOString(),
        },
        resumed ? "run_resumed" : "run_started",
      )
      await this.persistRecord(running, runDirectory)
      this.solvers.add(solver)
      this.subagentManagers.set(runId, subagentManager)
      return solver
    } catch (error) {
      const cleanupErrors: string[] = []
      if (subagentManager) {
        try {
          await subagentManager.close()
        } catch (cleanupError) {
          cleanupErrors.push(`SubAgent 回收失败: ${errorText(cleanupError)}`)
        }
      }
      if (capability?.instance) {
        try {
          await capability.instance.destroy()
        } catch (cleanupError) {
          cleanupErrors.push(`远程实例销毁失败: ${errorText(cleanupError)}`)
        }
      }
      if (sandbox) {
        try {
          await sandbox.close()
        } catch (cleanupError) {
          cleanupErrors.push(`Sandbox 关闭失败: ${errorText(cleanupError)}`)
        }
      }
      const failures: unknown[] = [
        error,
        ...cleanupErrors.map((message) => new Error(message)),
      ]
      try {
        const retryable = isRetryablePlatformError(error)
        const updated = this.runStore.updateRun(
          runId,
          {
            status: "failed",
            closeReason: "failed",
            error: errorText(error),
            cleanupError:
              cleanupErrors.length > 0 ? cleanupErrors.join("\n") : null,
            finishedAt: new Date().toISOString(),
          },
          "run_creation_failed",
          { error: errorText(error), cleanupErrors, retryable },
        )
        await this.persistRecord(updated, runDirectory)
      } catch (persistenceError) {
        failures.push(persistenceError)
      }
      if (failures.length > 1) {
        throw Object.assign(
          new AggregateError(failures, `无法创建 Solver ${runId}`),
          { retryable: isRetryablePlatformError(error) },
        )
      }
      throw error
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const errors: unknown[] = []
    const solverResults = await Promise.allSettled(
      [...this.solvers].map((solver) => solver.close("manual")),
    )
    for (const result of solverResults)
      if (result.status === "rejected") errors.push(result.reason)
    try {
      await this.platform.close()
    } catch (error) {
      errors.push(error)
    }
    try {
      this.runStore.close()
    } catch (error) {
      errors.push(error)
    }
    if (errors.length > 0)
      throw new AggregateError(errors, "Project 关闭时发生错误")
  }

  private async persistRecord(
    record: RunRecord,
    runDirectory: string,
  ): Promise<void> {
    const target = join(runDirectory, "run.json")
    const temporary = `${target}.tmp-${process.pid}`
    await writeFile(temporary, JSON.stringify(record, null, 2))
    await rename(temporary, target)
  }

  private recordDiagnostic(
    code: ProjectDiagnostic["code"],
    error: unknown,
    runId?: string,
  ): void {
    if (this.diagnosticLog.length >= 100) this.diagnosticLog.shift()
    this.diagnosticLog.push({
      code,
      message: errorText(error),
      createdAt: new Date().toISOString(),
      ...(runId ? { runId } : {}),
    })
  }
}

function runStatus(details: SolverCloseDetails): RunStatus {
  switch (details.reason) {
    case "submitted":
      return "solved"
    case "failed":
      return "failed"
    case "timed_out":
      return "timed_out"
    case "cancelled":
      return "cancelled"
    case "manual":
      return "closed"
    case "interrupted":
      return "interrupted"
    case "blocked":
      return "blocked"
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 该题无活跃 solver 的错误契约:webui server 层按 code 映射 409(跨包不依赖错误类型)。 */
function noActiveRunError(): Error {
  return Object.assign(new Error("该题当前没有运行中的 Agent"), {
    code: "no_active_run",
  })
}

function subagentUnavailable(runId: string): Error {
  return Object.assign(
    new Error(`Run ${runId} 当前没有活跃的 SubAgent manager`),
    {
      code: "subagent_unavailable",
    },
  )
}

function injectBlackboard(runStore: RunStore, challengeId: string): string {
  const summary = runStore.getBlackboardSummary(challengeId)
  const text = serializeBlackboard(summary, {
    maxCharacters: BLACKBOARD_INJECTION_MAX_CHARACTERS,
  })
  if (!text) return ""
  const encoded = JSON.stringify({ snapshot: text })
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
  return blackboardSnapshotPrompt(encoded)
}

function progressEvents(
  event: AgentHarnessEvent,
  telemetry: Required<ProjectTelemetryOptions>,
  calls: Map<string, { toolName: string; args: unknown }>,
): Array<{ type: string; data?: unknown }> {
  if (event.type === "agent_start") return [{ type: "agent_started" }]
  if (event.type === "tool_execution_start") {
    calls.set(event.toolCallId, { toolName: event.toolName, args: event.args })
    return [
      {
        type: "tool_started",
        data: {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: tracedToolArgs(event.toolName, event.args, telemetry),
        },
      },
    ]
  }
  if (event.type === "tool_execution_end") {
    const started = calls.get(event.toolCallId)
    calls.delete(event.toolCallId)
    const finished: Array<{ type: string; data?: unknown }> = [
      {
        type: "tool_finished",
        data: {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          isError: event.isError,
          ...(telemetry.level === "full"
            ? { result: tracedValue(event.result, telemetry.maxTextLength) }
            : {}),
        },
      },
    ]
    if (event.toolName === "ctf_submit_flag") {
      const submission = flagSubmission(event.result)
      finished.push({
        type: "flag_submitted",
        data: {
          toolCallId: event.toolCallId,
          flag:
            telemetry.level === "full"
              ? clippedText(
                  field(started?.args, "flag"),
                  telemetry.maxTextLength,
                )
              : "[redacted]",
          status: submission?.status ?? "unknown",
          message: submission?.message ?? "",
        },
      })
    }
    return finished
  }
  return []
}

function tracedToolArgs(
  toolName: string,
  args: unknown,
  telemetry: Required<ProjectTelemetryOptions>,
): Record<string, unknown> {
  const input =
    typeof args === "object" && args !== null
      ? (args as Record<string, unknown>)
      : {}
  if (telemetry.level === "full") {
    return tracedValue(
      input,
      telemetry.maxTextLength,
      toolName === "ctf_submit_flag",
    ) as Record<string, unknown>
  }
  if (toolName === "ctf_submit_flag") return { flag: "[redacted]" }
  if (toolName === "bash") return { command: "[omitted]" }
  if (toolName === "write")
    return { path: clippedText(input.path, 240), content: "[omitted]" }
  if (toolName === "edit")
    return { path: clippedText(input.path, 240), edits: "[omitted]" }
  if (toolName === "ctf_blackboard_record") {
    return {
      operations: ["evidence", "opportunity", "concludeOpportunity"].filter(
        (key) => input[key] !== undefined,
      ),
    }
  }
  return Object.fromEntries(
    Object.entries(input)
      .slice(0, 8)
      .map(([key, value]) => [
        key,
        /key|token|secret|password|authorization|flag/i.test(key)
          ? "[redacted]"
          : clippedValue(value, 240),
      ]),
  )
}

function clippedValue(value: unknown, maxLength: number): unknown {
  if (typeof value === "string") return clippedText(value, maxLength)
  if (typeof value === "number" || typeof value === "boolean" || value === null)
    return value
  if (Array.isArray(value))
    return value.slice(0, 8).map((item) => clippedValue(item, maxLength))
  return value === undefined ? undefined : "[object]"
}

function clippedText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return ""
  return value.length <= maxLength
    ? value
    : `${value.slice(0, Math.max(0, maxLength - 3))}...`
}

function tracedValue(
  value: unknown,
  maxTextLength: number,
  allowFlag = false,
  depth = 0,
): unknown {
  if (typeof value === "string") return clippedText(value, maxTextLength)
  if (typeof value === "number" || typeof value === "boolean" || value === null)
    return value
  if (value === undefined) return undefined
  if (depth >= 5) return "[max-depth]"
  if (Array.isArray(value)) {
    return value
      .slice(0, 64)
      .map((item) => tracedValue(item, maxTextLength, allowFlag, depth + 1))
  }
  if (typeof value !== "object") return String(value)
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 64)
      .map(([key, child]) => [
        key,
        /api.?key|token|secret|password|authorization/i.test(key) ||
        (!allowFlag && /flag/i.test(key))
          ? "[redacted]"
          : tracedValue(child, maxTextLength, allowFlag, depth + 1),
      ]),
  )
}

function flagSubmission(
  value: unknown,
): { status?: string; message?: string } | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const result = value as Record<string, unknown>
  const details =
    typeof result.details === "object" && result.details !== null
      ? (result.details as Record<string, unknown>)
      : result
  return {
    ...(typeof details.status === "string" ? { status: details.status } : {}),
    ...(typeof details.message === "string"
      ? { message: details.message }
      : {}),
  }
}

function field(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined
  return (value as Record<string, unknown>)[key]
}

function projectDiagnostics(
  skills: Awaited<ReturnType<typeof discoverProjectSkillsWithDiagnostics>>,
  subagents: DiscoveredSubagentRoles,
): ProjectDiagnostic[] {
  const createdAt = new Date().toISOString()
  return [
    ...skills.diagnostics.map((diagnostic) => ({
      code: "skill" as const,
      message: diagnostic.message,
      path: diagnostic.path,
      createdAt,
    })),
    ...subagents.diagnostics.map((diagnostic) => ({
      code: "subagent" as const,
      message: diagnostic.message,
      path: diagnostic.path,
      createdAt,
    })),
  ]
}
