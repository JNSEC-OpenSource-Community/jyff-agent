import type {
  Announcement,
  BlackboardStats,
  BlackboardSummary,
  ChallengeSummary,
  ContestOverview,
  ContestSchedulerSnapshot,
  RemoteEnvironment,
  RunEvent,
  RunFilter,
  RunRecord,
  SubagentRecord,
} from "@ctf-agent/core"
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
  async challengeWriteup(challengeId: string) {
    return {
      validation: {
        valid: false,
        path: `/workspace/${challengeId}/writeup.md`,
        errors: ["writeup.md does not exist"],
        size: 0,
      },
      content: null,
    }
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

  async dispatch(challengeId: string): Promise<ContestSchedulerSnapshot> {
    this.value.queued.push({
      challengeId,
      source: "manual",
      lane: "normal",
      manualOverride: false,
      enqueuedAt: now,
      position: this.value.queued.length + 1,
      version: 1,
    })
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
    provider: "openrouter",
    modelId: "",
    baseUrl: "",
    contextWindow: 64_000,
    apiKeyConfigured: false,
    apiKeySource: "none",
    thinkingEnabled: false,
    reasoningEffort: "max",
    passthroughThinking: false,
    supportedThinkingLevels: ["low", "medium", "high", "max"],
    configured: false,
    unavailableReason: "missing model configuration",
  }
  lastApiKey: string | undefined

  snapshot(): ModelConfigurationView {
    return structuredClone(this.value)
  }

  async update(
    configuration: ModelConfigurationUpdate,
  ): Promise<ModelConfigurationView> {
    if (configuration.apiKey) this.lastApiKey = configuration.apiKey
    if (configuration.clearApiKey) this.lastApiKey = undefined
    const apiKeyConfigured = Boolean(this.lastApiKey)
    this.value = {
      provider: configuration.provider,
      modelId: configuration.modelId,
      baseUrl: configuration.baseUrl,
      contextWindow: configuration.contextWindow,
      apiKeyConfigured,
      apiKeySource: apiKeyConfigured ? "secret-store" : "none",
      thinkingEnabled: configuration.thinkingEnabled,
      reasoningEffort: configuration.reasoningEffort,
      passthroughThinking: configuration.passthroughThinking,
      supportedThinkingLevels: this.value.supportedThinkingLevels,
      configured: apiKeyConfigured && Boolean(configuration.modelId),
      ...(!apiKeyConfigured || !configuration.modelId
        ? { unavailableReason: "missing model configuration" }
        : {}),
    }
    return this.snapshot()
  }
}
