import type {
  AgentStreamListener,
  AgentStreamTarget,
  Announcement,
  BlackboardStats,
  BlackboardSummary,
  ChallengeAnnouncementRecord,
  ChallengeSummary,
  ContestOverview,
  ContestSchedulerSnapshot,
  RemoteEnvironment,
  RunEvent,
  RunFilter,
  RunRecord,
  SubagentRecord,
  TldrRecord,
  WorkspaceArtifactListing,
} from "@ctf-agent/core"
import type { AgentOptions } from "@earendil-works/pi-agent-core"
import type {
  ChallengeWriteup,
  DashboardModelConfiguration,
  DashboardProject,
  DashboardScheduler,
  ModelConfigurationUpdate,
  ModelConfigurationView,
} from "../src/types.ts"

const now = "2026-07-29T12:00:00.000Z"

export class FakeDashboardProject implements DashboardProject {
  agentStreamSubscriptions: Array<{
    target: AgentStreamTarget
    listener: AgentStreamListener
  }> = []
  refreshCalls = 0
  overviewCalls = 0
  runEventsCalls = 0
  latestRunEventCalls = 0
  overviewDelayMs = 0
  overviewError?: Error
  overviewValue: ContestOverview = {
    id: "event-1",
    name: "Test CTF",
    challenges: 3,
    announcements: 1,
  }
  challengeValues: ChallengeSummary[] = [
    { id: "pwn-1", title: "Heap Garden", category: "pwn", score: 500 },
    {
      id: "web-1",
      title: "Cookie Jar",
      category: "web",
      score: 300,
      solved: true,
    },
    { id: "misc-1", title: "Signal", category: "misc", score: 100 },
  ]
  announcementValues: Announcement[] = [
    {
      id: "a-1",
      title: "Welcome",
      content: "Contest started.",
      publishedAt: "2026-07-29T10:00:00.000Z",
    },
  ]
  announcementCandidateValues: ChallengeAnnouncementRecord[] = []
  announcementReviews: Array<{
    challengeId: string
    announcementKey: string
    status: "approved" | "rejected"
  }> = []
  environmentValues: RemoteEnvironment[] = [
    {
      id: "env-1",
      challengeId: "pwn-1",
      status: "running",
      endpoint: "tcp://127.0.0.1:31337",
    },
  ]
  runValues: RunRecord[] = [
    {
      id: "run-pwn-1",
      challengeId: "pwn-1",
      workspace: "/workspace/run-pwn-1",
      attempt: 1,
      source: "auto",
      status: "running",
      createdAt: "2026-07-29T11:55:00.000Z",
      updatedAt: now,
      startedAt: "2026-07-29T11:55:01.000Z",
    },
  ]
  eventValues = new Map<string, RunEvent[]>([
    [
      "run-pwn-1",
      [
        {
          id: 1,
          runId: "run-pwn-1",
          type: "tool_started",
          data: { toolName: "bash", args: { command: "[omitted]" } },
          createdAt: now,
        },
      ],
    ],
  ])
  subagentValues = new Map<string, SubagentRecord[]>([
    [
      "run-pwn-1",
      [
        {
          id: "worker-pwn-1",
          runId: "run-pwn-1",
          role: "pwn",
          displayName: "Pwn",
          description: "检查保护与漏洞原语",
          status: "running",
          background: true,
          prompt: "分析目标二进制",
          sessionPath: "/sessions/worker-pwn-1/session.jsonl",
          containerCwd: "/workspace/subagents/worker-pwn-1",
          activeTool: "bash",
          turns: 2,
          toolUses: 4,
          totalTokens: 1_024,
          createdAt: now,
          updatedAt: now,
          startedAt: now,
        },
      ],
    ],
  ])
  blackboardValues = new Map<string, BlackboardSummary>([
    [
      "pwn-1",
      {
        evidence: [{ id: 1, description: "PIE enabled", runId: "run-pwn-1" }],
        opportunities: [
          {
            id: 1,
            description: "Leak libc through puts",
            status: "open",
            resolution: null,
            sourceEvidenceIds: [1],
            targetEvidenceId: null,
          },
        ],
      },
    ],
  ])
  statsValues: BlackboardStats[] = [
    {
      challengeId: "pwn-1",
      evidence: 1,
      openOpportunities: 1,
      concludedOpportunities: 0,
    },
  ]
  sendMessageCalls: Array<{ challengeId: string; text: string }> = []
  sendMessageResult:
    | { runId: string }
    | { error: "no_active_run" }
    | { error: "invalid_message" } = { runId: "run-pwn-1" }
  thinkingLevelCalls: Array<{ challengeId: string; level: string }> = []
  thinkingLevelResult: { runId: string } | { error: "no_active_run" } = {
    runId: "run-pwn-1",
  }

