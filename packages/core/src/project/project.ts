import { existsSync } from "node:fs"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import {
  type AgentSkill,
  CtfSolverAgent,
  CtfTldrAgent,
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
  activeSubagentsPrompt,
  blackboardSnapshotPrompt,
  challengeAnnouncementsPrompt,
  challengeContextPrompt,
} from "@ctf-agent/prompts"
import {
  DockerSandbox,
  clearDockerWorkspace,
  type DockerSandboxOptions,
  type DockerWorkspaceMount,
  newRunId,
  removeManagedContainers,
  type Sandbox,
} from "@ctf-agent/sandbox"
import {
  createShellPoopSession,
  type ShellPoopConfig,
  type ShellPoopSession,
} from "@ctf-agent/shellpoop"
import { createWebAccessTools, type WebAccessConfig } from "@ctf-agent/web-access"
import type {
  AgentHarnessEvent,
  AgentMessage,
  AgentOptions,
  AgentTool,
  ThinkingLevel,
} from "@earendil-works/pi-agent-core"
import { extractAssistantText, extractThinkingText } from "../agent/thinking.ts"
import {
  BLACKBOARD_INJECTION_MAX_CHARACTERS,
  createBlackboardReadTool,
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
  filterAnnouncementKeywords,
  matchAnnouncementChallenges,
} from "../orchestration/announcement-matcher.ts"
import {
  validateChallengeWriteup,
  type WriteupValidationResult,
} from "../orchestration/writeup-validator.ts"
import {
  type AnnouncementApprovalStatus,
  type ChallengeAnnouncementRecord,
  type ChallengeSchedulingDisposition,
  type EnqueueSchedulerChallenge,
  type MoveSchedulerChallenge,
  type PlatformViewCache,
  type RunEvent,
  type RunFilter,
  type RunRecord,
  type RunSource,
  type RunStatus,
  RunStore,
  type SchedulerMode,
  type SchedulerQueueRecord,
  type SchedulerQueueStage,
  type SchedulerStateRecord,
  type TldrRecord,
} from "../persistence/run-store.ts"
import type {
  AgentStreamEvent,
  AgentStreamListener,
  AgentStreamPayload,
  AgentStreamTarget,
} from "./agent-stream.ts"
import { appendAgentMessageDelta } from "./agent-stream.ts"
import {
  ChallengeAttachmentError,
  challengeAttachmentPath,
  downloadChallengeAttachments,
} from "./attachments.ts"
import {
  challengeWorkspaceKey,
  challengeWorkspacePath,
  listWorkspaceArtifacts,
  readWorkspaceArtifact,
  type WorkspaceArtifactListing,
} from "./challenge-workspace.ts"
import {
  findProjectRoot,
  loadProjectConfig,
  type ProjectConfig,
  parseProjectConfig,
} from "./config.ts"
import {
  RemoteEnvironmentCoordinator,
  type RemoteEnvironmentExecutionGate,
} from "./remote-environment-coordinator.ts"
import { createTldrWorkspaceTools } from "./tldr-workspace-tools.ts"

export interface OpenProjectOptions {
  root?: string
  /** 已由控制面加载的配置；提供时不再从 .pi/ctf-config.json 重读。 */
  config?: ProjectConfig
  /** RunStore、session 与 challenge workspace 的隔离目录。 */
  stateDirectory?: string
  /** Docker volume 中该 Project workspace 的相对命名空间。 */
  workspaceNamespace?: string
  platforms: readonly PlatformPlugin[]
  /** Resolve a named secret without placing credentials in project config. */
  resolveSecret?: (name: string) => string | undefined
  sandboxFactory?: (options: DockerSandboxOptions) => Promise<Sandbox>
  /**
   * 按 runId 回收托管 sandbox 容器（含孤儿容器）。缺省仅在 sandboxFactory 未注入
   * （即使用真实 DockerSandbox）时启用 `removeManagedContainers`，测试注入自定义
   * factory 时跳过，避免测试触碰真实 docker。
   */
  removeManagedSandboxes?: (runIds: readonly string[]) => Promise<void>
  /** 清空题目 workspace；生产默认通过 Docker 处理 root-owned 文件，测试可注入宿主实现。 */
  clearWorkspace?: (input: {
    image: string
    workspace: string
    workspaceMount: DockerWorkspaceMount
  }) => Promise<void>
  /** 在 .pi/skills 外额外发现的显式 skill 目录。 */
  skillPaths?: readonly string[]
  /**
   * web-access 工具配置工厂：给定宿主 challenge workspace（bind-mount 到容器
   * /workspace）与 run 级 AbortSignal（run 结束 abort → 清理 web 缓存），返回
   * WebAccessConfig；返回 null 时禁用 web 工具。
   */
  webAccessConfig?: (
    workspace: string,
    signal: AbortSignal,
  ) => WebAccessConfig | null | Promise<WebAccessConfig | null>
  /**
   * ShellPoop 反弹 shell 工具配置工厂：给定 run 级 AbortSignal（run 结束 abort
   * → 取消进行中的请求）与 challenge 上下文（用于把 shell 绑定到所属 challenge），
   * 返回 ShellPoopConfig；返回 null 时禁用反弹 shell 工具。
   */
  shellpoopConfig?: (
    signal: AbortSignal,
    context: { challengeId: string; runId: string },
  ) => ShellPoopConfig | null | Promise<ShellPoopConfig | null>
  /** 内置 Token 消耗插件的动态开关；省略时保持向后兼容并默认采集。 */
  tokenUsageEnabled?: () => boolean
  /** 控制面运行在容器中时，将 Run workspace 映射为 Docker daemon 可见的挂载。 */
  workspaceMount?: (context: {
    runId: string
    workspace: string
    relativeWorkspace: string
  }) => DockerWorkspaceMount
  telemetry?: ProjectTelemetryOptions
  subagents?: {
    maxConcurrent?: number
    /** WebUI 的模型池可在创建新 Run 时覆盖 role frontmatter 中的 model。 */
    modelForRole?: (role: string) => string | undefined
  }
  remoteEnvironments?: {
    /** 同一 Project 最多同时占用的平台远程环境数量。 */
    maxConcurrent?: number
  }
}

export interface ProjectTelemetryOptions {
  level?: "safe" | "full"
  maxTextLength?: number
}

export interface ProjectDiagnostic {
  code: "skill" | "subagent" | "telemetry" | "environment" | "sandbox"
  message: string
  createdAt: string
  path?: string
  runId?: string
}

/** Pi HTML 导出需要的 AgentState 子集，可跨进程持久化。 */
export interface RunSessionExportMetadata {
  systemPrompt: string
  tools: Array<{
    name: string
    description?: string
    parameters?: unknown
  }>
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
  /** Scheduler phase hook; waiting for remote capacity keeps the Run's Sandbox slot. */
  executionGate?: RemoteEnvironmentExecutionGate
}

export class SolverCreationError extends Error {
  readonly code = "SOLVER_CREATION_FAILED"

  constructor(
    readonly runId: string,
    readonly attachmentFailure: boolean,
    readonly blocked: boolean,
    readonly retryable: boolean,
    cause: unknown,
  ) {
    super(`无法创建 Solver ${runId}: ${errorText(cause)}`, { cause })
    this.name = "SolverCreationError"
  }
}

/**
 * Project 是比赛的基本单元：它拥有完整平台 API 与持久化；Solver 永远只获得单题 capability。
 */
