import type {
  Announcement,
  BlackboardStats,
  BlackboardSummary,
  ChallengeSummary,
  ContestSchedulerSnapshot,
  ContestOverview,
  RemoteEnvironment,
  RunEvent,
  RunFilter,
  RunRecord,
} from "@ctf-agent/solver"
import type {
  DashboardModelConfiguration,
  DashboardProject,
  DashboardScheduler,
  ModelConfigurationUpdate,
  ModelConfigurationView,
} from "../src/types.ts"

const now = "2026-07-29T12:00:00.000Z"

export class FakeDashboardProject implements DashboardProject {
  refreshCalls = 0
  overviewValue: ContestOverview = {
    id: "event-1",
    name: "Test CTF",
    challenges: 3,
    announcements: 1,
  }
  challengeValues: ChallengeSummary[] = [
    { id: "pwn-1", title: "Heap Garden", category: "pwn", score: 500 },
    { id: "web-1", title: "Cookie Jar", category: "web", score: 300, solved: true },
    { id: "misc-1", title: "Signal", category: "misc", score: 100 },
  ]
  announcementValues: Announcement[] = [{
    id: "a-1",
    title: "Welcome",
    content: "Contest started.",
    publishedAt: "2026-07-29T10:00:00.000Z",
  }]
  environmentValues: RemoteEnvironment[] = [{
    id: "env-1",
    challengeId: "pwn-1",
    status: "running",
    endpoint: "tcp://127.0.0.1:31337",
  }]
  runValues: RunRecord[] = [{
    id: "run-pwn-1",
    challengeId: "pwn-1",
    workspace: "/workspace/run-pwn-1",
    attempt: 1,
    source: "auto",
    status: "running",
    createdAt: "2026-07-29T11:55:00.000Z",
    updatedAt: now,
    startedAt: "2026-07-29T11:55:01.000Z",
  }]
  eventValues = new Map<string, RunEvent[]>([[
    "run-pwn-1",
    [{
      id: 1,
      runId: "run-pwn-1",
      type: "tool_started",
      data: { toolName: "bash", args: { command: "[omitted]" } },
      createdAt: now,
    }],
  ]])
  blackboardValues = new Map<string, BlackboardSummary>([[
    "pwn-1",
    {
      evidence: [{ id: 1, description: "PIE enabled", runId: "run-pwn-1" }],
      opportunities: [{
        id: 1,
        description: "Leak libc through puts",
        status: "open",
        sourceEvidenceIds: [1],
        targetEvidenceId: null,
      }],
    },
  ]])
  statsValues: BlackboardStats[] = [{
    challengeId: "pwn-1",
    evidence: 1,
    openOpportunities: 1,
    concludedOpportunities: 0,
  }]
  sendMessageCalls: Array<{ challengeId: string; text: string }> = []
  sendMessageResult: { runId: string } | { error: "no_active_run" } | { error: "invalid_message" } =
    { runId: "run-pwn-1" }
  thinkingLevelCalls: Array<{ challengeId: string; level: string }> = []
  thinkingLevelResult: { runId: string } | { error: "no_active_run" } = { runId: "run-pwn-1" }

  async sendMessage(challengeId: string, text: string): Promise<{ runId: string }> {
    this.sendMessageCalls.push({ challengeId, text })
    if ("error" in this.sendMessageResult) {
      if (this.sendMessageResult.error === "no_active_run") {
        throw Object.assign(new Error("该题当前没有运行中的 Agent"), { code: "no_active_run" })
      }
      throw Object.assign(new Error("消息内容不合法(测试)"), { code: "invalid_message" })
    }
    return this.sendMessageResult
  }

  async setThinkingLevel(challengeId: string, level: string): Promise<{ runId: string }> {
    this.thinkingLevelCalls.push({ challengeId, level })
    if ("error" in this.thinkingLevelResult) {
      throw Object.assign(new Error("该题当前没有运行中的 Agent"), { code: "no_active_run" })
    }
    return this.thinkingLevelResult
  }

  async refresh(): Promise<ContestOverview> {
    this.refreshCalls++
    return this.overviewValue
  }