  async sendMessage(
    challengeId: string,
    text: string,
  ): Promise<{ runId: string }> {
    this.sendMessageCalls.push({ challengeId, text })
    if ("error" in this.sendMessageResult) {
      if (this.sendMessageResult.error === "no_active_run") {
        throw Object.assign(new Error("该题当前没有运行中的 Agent"), {
          code: "no_active_run",
        })
      }
      throw Object.assign(new Error("消息内容不合法(测试)"), {
        code: "invalid_message",
      })
    }
    return this.sendMessageResult
  }

  async setThinkingLevel(
    challengeId: string,
    level: string,
  ): Promise<{ runId: string }> {
    this.thinkingLevelCalls.push({ challengeId, level })
    if ("error" in this.thinkingLevelResult) {
      throw Object.assign(new Error("该题当前没有运行中的 Agent"), {
        code: "no_active_run",
      })
    }
    return this.thinkingLevelResult
  }

  async refresh(): Promise<ContestOverview> {
    this.refreshCalls++
    return this.overviewValue
  }

  async overview(): Promise<ContestOverview> {
    this.overviewCalls++
    if (this.overviewDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.overviewDelayMs))
    }
    if (this.overviewError) throw this.overviewError
    return this.overviewValue
  }
  async challenges(): Promise<ChallengeSummary[]> {
    return this.challengeValues
  }
  async announcements(): Promise<Announcement[]> {
    return this.announcementValues
  }

  availableSubagents() {
    return [
      { name: "general-purpose", displayName: "General" },
      { name: "explorer", displayName: "Explore" },
      { name: "fuzzer", displayName: "Fuzz" },
    ]
  }
  announcementCandidates(): ChallengeAnnouncementRecord[] {
    return this.announcementCandidateValues
  }
  async reviewChallengeAnnouncement(
    challengeId: string,
    announcementKey: string,
    status: "approved" | "rejected",
  ): Promise<ChallengeAnnouncementRecord> {
    this.announcementReviews.push({ challengeId, announcementKey, status })
    const candidate = this.announcementCandidateValues.find(
      (item) =>
        item.challengeId === challengeId && item.key === announcementKey,
    )
    if (!candidate) {
      throw Object.assign(new Error("公告候选不存在"), {
        code: "announcement_candidate_not_found",
      })
    }
    candidate.approvalStatus = status
    candidate.reviewedAt = new Date().toISOString()
    return candidate
  }
  async environments(): Promise<RemoteEnvironment[]> {
    return this.environmentValues
  }

  runs(filter: RunFilter = {}): RunRecord[] {
    return this.runValues.filter((run) => {
      if (filter.challengeId && run.challengeId !== filter.challengeId)
        return false
      if (!filter.status) return true
      const statuses = Array.isArray(filter.status)
        ? filter.status
        : [filter.status]
      return statuses.includes(run.status)
    })
  }

  runSessionPath(runId: string): string {
    return `/sessions/${runId}/session.jsonl`
  }

  subscribeAgentStream(
    target: AgentStreamTarget,
    listener: AgentStreamListener,
  ): () => void {
    const subscription = { target, listener }
    this.agentStreamSubscriptions.push(subscription)
    return () => {
      this.agentStreamSubscriptions = this.agentStreamSubscriptions.filter(
        (candidate) => candidate !== subscription,
      )
    }
  }

  async runSessionExportMetadata() {
    return {
      systemPrompt: "You are a CTF solver.",
      tools: [
        {
          name: "ctf_submit_flag",
          description: "Submit a flag.",
          parameters: { type: "object", properties: {} },
        },
      ],
    }
  }

  runEvents(runId: string): RunEvent[] {
    this.runEventsCalls++
    return this.eventValues.get(runId) ?? []
  }

  latestRunEvent(runId: string): RunEvent | undefined {
    this.latestRunEventCalls++
    return this.eventValues.get(runId)?.at(-1)
  }

  subagents(runId: string): SubagentRecord[] {
    return this.subagentValues.get(runId) ?? []
  }

  async steerSubagent(
    runId: string,
    subagentId: string,
    message: string,
  ): Promise<SubagentRecord> {
    const record = this.subagentValues
      .get(runId)
      ?.find((item) => item.id === subagentId)
    if (!record) throw new Error("SubAgent not found")
    return { ...record, description: `${record.description}: ${message}` }
  }

  async cancelSubagent(
    runId: string,
    subagentId: string,
  ): Promise<SubagentRecord> {
    const record = this.subagentValues
      .get(runId)
      ?.find((item) => item.id === subagentId)
    if (!record) throw new Error("SubAgent not found")
    record.status = "cancelled"
    return { ...record }
  }

  blackboard(challengeId: string): BlackboardSummary {
    return (
      this.blackboardValues.get(challengeId) ?? {
        evidence: [],
        opportunities: [],
      }
    )
  }

  blackboardStats(): BlackboardStats[] {
    return this.statsValues
  }
  tldr(_challengeId: string): TldrRecord | undefined {
    return this.tldrValue
  }
  tldrRefreshCalls = 0
  tldrValue: TldrRecord | undefined
  tldrAgentOptions?: AgentOptions
  tldrGenerationError?: Error
  async refreshTldr(
    _challengeId: string,
    agent: AgentOptions,
  ): Promise<TldrRecord> {
    this.tldrRefreshCalls += 1
    this.tldrAgentOptions = agent
    if (this.tldrGenerationError) throw this.tldrGenerationError
    return (
      this.tldrValue ?? {
        challengeId: "",
        content: "",
        model: "",
        sessionPath: "",
        updatedAt: now,
        error: "not implemented in fake",
        inputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }
    )
  }
  writeupValue: ChallengeWriteup = {
    validation: {
      valid: false,
      path: `/workspace/x/writeup.md`,
      errors: ["writeup.md does not exist"],
      size: 0,
    },
    content: null,
  }
  async challengeWriteup(_challengeId: string) {
    return structuredClone(this.writeupValue)
  }
  workspaceFilesValue: WorkspaceArtifactListing = {
    files: [],
    truncated: false,
  }
  workspaceFileValues = new Map<string, Uint8Array>()
  async challengeWorkspaceFiles(_challengeId: string) {
    return structuredClone(this.workspaceFilesValue)
  }
  async challengeWorkspaceFile(_challengeId: string, artifactPath: string) {
    if (artifactPath.split(/[\\/]/).includes("..")) {
      throw new Error("Workspace artifact path escapes the challenge workspace")
    }
    const content = this.workspaceFileValues.get(artifactPath)
    if (!content) {
      const error = new Error(
        `Workspace artifact does not exist: ${artifactPath}`,
      )
      Object.assign(error, { code: "ENOENT" })
      throw error
    }
    return content
  }
  schedulerAttemptCount(challengeId: string): number {
    return this.runValues.filter(
      (run) =>
        run.challengeId === challengeId &&
        ["auto", "manual", "retry"].includes(run.source),
    ).length
  }
  sessionInterruptionCount(challengeId: string): number {
    const resetAt = Math.max(
      ...this.runValues
        .filter((run) => run.challengeId === challengeId)
        .flatMap((run) =>
          (this.eventValues.get(run.id) ?? [])
            .filter((event) => event.type === "session_interruptions_reset")
            .map((event) => Date.parse(event.createdAt)),
        ),
    )
    return this.runValues.filter(
      (run) =>
        run.challengeId === challengeId &&
        ["interrupted", "blocked"].includes(run.status) &&
        Date.parse(run.updatedAt) > resetAt,
    ).length
  }
}