export class Project {
  readonly root: string
  readonly config: ProjectConfig
  readonly agentDirectory: string
  private readonly solvers = new Set<CtfSolverAgent>()
  private readonly subagentManagers = new Map<string, CtfSubagentManager>()
  private readonly runChallengeContexts = new Map<string, string>()
  private readonly challengeSchedulingHints = new Map<
    string,
    { needsEnv: boolean; hasAttachments: boolean }
  >()
  private readonly diagnosticLog: ProjectDiagnostic[]
  private readonly agentStreamListeners = new Set<{
    target: AgentStreamTarget
    listener: AgentStreamListener
  }>()
  private readonly agentStreamSequences = new Map<string, number>()
  private readonly activeStreamMessages = new Map<string, string>()
  /** 当前未落盘的 assistant 消息，用于浏览器重连后恢复流式 thinking。 */
  private readonly activeStreamSnapshots = new Map<
    string,
    { messageId: string; message: AgentMessage }
  >()
  private readonly tldrRefreshes = new Map<string, Promise<TldrRecord>>()
  private closed = false
  private constructor(
    root: string,
    config: ProjectConfig,
    agentDirectory: string,
    private readonly platform: PlatformProject,
    private readonly sandboxFactory: (options: DockerSandboxOptions) => Promise<Sandbox>,
    private readonly removeManagedSandboxes: OpenProjectOptions["removeManagedSandboxes"],
    private readonly clearWorkspace: NonNullable<OpenProjectOptions["clearWorkspace"]>,
    private readonly skills: readonly AgentSkill[],
    private readonly subagentRoles: ReadonlyMap<string, SubagentRole>,
    private readonly runStore: RunStore,
    private readonly remoteEnvironments: RemoteEnvironmentCoordinator,
    private readonly workspaceMount: OpenProjectOptions["workspaceMount"],
    private readonly workspaceNamespace: string | undefined,
    private readonly webAccessConfig: OpenProjectOptions["webAccessConfig"],
    private readonly shellpoopConfig: OpenProjectOptions["shellpoopConfig"],
    private readonly tokenUsageEnabled: () => boolean,
    private readonly telemetry: Required<ProjectTelemetryOptions>,
    private readonly subagentRuntime: {
      maxConcurrent: number
      modelForRole?: (role: string) => string | undefined
    },
    private readonly localOnly: boolean,
    diagnostics: readonly ProjectDiagnostic[],
  ) {
    this.root = root
    this.config = config
    this.agentDirectory = agentDirectory
    this.diagnosticLog = [...diagnostics]
  }

  static async open(options: OpenProjectOptions): Promise<Project> {
    const root = options.config
      ? resolve(options.root ?? process.cwd())
      : await findProjectRoot(options.root)
    const config = options.config
      ? parseProjectConfig(options.config)
      : await loadProjectConfig(root)
    const plugin = options.platforms.find((candidate) => candidate.id === config.platform.plugin)
    if (!plugin) throw new Error(`未注册平台插件: ${config.platform.plugin}`)
    const platformConfig = plugin.config.parse(config.platform.config)
    const platform = await plugin.connect({
      project: config.project,
      config: platformConfig,
      resolveSecret: options.resolveSecret ?? (() => undefined),
    })
    return await Project.initialize(options, root, config, platform, false)
  }

  /** 只打开本地 SQLite、session 与 workspace，不访问比赛平台。 */
  static async openLocal(options: OpenProjectOptions): Promise<Project> {
    const root = options.config
      ? resolve(options.root ?? process.cwd())
      : await findProjectRoot(options.root)
    const config = options.config
      ? parseProjectConfig(options.config)
      : await loadProjectConfig(root)
    return await Project.initialize(options, root, config, unavailablePlatform(), true)
  }