  async overview(): Promise<ContestOverview> { return this.overviewValue }
  async challenges(): Promise<ChallengeSummary[]> { return this.challengeValues }
  async announcements(): Promise<Announcement[]> { return this.announcementValues }
  async environments(): Promise<RemoteEnvironment[]> { return this.environmentValues }

  runs(filter: RunFilter = {}): RunRecord[] {
    return this.runValues.filter((run) => {
      if (filter.challengeId && run.challengeId !== filter.challengeId) return false
      if (!filter.status) return true
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status]
      return statuses.includes(run.status)
    })
  }

  runEvents(runId: string): RunEvent[] {
    return this.eventValues.get(runId) ?? []
  }

  blackboard(challengeId: string): BlackboardSummary {
    return this.blackboardValues.get(challengeId) ?? {
      evidence: [],
      opportunities: [],
    }
  }

  blackboardStats(): BlackboardStats[] { return this.statsValues }
  schedulerAttemptCount(challengeId: string): number {
    return this.runValues.filter((run) =>
      run.challengeId === challengeId &&
      ["auto", "manual", "retry"].includes(run.source)).length
  }
}

export class FakeDashboardScheduler implements DashboardScheduler {
  value: ContestSchedulerSnapshot = {
    available: true,
    autoEnabled: false,
    maxConcurrent: 2,
    maxAttempts: 2,
    queued: [],
    active: [],
  }

  snapshot(): ContestSchedulerSnapshot { return structuredClone(this.value) }

  async reconcile(): Promise<ContestSchedulerSnapshot> { return this.snapshot() }

  async startAuto(): Promise<ContestSchedulerSnapshot> {
    this.value.autoEnabled = true
    return this.snapshot()
  }

  pauseAuto(): ContestSchedulerSnapshot {
    this.value.autoEnabled = false
    return this.snapshot()
  }

  async dispatch(challengeId: string): Promise<ContestSchedulerSnapshot> {
    this.value.queued.push({
      challengeId,
      source: "manual",
      enqueuedAt: now,
      position: this.value.queued.length + 1,
    })
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
    provider: "openrouter",
    modelId: "",
    baseUrl: "",
    contextWindow: 64_000,
    maxTokens: 4_096,
    apiKeyConfigured: false,
    apiKeySource: "none",
    thinkingEnabled: false,
    reasoningEffort: "max",
    passthroughThinking: false,
    supportedThinkingLevels: ["low", "medium", "high", "max"],
    platformTokenConfigured: false,
    platformTokenSource: "none",
    configured: false,
    unavailableReason: "missing model configuration",
  }
  lastApiKey: string | undefined
  lastPlatformToken: string | undefined

  snapshot(): ModelConfigurationView {
    return structuredClone(this.value)
  }

  async update(configuration: ModelConfigurationUpdate): Promise<ModelConfigurationView> {
    if (configuration.apiKey) this.lastApiKey = configuration.apiKey
    if (configuration.clearApiKey) this.lastApiKey = undefined
    if (configuration.platformToken) this.lastPlatformToken = configuration.platformToken
    if (configuration.clearPlatformToken) this.lastPlatformToken = undefined
    const apiKeyConfigured = Boolean(this.lastApiKey)
    this.value = {
      provider: configuration.provider,
      modelId: configuration.modelId,
      baseUrl: configuration.baseUrl,
      contextWindow: configuration.contextWindow,
      maxTokens: configuration.maxTokens,
      apiKeyConfigured,
      apiKeySource: apiKeyConfigured ? "webui" : "none",
      thinkingEnabled: configuration.thinkingEnabled,
      reasoningEffort: configuration.reasoningEffort,
      passthroughThinking: configuration.passthroughThinking,
      supportedThinkingLevels: this.value.supportedThinkingLevels,
      platformTokenConfigured: Boolean(this.lastPlatformToken),
      platformTokenSource: this.lastPlatformToken ? "webui" : "none",
      configured: apiKeyConfigured && Boolean(configuration.modelId),
      ...(!apiKeyConfigured || !configuration.modelId
        ? { unavailableReason: "missing model configuration" }
        : {}),
    }
    return this.snapshot()
  }
}