export class FakeDashboardScheduler implements DashboardScheduler {
  dispatchCalls: Array<{ challengeId: string; force?: boolean }> = []
  retryAttemptCalls: Array<{ runId: string; prompt?: string }> = []
  value: ContestSchedulerSnapshot = {
    available: true,
    autoEnabled: false,
    maxConcurrent: 2,
    maxAttempts: 2,
    maxSessionInterruptions: 3,
    queued: [],
    active: [],
  }

  snapshot(): ContestSchedulerSnapshot {
    return structuredClone(this.value)
  }

  async reconcile(): Promise<ContestSchedulerSnapshot> {
    return this.snapshot()
  }

  async startAuto(): Promise<ContestSchedulerSnapshot> {
    this.value.autoEnabled = true
    return this.snapshot()
  }

  pauseAuto(): ContestSchedulerSnapshot {
    this.value.autoEnabled = false
    this.value.queued = []
    return this.snapshot()
  }

  async setMaxConcurrent(
    maxConcurrent: number,
  ): Promise<ContestSchedulerSnapshot> {
    this.value.maxConcurrent = maxConcurrent
    return this.snapshot()
  }

  async dispatch(
    challengeId: string,
    options: { force?: boolean } = {},
  ): Promise<ContestSchedulerSnapshot> {
    this.dispatchCalls.push({ challengeId, ...options })
    this.value.queued.push({
      challengeId,
      source: options.force ? "revival" : "manual",
      lane: options.force ? "blocked" : "normal",
      manualOverride: options.force === true,
      enqueuedAt: now,
      position: this.value.queued.length + 1,
      version: 1,
    })
    return this.snapshot()
  }