  private static async initialize(
    options: OpenProjectOptions,
    root: string,
    config: ProjectConfig,
    platform: PlatformProject,
    localOnly: boolean,
  ): Promise<Project> {
    let runStore: RunStore | undefined
    try {
      const [discovered, discoveredSubagents] = await Promise.all([
        discoverProjectSkillsWithDiagnostics(root, options.skillPaths),
        discoverSubagentRoles(root),
      ])
      const agentDirectory = resolve(options.stateDirectory ?? join(root, ".ctf-agent"))
      await mkdir(agentDirectory, { recursive: true })
      runStore = await RunStore.open(join(agentDirectory, "runs.sqlite"))
      // Project.open 只可能发生在新进程/新控制面中；遗留活跃记录不可继续信任。
      const interruptedRuns = runStore.markInterruptedRuns()
      runStore.markInterruptedSubagents()
      const removeManagedSandboxes =
        options.removeManagedSandboxes ??
        (options.sandboxFactory === undefined ? removeManagedContainers : undefined)
      const sandboxDiagnostics: ProjectDiagnostic[] = []
      if (removeManagedSandboxes && interruptedRuns.length > 0) {
        try {
          await removeManagedSandboxes(interruptedRuns.map((run) => run.id))
        } catch (error) {
          // SIGKILL/OOM 无法执行进程关闭钩子；保留诊断并允许读取本地记录，
          // 后续显式重置仍会再次按 run 标签尝试回收这些容器。
          sandboxDiagnostics.push({
            code: "sandbox",
            message: `遗留 Docker Sandbox 回收失败: ${errorText(error)}`,
            createdAt: new Date().toISOString(),
          })
        }
      }
      const remoteEnvironments = new RemoteEnvironmentCoordinator(
        options.remoteEnvironments?.maxConcurrent ?? 1,
        runStore,
      )
      const environmentDiagnostics = localOnly ? [] : await remoteEnvironments.reconcile(platform)
      return new Project(
        root,
        config,
        agentDirectory,
        platform,
        options.sandboxFactory ?? ((sandboxOptions) => DockerSandbox.create(sandboxOptions)),
        removeManagedSandboxes,
        options.clearWorkspace ??
          (options.sandboxFactory === undefined
            ? async ({ image, workspaceMount }) => clearDockerWorkspace({ image, workspaceMount })
            : async ({ workspace }) => {
                await rm(workspace, { recursive: true, force: true })
              }),
        discovered.skills,
        discoveredSubagents.roles,
        runStore,
        remoteEnvironments,
        options.workspaceMount,
        normalizeWorkspaceNamespace(options.workspaceNamespace),
        options.webAccessConfig,
        options.shellpoopConfig,
        options.tokenUsageEnabled ?? (() => true),
        {
          level: options.telemetry?.level ?? "safe",
          maxTextLength: Math.max(240, options.telemetry?.maxTextLength ?? 8_000),
        },
        {
          maxConcurrent: Math.max(1, options.subagents?.maxConcurrent ?? 4),
          ...(options.subagents?.modelForRole
            ? { modelForRole: options.subagents.modelForRole }
            : {}),
        },
        localOnly,
        [
          ...projectDiagnostics(discovered, discoveredSubagents),
          ...sandboxDiagnostics,
          ...environmentDiagnostics.map((message) => ({
            code: "environment" as const,
            message,
            createdAt: new Date().toISOString(),
          })),
        ],
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
        throw new AggregateError(failures, "Project 初始化失败，且资源回收不完整")
      throw error
    }
  }

  runSessionPath(runId: string): string {
    return join(this.agentDirectory, "runs", runId, "session.jsonl")
  }

  /** 订阅某个 Solver 或 SubAgent 的瞬时 Pi 事件；持久化对话仍以 JSONL 为准。 */
  subscribeAgentStream(target: AgentStreamTarget, listener: AgentStreamListener): () => void {
    const subscription = { target: { ...target }, listener }
    this.agentStreamListeners.add(subscription)
    const key = `${target.runId}\u0000${target.subagentId ?? "solver"}`
    const snapshot = this.activeStreamSnapshots.get(key)
    if (snapshot) {
      listener({
        type: "message_started",
        messageId: snapshot.messageId,
        message: snapshot.message,
        runId: target.runId,
        ...(target.subagentId ? { subagentId: target.subagentId } : {}),
        seq: this.agentStreamSequences.get(key) ?? 0,
        createdAt: new Date().toISOString(),
      })
    }
    return () => this.agentStreamListeners.delete(subscription)
  }
  async runSessionExportMetadata(runId: string): Promise<RunSessionExportMetadata | undefined> {
    const activeSolver = [...this.solvers].find(
      (solver) => solver.runId === runId && !solver.isClosed,
    )
    if (activeSolver) return solverExportMetadata(activeSolver)

    try {
      const source = await readFile(
        join(this.agentDirectory, "runs", runId, "session-export-metadata.json"),
        "utf8",
      )
      return parseSessionExportMetadata(JSON.parse(source))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
      this.recordDiagnostic("telemetry", error, runId)
      return undefined
    }
  }
  tldr(challengeId: string) {
    return this.runStore.tldr(challengeId)
  }
  upsertTldr(input: Parameters<RunStore["upsertTldr"]>[0]) {
    return this.runStore.upsertTldr(input)
  }
  tldrSessionPath(challengeId: string): string {
    return join(challengeWorkspacePath(this.agentDirectory, challengeId), "tldr", "session.jsonl")
  }
  async refreshTldr(challengeId: string, agent: AgentOptions): Promise<TldrRecord> {
    const active = this.tldrRefreshes.get(challengeId)
    if (active) return active
    const refresh = this.generateTldr(challengeId, agent)
    this.tldrRefreshes.set(challengeId, refresh)
    try {
      return await refresh
    } finally {
      if (this.tldrRefreshes.get(challengeId) === refresh) {
        this.tldrRefreshes.delete(challengeId)
      }
    }
  }

  private async generateTldr(challengeId: string, agent: AgentOptions): Promise<TldrRecord> {
    const model = agent.initialState?.model
    if (!model) throw new Error("TLDR Agent 缺少可用模型")
    const workspace = challengeWorkspacePath(this.agentDirectory, challengeId)
    const sessionPath = this.tldrSessionPath(challengeId)
    await mkdir(join(workspace, "tldr"), { recursive: true })
    try {
      const capability = await this.platform.bindChallenge(challengeId)
      const challenge = await capability.getInfo()
      const blackboard = injectBlackboard(this.runStore, challengeId)
      const announcements = challengeAnnouncementsPrompt(
        this.runStore.challengeAnnouncements(challengeId),
      )
      const initialMessages: AgentMessage[] = [
        {
          role: "user",
          content: challengeContextPrompt(
            challenge,
            challenge.attachments.map((attachment) => ({
              id: attachment.id,
              name: attachment.name,
              size: attachment.size ?? 0,
              path: challengeAttachmentPath(attachment.name).replace(/^\/workspace\//, ""),
            })),
          ),
          timestamp: Date.now(),
        },
        ...(blackboard
          ? [
              {
                role: "user" as const,
                content: blackboard,
                timestamp: Date.now(),
              },
            ]
          : []),
        { role: "user", content: announcements, timestamp: Date.now() },
      ]
      const existing = this.runStore.tldr(challengeId)
      if (existing?.content) {
        initialMessages.push({
          role: "user",
          content: `<existing_tldr>${existing.content}</existing_tldr>`,
          timestamp: Date.now(),
        })
      }
      const tldr = await CtfTldrAgent.create({
        projectId: this.config.project.id,
        challenge,
        sessionPath,
        agent,
        tools: createTldrWorkspaceTools(workspace),
        initialMessages,
      })
      const unsubscribeUsage = tldr.subscribe((event) => {
        if (!this.tokenUsageEnabled()) return
        const auxiliary = auxiliaryTokenUsage(event)
        if (!auxiliary) return
        try {
          this.runStore.recordModelTokenUsage({
            source: `tldr-${auxiliary.source}`,
            sourceId: `${challengeId}:${auxiliary.entryId}`,
            provider: tldr.model.provider,
            model: tldr.model.id,
            inputTokens: auxiliary.usage.input,
            outputTokens: auxiliary.usage.output,
            cacheReadTokens: auxiliary.usage.cacheRead,
            cacheWriteTokens: auxiliary.usage.cacheWrite,
          })
        } catch (error) {
          this.recordDiagnostic("telemetry", error)
        }
      })
      try {
        const response = await tldr.prompt(
          "Generate a current concise TLDR from the supplied challenge data and read-only workspace inspection. Update the existing summary when present.",
        )
        if (this.tokenUsageEnabled()) {
          try {
            this.runStore.recordModelTokenUsage({
              source: "tldr",
              sourceId: `${challengeId}:${response.timestamp}`,
              provider: model.provider,
              model: model.id,
              inputTokens: response.usage.input,
              outputTokens: response.usage.output,
              cacheReadTokens: response.usage.cacheRead,
              cacheWriteTokens: response.usage.cacheWrite,
            })
          } catch (error) {
            this.recordDiagnostic("telemetry", error)
          }
        }
        const text = extractAssistantText(response)
        if (!text) throw new Error("TLDR Agent returned no summary")
        return this.runStore.upsertTldr({
          challengeId,
          content: text,
          model: model.id,
          sessionPath,
          error: null,
          inputTokens: response.usage.input,
          cacheReadTokens: response.usage.cacheRead,
          cacheWriteTokens: response.usage.cacheWrite,
        })
      } finally {
        unsubscribeUsage()
        await tldr.close()
      }
    } catch (error) {
      return this.runStore.upsertTldr({
        challengeId,
        model: model.id,
        sessionPath,
        error: errorText(error),
      })
    }
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

  challengeWorkspaceFiles(challengeId: string): Promise<WorkspaceArtifactListing> {
    return listWorkspaceArtifacts(challengeWorkspacePath(this.agentDirectory, challengeId))
  }

  challengeWorkspaceFile(challengeId: string, artifactPath: string): Promise<Uint8Array> {
    return readWorkspaceArtifact(
      challengeWorkspacePath(this.agentDirectory, challengeId),
      artifactPath,
    )
  }

  async refresh(): Promise<ContestOverview> {
    if (this.localOnly) throw new Error("比赛平台当前不可用")
    const overview = await this.platform.refresh()
    this.runStore.cachePlatformView("overview", overview)
    return overview
  }
  async overview(): Promise<ContestOverview> {
    if (this.localOnly) {
      return (
        this.runStore.platformViewCache().overview ?? {
          id: this.config.project.id,
          name: this.config.project.name,
          challenges: this.localChallenges().length,
          announcements: this.runStore.platformViewCache().announcements?.length ?? 0,
        }
      )
    }
    const overview = await this.platform.getOverview()
    this.runStore.cachePlatformView("overview", overview)
    return overview
  }
  async challenges(): Promise<ChallengeSummary[]> {
    if (this.localOnly) return this.localChallenges()
    const challenges = (await this.platform.listChallenges()).map((challenge) => ({
      ...challenge,
      ...this.challengeSchedulingHints.get(challenge.id),
    }))
    this.runStore.cachePlatformView("challenges", challenges)
    return challenges
  }
  async challengeSchedulingHint(
    challengeId: string,
  ): Promise<{ needsEnv: boolean; hasAttachments: boolean }> {
    const cached = this.challengeSchedulingHints.get(challengeId)
    if (cached) return cached
    if (this.localOnly) throw new Error("比赛平台当前不可用")
    const capability = await this.platform.bindChallenge(challengeId)
    const challenge = await capability.getInfo()
    const hint = {
      needsEnv: challenge.needsEnv === true || capability.instance !== undefined,
      hasAttachments: challenge.attachments.length > 0,
    }
    this.challengeSchedulingHints.set(challengeId, hint)
    return hint
  }
  async announcements(): Promise<Announcement[]> {
    if (this.localOnly) return this.runStore.platformViewCache().announcements ?? []
    const announcements = await this.platform.listAnnouncements()
    this.runStore.cachePlatformView("announcements", announcements)
    return announcements
  }
  async syncAnnouncements(options: { steerActive?: boolean } = {}): Promise<{
    announcements: number
    linked: number
    steered: number
  }> {
    const [announcements, challenges] = await Promise.all([this.announcements(), this.challenges()])
    let linked = 0
    let steered = 0
    for (const announcement of announcements) {
      const classification = classifyAnnouncement(announcement)
      const keywordFilter = filterAnnouncementKeywords(announcement)
      const revision = announcementRevision(announcement)
      const ignored = classification.ignored || !keywordFilter.eligible
      this.runStore.persistContestAnnouncement({
        key: revision.key,
        platformAnnouncementId: announcement.id,
        revisionHash: revision.revisionHash,
        title: announcement.title,
        content: announcement.content,
        publishedAt: announcement.publishedAt,
        kind: classification.kind,
        classificationReason: classification.ignored ? classification.reason : keywordFilter.reason,
        ignored,
      })
      if (ignored) continue
      for (const match of matchAnnouncementChallenges(announcement, challenges)) {
        const created = this.runStore.linkChallengeAnnouncement({
          challengeId: match.challengeId,
          announcementKey: revision.key,
          matchType: match.matchType,
          matchedValue: match.matchedValue,
          matchedKeywords: keywordFilter.matchedKeywords,
        })
        if (created) linked += 1
        if (options.steerActive === false) continue
        const candidate = this.runStore
          .announcementCandidates()
          .find((item) => item.challengeId === match.challengeId && item.key === revision.key)
        if (candidate?.approvalStatus === "approved") {
          steered += await this.deliverAnnouncement(candidate)
        }
      }
    }
    return { announcements: announcements.length, linked, steered }
  }
  announcementCandidates(): ChallengeAnnouncementRecord[] {
    return this.runStore.announcementCandidates()
  }
  async reviewChallengeAnnouncement(
    challengeId: string,
    announcementKey: string,
    status: Exclude<AnnouncementApprovalStatus, "pending">,
  ): Promise<ChallengeAnnouncementRecord> {
    if (
      !this.runStore
        .announcementCandidates()
        .some(
          (candidate) => candidate.challengeId === challengeId && candidate.key === announcementKey,
        )
    ) {
      throw announcementCandidateNotFound(challengeId, announcementKey)
    }
    const reviewed = this.runStore.reviewChallengeAnnouncement({
      challengeId,
      announcementKey,
      status,
    })
    if (status === "approved") await this.deliverAnnouncement(reviewed)
    return reviewed
  }

  private async deliverAnnouncement(announcement: ChallengeAnnouncementRecord): Promise<number> {
    const message = challengeAnnouncementsPrompt([announcement])
    let delivered = 0
    for (const solver of this.solvers) {
      if (solver.challenge.id !== announcement.challengeId || solver.isClosed) {
        continue
      }
      const queued = this.runStore.enqueueAnnouncementDelivery({
        challengeId: announcement.challengeId,
        announcementKey: announcement.key,
        runId: solver.runId,
      })
      if (!queued) continue
      try {
        await solver.promptOrSteer(message)
        this.runStore.observeAnnouncementDelivery({
          challengeId: announcement.challengeId,
          announcementKey: announcement.key,
          runId: solver.runId,
          status: "delivered",
        })
        this.runStore.appendEvent(solver.runId, "announcement_steered", {
          announcementKey: announcement.key,
          matchType: announcement.matchType,
        })
        delivered += 1
      } catch (error) {
        this.runStore.observeAnnouncementDelivery({
          challengeId: announcement.challengeId,
          announcementKey: announcement.key,
          runId: solver.runId,
          status: "failed",
          error: errorText(error),
        })
      }
    }
    return delivered
  }
  availableSkills(): readonly AgentSkill[] {
    return this.skills
  }
  async environments(): Promise<RemoteEnvironment[]> {
    if (this.localOnly) return this.runStore.platformViewCache().environments ?? []
    const environments = await this.platform.listRemoteEnvironments()
    this.remoteEnvironments.observePlatformEnvironments(environments)
    this.runStore.cachePlatformView("environments", environments)
    return environments
  }
  async destroyEnvironment(id: string): Promise<void> {
    if (await this.remoteEnvironments.destroyEnvironment(id)) return
    await this.platform.destroyRemoteEnvironment(id)
  }
  async setMaxRemoteEnvironments(maxConcurrent: number): Promise<void> {
    await this.remoteEnvironments.setMaxConcurrent(maxConcurrent)
  }
  remoteEnvironmentCapacity() {
    return this.remoteEnvironments.capacity()
  }
  remoteEnvironmentSnapshot() {
    return this.remoteEnvironments.snapshot()
  }
  subscribeRemoteEnvironmentCapacity(listener: () => void): () => void {
    return this.remoteEnvironments.subscribeCapacity(listener)
  }
  isWaitingForRemoteEnvironment(runId: string): boolean {
    return this.remoteEnvironments.isWaiting(runId)
  }
  runs(filter: RunFilter = {}): RunRecord[] {
    return this.runStore.listRuns(filter)
  }

  tokenUsage() {
    return this.runStore.modelTokenUsage()
  }

  cachedPlatformView(): PlatformViewCache {
    return this.runStore.platformViewCache()
  }

  private localChallenges(): ChallengeSummary[] {
    const cached = this.runStore.platformViewCache().challenges ?? []
    const cachedIds = new Set(cached.map((challenge) => challenge.id))
    const challengeIds = new Set([
      ...this.runStore.listRuns().map((run) => run.challengeId),
      ...this.runStore.getBlackboardStats().map((stats) => stats.challengeId),
      ...this.runStore.schedulerQueue().map((item) => item.challengeId),
      ...this.runStore.challengeSchedulingOverrides().map((item) => item.challengeId),
    ])
    const localOnly = [...challengeIds]
      .filter((challengeId) => !cachedIds.has(challengeId))
      .map((challengeId) => ({
        id: challengeId,
        title: challengeId,
        category: "本地记录",
        score: 0,
        solved: this.runStore.listRuns({ challengeId }).some((run) => run.status === "solved"),
      }))
    return [...cached, ...localOnly]
  }
  runEvents(runId: string): RunEvent[] {
    return this.runStore.events(runId)
  }
  latestRunEvent(runId: string): RunEvent | undefined {
    return this.runStore.latestEvent(runId)
  }
  recentRunEvents(limit = 80): RunEvent[] {
    return this.runStore.recentEvents(limit)
  }
  appendRunEvent(runId: string, type: string, data?: unknown): RunEvent {
    return this.runStore.appendEvent(runId, type, data)
  }
  subagents(runId: string): SubagentRecord[] {
    return this.runStore.subagents(runId)
  }
  compactRecoveryPrompt(challengeId: string, runId: string): string {
    const challengeContext = this.runChallengeContexts.get(runId)
    if (!challengeContext) {
      throw new Error(`Run ${runId} 缺少 compact 恢复所需的题目上下文`)
    }
    const blackboard = injectBlackboard(this.runStore, challengeId)
    const subagents = this.subagentManagers.get(runId)?.list() ?? this.runStore.subagents(runId)
    const announcements = this.runStore.challengeAnnouncements(challengeId)
    const environment = this.remoteEnvironments.environmentForRun(runId)
    return [
      challengeContext,
      ...(environment
        ? [
            `<remote_environment_state encoding="json">${escapeXml(JSON.stringify(environment))}</remote_environment_state>`,
          ]
        : []),
      ...(blackboard ? [blackboard] : []),
      challengeAnnouncementsPrompt(announcements),
      activeSubagentsPrompt(subagents),
    ].join("\n\n")
  }
  availableSubagents(): SubagentRole[] {
    return [...this.configuredSubagentRoles().values()].filter((role) => role.enabled)
  }
  async steerSubagent(runId: string, subagentId: string, message: string): Promise<SubagentRecord> {
    const manager = this.subagentManagers.get(runId)
    if (!manager) throw subagentUnavailable(runId)
    return manager.steer(subagentId, message)
  }
  async cancelSubagent(runId: string, subagentId: string): Promise<SubagentRecord> {
    const manager = this.subagentManagers.get(runId)
    if (!manager) throw subagentUnavailable(runId)
    return manager.cancel(subagentId)
  }
  isChallengeSolved(challengeId: string): boolean {
    return (
      this.runStore.isSolved(challengeId) ||
      this.runStore.challengeSchedulingDisposition(challengeId) === "solved"
    )
  }
  isChallengeSchedulingExcluded(challengeId: string): boolean {
    return this.runStore.challengeSchedulingDisposition(challengeId) === "excluded"
  }
  challengeSchedulingDisposition(challengeId: string) {
    return this.runStore.challengeSchedulingDisposition(challengeId)
  }
  setChallengeSchedulingDisposition(
    challengeId: string,
    disposition: ChallengeSchedulingDisposition | null,
  ) {
    return this.runStore.setChallengeSchedulingDisposition(challengeId, disposition)
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
  forceChallengeBlocked(input: Parameters<RunStore["forceChallengeBlocked"]>[0]): void {
    this.runStore.forceChallengeBlocked(input)
  }
  resetSessionInterruptions(challengeId: string): void {
    this.runStore.resetSessionInterruptions(challengeId)
  }
  /** 完全重置单题：清空 RunStore 中该题全部状态，并删除 Run session 目录与题目 workspace。 */
  async resetChallenge(challengeId: string): Promise<void> {
    if (this.closed) throw new Error("Project 已关闭")
    // 防御性关闭该题仍在内存中的 solver（调度路径已关则幂等返回；
    // 兜底 ContestRunner 等不经过 scheduler 的活跃 solver 边角场景）
    for (const solver of this.solvers) {
      if (solver.challenge.id === challengeId && !solver.isClosed) {
        await solver.close("cancelled", "重置题目：运行已停止").catch(() => undefined)
      }
    }
    // 等在途 TLDR 刷新结束，防止 wipe 后它重新 upsert challenge_tldr
    const inFlightTldr = this.tldrRefreshes.get(challengeId)
    if (inFlightTldr) await inFlightTldr.catch(() => undefined)
    const runs = this.runStore.listRuns({ challengeId })
    // 回收该题 Run 的托管 sandbox 容器（含进程崩溃后遗留的孤儿容器）；已随 solver 关闭的
    // 容器按标签查不到，幂等跳过。
    if (this.removeManagedSandboxes) {
      await this.removeManagedSandboxes(runs.map((run) => run.id))
    }
    const workspace = challengeWorkspacePath(this.agentDirectory, challengeId)
    const workspaceMount = this.workspaceMount?.({
      runId: runs[0]?.id ?? `reset-${challengeWorkspaceKey(challengeId)}`,
      workspace,
      relativeWorkspace: this.relativeWorkspace(challengeId),
    }) ?? { type: "bind" as const, source: workspace }
    if (workspaceMount.type === "bind") await mkdir(workspace, { recursive: true })
    await this.clearWorkspace({
      image: this.config.sandbox.image,
      workspace,
      workspaceMount,
    })
    const deletedRuns = this.runStore.resetChallenge(challengeId)
    if (deletedRuns.length !== runs.length) {
      throw new Error(`重置题目期间 Run 状态发生变化: ${challengeId}`)
    }
    await Promise.all(
      deletedRuns.map((run) =>
        rm(join(this.agentDirectory, "runs", run.id), { recursive: true, force: true }),
      ),
    )
    for (const run of deletedRuns) {
      this.subagentManagers.delete(run.id)
      this.runChallengeContexts.delete(run.id)
      for (const key of this.agentStreamSequences.keys()) {
        if (key.startsWith(`${run.id} `)) this.agentStreamSequences.delete(key)
      }
      for (const key of this.activeStreamMessages.keys()) {
        if (key.startsWith(`${run.id} `)) this.activeStreamMessages.delete(key)
      }
      for (const key of this.activeStreamSnapshots.keys()) {
        if (key.startsWith(`${run.id} `)) this.activeStreamSnapshots.delete(key)
      }
    }
    this.tldrRefreshes.delete(challengeId)
    this.challengeSchedulingHints.delete(challengeId)
  }
  schedulerState(): SchedulerStateRecord {
    return this.runStore.schedulerState()
  }
  setSchedulerMode(mode: SchedulerMode): SchedulerStateRecord {
    return this.runStore.setSchedulerMode(mode)
  }
  startScheduler(mode: Exclude<SchedulerMode, "stopped">): SchedulerStateRecord {
    return this.runStore.startScheduler(mode)
  }
  schedulerQueue(stage?: SchedulerQueueStage): SchedulerQueueRecord[] {
    return this.runStore.schedulerQueue(stage)
  }
  enqueueSchedulerChallenge(input: EnqueueSchedulerChallenge): SchedulerQueueRecord {
    return this.runStore.enqueueSchedulerChallenge(input)
  }
  enqueueSchedulerChallenges(inputs: readonly EnqueueSchedulerChallenge[]): SchedulerQueueRecord[] {
    return this.runStore.enqueueSchedulerChallenges(inputs)
  }
  reorderSchedulerStage(
    stage: SchedulerQueueStage,
    challengeIds: readonly string[],
    expectedVersion: number,
  ): SchedulerQueueRecord[] {
    return this.runStore.reorderSchedulerStage(stage, challengeIds, expectedVersion)
  }
  moveSchedulerChallenge(input: MoveSchedulerChallenge): SchedulerQueueRecord {
    return this.runStore.moveSchedulerChallenge(input)
  }
  removeSchedulerChallenge(challengeId: string): boolean {
    return this.runStore.removeSchedulerChallenge(challengeId)
  }
  removeSchedulerChallenges(challengeIds: readonly string[], stage?: SchedulerQueueStage): number {
    return this.runStore.removeSchedulerChallenges(challengeIds, stage)
  }
  reviveChallenge(challengeId: string) {
    return this.runStore.reviveChallenge(challengeId)
  }
  challengeRuntimeState(challengeId: string) {
    return this.runStore.challengeRuntimeState(challengeId)
  }
  recordChallengeBlockEvent(input: Parameters<RunStore["recordChallengeBlockEvent"]>[0]) {
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
    return manager.finalize(reportPrompt, graceMs)
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
  async sendMessage(challengeId: string, text: string): Promise<{ runId: string }> {
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
  async setThinkingLevel(challengeId: string, level: ThinkingLevel): Promise<{ runId: string }> {
    if (!isThinkingLevel(level)) {
      throw Object.assign(new Error("不支持的思考强度"), {
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

  async createSolver(challengeId: string, options: CreateSolverOptions): Promise<CtfSolverAgent> {
    return this.createSolverForRun(challengeId, options)
  }

  /** Reopen a terminal Solver on its original Run/workspace/Pi JSONL session. */
  async resumeSolver(
    runId: string,
    options: Omit<CreateSolverOptions, "attempt" | "source">,
  ): Promise<CtfSolverAgent> {
    const run = this.runStore.getRun(runId)
    if (
      !run ||
      !["failed", "timed_out", "cancelled", "closed", "interrupted", "blocked"].includes(run.status)
    ) {
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
    const workspace = resumed?.workspace ?? challengeWorkspacePath(this.agentDirectory, challengeId)
    const attempt = resumed?.attempt ?? options.attempt ?? this.runStore.nextAttempt(challengeId)
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
        attempt,
        source: options.source ?? "direct",
      })
      await this.persistRecord(record, runDirectory)
    }

    let capability: Awaited<ReturnType<PlatformProject["bindChallenge"]>> | undefined
    let sandbox: Sandbox | undefined
    let subagentManager: CtfSubagentManager | undefined
    // 提升到 try 之外，使创建失败路径的 catch 也能回收会话（闭包经 onBeforeCleanup 使用）。
    let shellpoopSession: ShellPoopSession | undefined
    try {
      capability = await this.platform.bindChallenge(challengeId)
      const challenge = await capability.getInfo()
      this.challengeSchedulingHints.set(challengeId, {
        needsEnv: challenge.needsEnv === true || capability.instance !== undefined,
        hasAttachments: challenge.attachments.length > 0,
      })
      let solver!: CtfSolverAgent
      capability = this.remoteEnvironments.manage({
        runId,
        challenge,
        capability,
        executionGate: options.executionGate,
        onEvent: (type, data) => {
          try {
            this.runStore.appendEvent(runId, type, data)
          } catch (error) {
            this.recordDiagnostic("environment", error, runId)
          }
        },
        onRevoked: async (message) => {
          const update = `<remote_environment_update>${escapeXml(message)}</remote_environment_update>`
          await Promise.allSettled([
            ...(!solver || solver.isClosed ? [] : [solver.promptOrSteer(update)]),
            ...(subagentManager ? [subagentManager.broadcast(update)] : []),
          ])
        },
      })

      const blackboardInject = injectBlackboard(this.runStore, challengeId)
      const blackboardMessages: AgentMessage[] =
        !resumed && blackboardInject
          ? [{ role: "user", content: blackboardInject, timestamp: Date.now() }]
          : []
      const persistedAnnouncements = this.runStore.challengeAnnouncements(challengeId)
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
          relativeWorkspace: this.relativeWorkspace(challengeId),
        }),
        privileged: this.config.sandbox.privileged,
        networkMode: solverSandboxNetworkMode(this.platform, this.config.sandbox.networkMode),
      })
      const downloadedAttachments = await downloadChallengeAttachments({
        capability,
        attachments: challenge.attachments,
        sandbox,
      })
      const challengeContext = challengeContextPrompt(challenge, downloadedAttachments)
      this.runChallengeContexts.set(runId, challengeContext)
      const challengeMessages: AgentMessage[] = resumed
        ? []
        : [
            {
              role: "user",
              content: challengeContext,
              timestamp: Date.now(),
            },
          ]

      // web-access 工具（搜索/fetch/source-check），默认关闭；host 通过
      // webAccessConfig 工厂提供 allowlist + 密钥 + 模型解析器。
      const webAccessSignal = new AbortController()
      let webAccessTools: AgentTool[] = []
      if (this.webAccessConfig) {
        const config = await this.webAccessConfig(workspace, webAccessSignal.signal)
        if (config) webAccessTools = createWebAccessTools(config)
      }

      // ShellPoop 反弹 shell 工具，默认关闭；host 通过 shellpoopConfig 工厂提供
      // 服务地址、超时与所属 challenge。每个 run 一个独立会话：只记录并允许
      // 操作本 run 创建的 shell（challenge 间隔离）；run 结束时 abort 取消
      // 进行中的请求，并调用会话 close() 删除本 run 全部 shell 以释放端口。
      const shellpoopSignal = new AbortController()
      let shellpoopTools: AgentTool[] = []
      shellpoopSession = undefined
      if (this.shellpoopConfig) {
        const config = await this.shellpoopConfig(shellpoopSignal.signal, { challengeId, runId })
        if (config) {
          const session = createShellPoopSession(config)
          shellpoopSession = session
          shellpoopTools = session.tools
        }
      }

      subagentManager = new CtfSubagentManager({
        projectId: this.config.project.id,
        runId,
        runDirectory,
        challenge,
        capability,
        sandbox,
        agent: options.agent,
        roles: this.configuredSubagentRoles(),
        skills,
        webAccessTools,
        shellpoopTools,
        blackboardReadTool: createBlackboardReadTool({ runStore: this.runStore, challengeId }),
        maxConcurrent: this.subagentRuntime.maxConcurrent,
        onAgentEvent: (subagent, event, model) => {
          this.publishAgentEvent(runId, subagent.id, event)
          if (model) this.recordAuxiliaryTokenUsage(runId, "subagent", event, model)
          if (
            this.tokenUsageEnabled() &&
            event.type === "message_end" &&
            event.message.role === "assistant"
          ) {
            const { message } = event
            try {
              this.runStore.recordModelTokenUsage({
                source: "subagent",
                sourceId: `${runId}:${subagent.id}:${message.timestamp}`,
                provider: message.provider,
                model: message.model,
                inputTokens: message.usage.input,
                outputTokens: message.usage.output,
                cacheReadTokens: message.usage.cacheRead,
                cacheWriteTokens: message.usage.cacheWrite,
              })
            } catch (error) {
              this.recordDiagnostic("telemetry", error, runId)
            }
          }
        },
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
              inputTokens: subagent.inputTokens ?? 0,
              cacheReadTokens: subagent.cacheReadTokens ?? 0,
              cacheWriteTokens: subagent.cacheWriteTokens ?? 0,
            })
          } catch (error) {
            this.recordDiagnostic("telemetry", error, runId)
          }
        },
      })
      if (resumed) subagentManager.restore(this.runStore.subagents(runId))

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
              ...webAccessTools,
              ...shellpoopTools,
              ...createBlackboardTools({
                runStore: this.runStore,
                challengeId,
                runId,
              }),
              ...createSubagentManagerTools(subagentManager),
            ],
            systemPrompt: [options.agent.initialState?.systemPrompt].filter(Boolean).join("\n\n"),
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
        onTerminalSubmission: () => subagentManager?.close(),
        onBeforeCleanup: async () => {
          webAccessSignal.abort()
          shellpoopSignal.abort()
          // 会话 close() 尽力删除本 run 创建的 shell（内部 DELETE 不受刚 abort
          // 的信号影响），随后回收 SubAgent。抛错由 performClose 记为 cleanupError。
          await shellpoopSession?.close()
          return subagentManager?.close()
        },
        onClosed: async (details) => {
          this.solvers.delete(solver)
          this.subagentManagers.delete(runId)
          this.runChallengeContexts.delete(runId)
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
                details.cleanupErrors.length > 0 ? details.cleanupErrors.join("\n") : null,
              finishedAt: new Date().toISOString(),
            },
            eventType,
            details,
          )
          await this.persistRecord(updated, runDirectory)
        },
      })
      subagentManager.attachParent(solver)
      const telemetryCalls = new Map<string, { toolName: string; args: unknown }>()
      // pi 在 message_end 中提供完整的 thinking block。按 turn 持久化一条，避免
      // reasoning token 逐片写入 SQLite，导致事件表/WAL 和 Dashboard 查询爆炸。
      solver.subscribe((event) => {
        this.publishAgentEvent(runId, undefined, event)
        this.recordAuxiliaryTokenUsage(runId, "solver", event, solver.model)
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
            this.runStore.appendEvent(
              runId,
              "agent_usage",
              {
                source: "solver",
                provider: event.message.provider,
                model: event.message.model,
                input: usage.input,
                output: usage.output,
                cacheRead: usage.cacheRead,
                cacheWrite: usage.cacheWrite,
                ...(usage.reasoning === undefined ? {} : { reasoning: usage.reasoning }),
                totalTokens: usage.totalTokens,
                cost: usage.cost,
                ts: new Date().toISOString(),
              },
              { recordModelTokenUsage: this.tokenUsageEnabled() },
            )
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
      await this.persistSessionExportMetadata(solver, runDirectory)
      this.solvers.add(solver)
      this.subagentManagers.set(runId, subagentManager)
      return solver
    } catch (error) {
      this.runChallengeContexts.delete(runId)
      const cleanupErrors: string[] = []
      if (subagentManager) {
        try {
          await subagentManager.close()
        } catch (cleanupError) {
          cleanupErrors.push(`SubAgent 回收失败: ${errorText(cleanupError)}`)
        }
      }
      if (shellpoopSession) {
        try {
          await shellpoopSession.close()
        } catch (cleanupError) {
          cleanupErrors.push(`ShellPoop 回收失败: ${errorText(cleanupError)}`)
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
      const failures: unknown[] = [error, ...cleanupErrors.map((message) => new Error(message))]
      const attachmentFailure = error instanceof ChallengeAttachmentError
      const blockImmediately = !resumed && attempt === 1 && !attachmentFailure
      const retryable = attachmentFailure
        ? !resumed && attempt === 1
        : !blockImmediately && isRetryablePlatformError(error)
      try {
        if (blockImmediately) {
          this.runStore.forceChallengeBlocked({ challengeId, runId })
        }
        const updated = this.runStore.updateRun(
          runId,
          {
            status: blockImmediately ? "blocked" : "failed",
            closeReason: blockImmediately ? "blocked" : "failed",
            error: errorText(error),
            cleanupError: cleanupErrors.length > 0 ? cleanupErrors.join("\n") : null,
            finishedAt: new Date().toISOString(),
          },
          blockImmediately ? "run_creation_blocked" : "run_creation_failed",
          {
            error: errorText(error),
            cleanupErrors,
            retryable,
            attachmentFailure,
          },
        )
        await this.persistRecord(updated, runDirectory)
      } catch (persistenceError) {
        failures.push(persistenceError)
      }
      const cause =
        failures.length > 1 ? new AggregateError(failures, `无法创建 Solver ${runId}`) : error
      throw new SolverCreationError(runId, attachmentFailure, blockImmediately, retryable, cause)
    }
  }

  private relativeWorkspace(challengeId: string): string {
    const relative = `challenges/${challengeWorkspaceKey(challengeId)}/workspace`
    return this.workspaceNamespace ? `${this.workspaceNamespace}/${relative}` : relative
  }

  private configuredSubagentRoles(): ReadonlyMap<string, SubagentRole> {
    if (!this.subagentRuntime.modelForRole) return this.subagentRoles
    return new Map(
      [...this.subagentRoles].map(([name, role]) => {
        const model = this.subagentRuntime.modelForRole?.(name)
        return [name, model ? { ...role, model } : role]
      }),
    )
  }

  private recordAuxiliaryTokenUsage(
    runId: string,
    actor: "solver" | "subagent",
    event: AgentHarnessEvent,
    model: { provider: string; id: string },
  ): void {
    if (!this.tokenUsageEnabled()) return
    const auxiliary = auxiliaryTokenUsage(event)
    if (!auxiliary) return
    try {
      if (actor === "subagent") {
        this.runStore.recordModelTokenUsage({
          source: `subagent-${auxiliary.source}`,
          sourceId: `${runId}:${auxiliary.entryId}`,
          provider: model.provider,
          model: model.id,
          inputTokens: auxiliary.usage.input,
          outputTokens: auxiliary.usage.output,
          cacheReadTokens: auxiliary.usage.cacheRead,
          cacheWriteTokens: auxiliary.usage.cacheWrite,
        })
        return
      }
      this.runStore.appendEvent(runId, "agent_usage", {
        source: `solver-${auxiliary.source}`,
        provider: model.provider,
        model: model.id,
        input: auxiliary.usage.input,
        output: auxiliary.usage.output,
        cacheRead: auxiliary.usage.cacheRead,
        cacheWrite: auxiliary.usage.cacheWrite,
        totalTokens: auxiliary.usage.totalTokens,
        cost: auxiliary.usage.cost,
        ts: new Date().toISOString(),
      })
    } catch (error) {
      this.recordDiagnostic("telemetry", error, runId)
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.agentStreamListeners.clear()
    this.agentStreamSequences.clear()
    this.activeStreamMessages.clear()
    this.activeStreamSnapshots.clear()
    const errors: unknown[] = []
    const solverResults = await Promise.allSettled(
      [...this.solvers].map((solver) => solver.close("manual")),
    )
    for (const result of solverResults) if (result.status === "rejected") errors.push(result.reason)
    try {
      await this.remoteEnvironments.close()
    } catch (error) {
      errors.push(error)
    }
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
    if (errors.length > 0) throw new AggregateError(errors, "Project 关闭时发生错误")
  }

  private publishAgentEvent(
    runId: string,
    subagentId: string | undefined,
    event: AgentHarnessEvent,
  ): void {
    const key = `${runId}\u0000${subagentId ?? "solver"}`
    const messageId = (): string => {
      const current = this.activeStreamMessages.get(key)
      if (current) return current
      const next = `${key}:${(this.agentStreamSequences.get(key) ?? 0) + 1}`
      this.activeStreamMessages.set(key, next)
      return next
    }
    let payload: AgentStreamPayload | undefined

    if (event.type === "agent_start") payload = { type: "agent_started" }
    else if (event.type === "agent_end") payload = { type: "agent_finished" }
    else if (event.type === "message_start") {
      const id = messageId()
      this.activeStreamSnapshots.set(key, {
        messageId: id,
        message: structuredClone(event.message),
      })
      payload = {
        type: "message_started",
        messageId: id,
        message: event.message,
      }
    } else if (event.type === "message_update") {
      const id = messageId()
      const current = this.activeStreamSnapshots.get(key)
      const update = event.assistantMessageEvent
      const message =
        current && (update.type === "text_delta" || update.type === "thinking_delta")
          ? appendAgentMessageDelta(
              current.message,
              update.contentIndex,
              update.type === "text_delta" ? "text" : "thinking",
              update.delta,
            )
          : structuredClone(event.message)
      this.activeStreamSnapshots.set(key, {
        messageId: id,
        message,
      })
      if (update.type === "text_delta") {
        payload = {
          type: "text_delta",
          messageId: id,
          contentIndex: update.contentIndex,
          delta: update.delta,
        }
      } else if (update.type === "thinking_delta") {
        payload = {
          type: "thinking_delta",
          messageId: id,
          contentIndex: update.contentIndex,
          delta: update.delta,
        }
      } else if (update.type === "toolcall_end") {
        payload = {
          type: "message_updated",
          messageId: id,
          message: event.message,
        }
      }
    } else if (event.type === "message_end") {
      payload = {
        type: "message_completed",
        messageId: messageId(),
        message: event.message,
      }
      this.activeStreamMessages.delete(key)
      this.activeStreamSnapshots.delete(key)
    } else if (event.type === "tool_execution_start") {
      payload = {
        type: "tool_started",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: tracedToolArgs(event.toolName, event.args, this.telemetry),
      }
    } else if (event.type === "tool_execution_update") {
      payload = {
        type: "tool_updated",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        partialResult: tracedValue(event.partialResult, this.telemetry.maxTextLength),
      }
    } else if (event.type === "tool_execution_end") {
      payload = {
        type: "tool_completed",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        result: tracedValue(event.result, this.telemetry.maxTextLength),
        isError: event.isError,
      }
    } else if (event.type === "queue_update") {
      payload = {
        type: "queue_updated",
        queued: event.steer.length + event.followUp.length + event.nextTurn.length,
      }
    } else if (event.type === "session_before_compact") {
      payload = { type: "status_changed", status: "compacting" }
    } else if (event.type === "session_compact") {
      payload = { type: "status_changed", status: "active" }
    } else if (event.type === "retry_scheduled") {
      payload = {
        type: "status_changed",
        status: "retrying",
        detail: `${Math.ceil(event.delayMs / 1_000)} 秒后重试 ${event.attempt}/${event.maxAttempts}`,
      }
    }
    if (!payload) return

    const seq = (this.agentStreamSequences.get(key) ?? 0) + 1
    this.agentStreamSequences.set(key, seq)
    const envelope = {
      ...payload,
      runId,
      ...(subagentId ? { subagentId } : {}),
      seq,
      createdAt: new Date().toISOString(),
    } as AgentStreamEvent
    for (const subscription of this.agentStreamListeners) {
      if (subscription.target.runId !== runId || subscription.target.subagentId !== subagentId)
        continue
      try {
        subscription.listener(envelope)
      } catch {
        // WebUI 订阅是旁路投影，不得影响 Solver。
      }
    }
  }

  private async persistRecord(record: RunRecord, runDirectory: string): Promise<void> {
    const target = join(runDirectory, "run.json")
    const temporary = `${target}.tmp-${process.pid}`
    await writeFile(temporary, JSON.stringify(record, null, 2))
    await rename(temporary, target)
  }

  private async persistSessionExportMetadata(
    solver: CtfSolverAgent,
    runDirectory: string,
  ): Promise<void> {
    const target = join(runDirectory, "session-export-metadata.json")
    const temporary = `${target}.tmp-${process.pid}`
    await writeFile(temporary, JSON.stringify(solverExportMetadata(solver), null, 2))
    await rename(temporary, target)
  }

  private recordDiagnostic(code: ProjectDiagnostic["code"], error: unknown, runId?: string): void {
    if (this.diagnosticLog.length >= 100) this.diagnosticLog.shift()
    this.diagnosticLog.push({
      code,
      message: errorText(error),
      createdAt: new Date().toISOString(),
      ...(runId ? { runId } : {}),
    })
  }
}

function solverExportMetadata(solver: CtfSolverAgent): RunSessionExportMetadata {
  return {
    systemPrompt: solver.state.systemPrompt,
    tools: solver.tools.map(({ name, description, parameters }) => ({
      name,
      ...(description ? { description } : {}),
      ...(parameters === undefined ? {} : { parameters }),
    })),
  }
}

function parseSessionExportMetadata(value: unknown): RunSessionExportMetadata | undefined {
  if (!value || typeof value !== "object") return undefined
  const candidate = value as {
    systemPrompt?: unknown
    tools?: unknown
  }
  if (typeof candidate.systemPrompt !== "string" || !Array.isArray(candidate.tools))
    return undefined
  const tools = candidate.tools.flatMap((tool) => {
    if (!tool || typeof tool !== "object") return []
    const candidateTool = tool as {
      name?: unknown
      description?: unknown
      parameters?: unknown
    }
    if (typeof candidateTool.name !== "string") return []
    return [
      {
        name: candidateTool.name,
        ...(typeof candidateTool.description === "string"
          ? { description: candidateTool.description }
          : {}),
        ...(candidateTool.parameters === undefined ? {} : { parameters: candidateTool.parameters }),
      },
    ]
  })
  return { systemPrompt: candidate.systemPrompt, tools }
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

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

/** 该题无活跃 solver 的错误契约:webui server 层按 code 映射 409(跨包不依赖错误类型)。 */
function noActiveRunError(): Error {
  return Object.assign(new Error("该题当前没有运行中的 Agent"), {
    code: "no_active_run",
  })
}

function subagentUnavailable(runId: string): Error {
  return Object.assign(new Error(`Run ${runId} 当前没有活跃的 SubAgent manager`), {
    code: "subagent_unavailable",
  })
}

function announcementCandidateNotFound(challengeId: string, announcementKey: string): Error {
  return Object.assign(new Error(`公告候选不存在: ${challengeId}/${announcementKey}`), {
    code: "announcement_candidate_not_found",
  })
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

/** Pi 将压缩/分支摘要的供应商用量放在 session 事件中，不会产生 assistant message。 */
function auxiliaryTokenUsage(event: AgentHarnessEvent) {
  if (event.type === "session_compact" && !event.fromHook && event.compactionEntry.usage) {
    return {
      source: "compaction",
      entryId: event.compactionEntry.id,
      usage: event.compactionEntry.usage,
    }
  }
  if (event.type === "session_tree" && !event.fromHook && event.summaryEntry?.usage) {
    return {
      source: "branch-summary",
      entryId: event.summaryEntry.id,
      usage: event.summaryEntry.usage,
    }
  }
  return undefined
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
              ? clippedText(field(started?.args, "flag"), telemetry.maxTextLength)
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
  const input = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {}
  if (telemetry.level === "full") {
    return tracedValue(input, telemetry.maxTextLength, toolName === "ctf_submit_flag") as Record<
      string,
      unknown
    >
  }
  if (toolName === "ctf_submit_flag") return { flag: "[redacted]" }
  if (toolName === "bash") return { command: "[omitted]" }
  if (toolName === "write") return { path: clippedText(input.path, 240), content: "[omitted]" }
  if (toolName === "edit") return { path: clippedText(input.path, 240), edits: "[omitted]" }
  if (toolName === "blackboard_record") {
    return {
      operations: ["evidence", "opportunity", "concludeOpportunity"].filter(
        (key) => input[key] !== undefined,
      ),
    }
  }
  if (toolName === "blackboard_manage") {
    return {
      action: clippedText(input.action, 64),
      evidenceId: input.evidenceId,
      opportunityId: input.opportunityId,
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
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value
  if (Array.isArray(value)) return value.slice(0, 8).map((item) => clippedValue(item, maxLength))
  return value === undefined ? undefined : "[object]"
}

function clippedText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return ""
  return value.length <= maxLength ? value : `${value.slice(0, Math.max(0, maxLength - 3))}...`
}

function tracedValue(value: unknown, maxTextLength: number, allowFlag = false, depth = 0): unknown {
  if (typeof value === "string") return clippedText(value, maxTextLength)
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value
  if (value === undefined) return undefined
  if (depth >= 5) return "[max-depth]"
  if (Array.isArray(value)) {
    return value.slice(0, 64).map((item) => tracedValue(item, maxTextLength, allowFlag, depth + 1))
  }
  if (typeof value !== "object") return String(value as string | number | boolean | bigint)
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

function flagSubmission(value: unknown): { status?: string; message?: string } | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const result = value as Record<string, unknown>
  const details =
    typeof result.details === "object" && result.details !== null
      ? (result.details as Record<string, unknown>)
      : result
  return {
    ...(typeof details.status === "string" ? { status: details.status } : {}),
    ...(typeof details.message === "string" ? { message: details.message } : {}),
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

function unavailablePlatform(): PlatformProject {
  const unavailable = async (): Promise<never> => {
    throw new Error("比赛平台当前不可用")
  }
  return {
    refresh: unavailable,
    getOverview: unavailable,
    listChallenges: unavailable,
    listAnnouncements: unavailable,
    listRemoteEnvironments: unavailable,
    getRemoteEnvironment: unavailable,
    destroyRemoteEnvironment: unavailable,
    bindChallenge: unavailable,
    close: async () => undefined,
  }
}

function solverSandboxNetworkMode(
  platform: PlatformProject,
  configured: ProjectConfig["sandbox"]["networkMode"],
): DockerSandboxOptions["networkMode"] {
  if (platform.solverSandboxNetwork !== "control_plane") return configured
  if (configured === "none") {
    throw new Error("该平台的远程环境通过控制面本地代理访问，sandbox.networkMode 不能为 none")
  }
  const containerId = process.env.HOSTNAME
  if (containerId && /^[a-f0-9]{12,64}$/i.test(containerId) && existsSync("/.dockerenv")) {
    return `container:${containerId}`
  }
  // 控制面直接运行在 Linux 主机时，host 网络让 Solver 访问同一回环代理。
  return "host"
}

function normalizeWorkspaceNamespace(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const normalized = value.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "")
  if (
    !normalized ||
    normalized
      .split("/")
      .some(
        (segment) =>
          segment === "." || segment === ".." || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(segment),
      )
  ) {
    throw new Error("workspaceNamespace 必须是安全的相对路径")
  }
  return normalized
}