  async retryAttempt(
    runId: string,
    options: { prompt?: string } = {},
  ): Promise<ContestSchedulerSnapshot> {
    this.retryAttemptCalls.push({ runId, ...options })
    return this.snapshot()
  }

  reorderQueue(
    challengeId: string,
    options: { position: number; expectedVersion: number },
  ): ContestSchedulerSnapshot {
    const item = this.value.queued.find(
      (candidate) => candidate.challengeId === challengeId,
    )
    if (!item) return this.snapshot()
    item.position = options.position
    item.version += 1
    this.value.queued.sort((left, right) => left.position - right.position)
    return this.snapshot()
  }

  async cancel(challengeId: string): Promise<ContestSchedulerSnapshot> {
    this.value.queued = this.value.queued
      .filter((item) => item.challengeId !== challengeId)
      .map((item, index) => ({ ...item, position: index + 1 }))
    return this.snapshot()
  }
}

export class FakeModelConfiguration implements DashboardModelConfiguration {
  value: ModelConfigurationView = {
    models: [],
    customProviders: [],
    solverModelId: "",
    tldrModelId: "",
    subagentModels: {},
    supportedThinkingLevels: ["low", "medium", "high", "max"],
    configured: false,
    unavailableReason: "missing model configuration",
  }

  snapshot(): ModelConfigurationView {
    return structuredClone(this.value)
  }

  createAgentOptions(_target: "solver" | "tldr" = "solver"): AgentOptions {
    if (this.agentOptionsValue) return this.agentOptionsValue
    throw new Error("Fake model transport is not configured")
  }
  agentOptionsValue?: AgentOptions

  modelForSubagent(role: string): string | undefined {
    const id = this.value.subagentModels[role]
    const model = this.value.models.find((candidate) => candidate.id === id)
    return model ? `${model.provider}/${model.modelId}` : undefined
  }

  async update(
    configuration: ModelConfigurationUpdate,
  ): Promise<ModelConfigurationView> {
    const models = configuration.models.map((model) => ({
      id: model.id,
      provider: model.provider,
      modelId: model.modelId,
      contextWindow: model.contextWindow,
      thinkingEnabled: model.thinkingEnabled,
      reasoningEffort: model.reasoningEffort,
      passthroughThinking: model.passthroughThinking,
      supportedThinkingLevels: ["low", "medium", "high", "max"],
      configured: Boolean(model.modelId),
      ...(!model.modelId
        ? { unavailableReason: "missing model configuration" }
        : {}),
    }))
    const solver = models.find(
      (model) => model.id === configuration.solverModelId,
    )
    this.value = {
      models,
      customProviders: this.value.customProviders,
      solverModelId: configuration.solverModelId,
      tldrModelId: configuration.tldrModelId,
      subagentModels: { ...configuration.subagentModels },
      supportedThinkingLevels: solver?.supportedThinkingLevels ?? [],
      configured: solver?.configured === true,
      ...(!solver?.configured
        ? { unavailableReason: "missing model configuration" }
        : {}),
    }
    return this.snapshot()
  }

  async addCustomProvider(
    provider: import("../src/types.ts").CustomModelProviderUpdate,
  ): Promise<ModelConfigurationView> {
    this.value.customProviders.push({
      id: `custom-${provider.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      name: provider.name,
      api: provider.api,
      baseUrl: provider.baseUrl,
      apiKeyConfigured: true,
    })
    return this.snapshot()
  }

  async updateCustomProvider(
    providerId: string,
    provider: import("../src/types.ts").CustomModelProviderEdit,
  ): Promise<ModelConfigurationView> {
    const index = this.value.customProviders.findIndex(
      (candidate) => candidate.id === providerId,
    )
    if (index < 0) throw new Error(`自定义供应商不存在: ${providerId}`)
    this.value.customProviders[index] = {
      id: providerId,
      name: provider.name,
      api: provider.api,
      baseUrl: provider.baseUrl,
      apiKeyConfigured:
        Boolean(provider.apiKey) ||
        this.value.customProviders[index]?.apiKeyConfigured === true,
    }
    return this.snapshot()
  }

  async removeCustomProvider(
    providerId: string,
  ): Promise<ModelConfigurationView> {
    this.value.customProviders = this.value.customProviders.filter(
      (provider) => provider.id !== providerId,
    )
    return this.snapshot()
  }

  async discoverCustomProviderModels(providerId: string): Promise<string[]> {
    if (
      !this.value.customProviders.some((provider) => provider.id === providerId)
    ) {
      throw new Error(`自定义供应商不存在: ${providerId}`)
    }
    return ["custom-model-a", "custom-model-b"]
  }
}
