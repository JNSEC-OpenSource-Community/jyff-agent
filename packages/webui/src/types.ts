import type {
  Announcement,
  BlackboardStats,
  BlackboardSummary,
  ChallengeSummary,
  ContestOverview,
  ContestSchedulerSnapshot,
  ControlPlaneSetupSnapshot,
  ControlPlaneSnapshot,
  PlatformConnectionTest,
  ProjectConfig,
  RemoteEnvironment,
  RunEvent,
  RunFilter,
  RunRecord,
  SubagentRecord,
} from "@ctf-agent/core"

export type DashboardChallengeStatus =
  | "queued"
  | "pending"
  | "preparing"
  | "running"
  | "blocking"
  | "writing_writeup"
  | "solved"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "interrupted"
  | "blocked"
  | "closed"

export interface DashboardChallenge {
  id: string
  title: string
  category: string
  score: number
  status: DashboardChallengeStatus
  platformSolved: boolean
  needsEnv?: boolean
  attempts: number
  latestRunId: string | null
  latestRunStatus: RunRecord["status"] | null
  lastActivityAt: string | null
  progress: string
  queuePosition: number | null
  dispatchSource: RunRecord["source"] | null
  schedulerAttempts: number
  sessionInterruptions: number
  evidence: number
  openOpportunities: number
  concludedOpportunities: number
}

export interface DashboardStats {
  total: number
  solved: number
  active: number
  failed: number
  pending: number
  attempts: number
  queued: number
}

export interface DashboardSnapshot {
  generatedAt: string
  overview: ContestOverview
  stats: DashboardStats
  challenges: DashboardChallenge[]
  categories: string[]
  announcements: Announcement[]
  environments: RemoteEnvironment[]
  scheduler: ContestSchedulerSnapshot | null
  controlPlane: ControlPlaneSnapshot | null
}

export interface DashboardRun extends RunRecord {
  events: RunEvent[]
  subagents: SubagentRecord[]
}

export interface ChallengeDetails {
  generatedAt: string
  challenge: DashboardChallenge
  runs: DashboardRun[]
  blackboard: BlackboardSummary
  environment: RemoteEnvironment | null
}

export interface DashboardProject {
  refresh(): Promise<ContestOverview>
  overview(): Promise<ContestOverview>
  challenges(): Promise<ChallengeSummary[]>
  announcements(): Promise<Announcement[]>
  environments(): Promise<RemoteEnvironment[]>
  runs(filter?: RunFilter): RunRecord[]
  runEvents(runId: string): RunEvent[]
  latestRunEvent(runId: string): RunEvent | undefined
  subagents(runId: string): SubagentRecord[]
  blackboard(challengeId: string): BlackboardSummary
  blackboardStats(): BlackboardStats[]
  schedulerAttemptCount(challengeId: string): number
  sessionInterruptionCount(challengeId: string): number
  /**
   * 向某题当前活跃的 solver 发送人工消息(题目级对话框)。
   * 无活跃 solver 时 reject 一个带 code:"no_active_run" 的 Error。
   */
  sendMessage(challengeId: string, text: string): Promise<{ runId: string }>
  /**
   * 切换某题当前活跃 solver 的思考强度(当前 run 下一 turn 边界生效)。
   * 无活跃 solver → code:"no_active_run";非法档位 → code:"invalid_level"。
   */
  setThinkingLevel(
    challengeId: string,
    level: string,
  ): Promise<{ runId: string }>
  steerSubagent(
    runId: string,
    subagentId: string,
    message: string,
  ): Promise<SubagentRecord>
  cancelSubagent(runId: string, subagentId: string): Promise<SubagentRecord>
}

export interface DashboardScheduler {
  snapshot(): ContestSchedulerSnapshot
  reconcile(): Promise<ContestSchedulerSnapshot>
  startAuto(): Promise<ContestSchedulerSnapshot>
  pauseAuto(): ContestSchedulerSnapshot
  setMaxConcurrent(maxConcurrent: number): Promise<ContestSchedulerSnapshot>
  dispatch(
    challengeId: string,
    options?: { force?: boolean },
  ): Promise<ContestSchedulerSnapshot>
  cancel(challengeId: string): Promise<ContestSchedulerSnapshot>
}

export interface DashboardControlPlane {
  snapshot(): ControlPlaneSnapshot
  setupSnapshot(): ControlPlaneSetupSnapshot
  currentProject(): DashboardProject | undefined
  currentScheduler(): DashboardScheduler | undefined
  testConnection(input: {
    config: ProjectConfig
    secrets?: Readonly<Record<string, string | undefined>>
  }): Promise<PlatformConnectionTest>
  applySetup(input: {
    config: ProjectConfig
    secrets?: Readonly<Record<string, string | undefined>>
  }): Promise<ControlPlaneSnapshot>
  connect(): Promise<ControlPlaneSnapshot>
}

export interface ModelConfigurationView {
  provider: string
  modelId: string
  baseUrl: string
  contextWindow: number
  apiKeyConfigured: boolean
  apiKeySource: "secret-store" | "provider-credential" | "none"
  /** 思维链开关(模型级配置,下次创建 solver 生效)。 */
  thinkingEnabled: boolean
  /** 思考强度档位(当前模型支持的档位之一,见 supportedThinkingLevels)。 */
  reasoningEffort: string
  /** 透传模式:自定义 baseUrl 时全档位同名直通(中转站场景)。 */
  passthroughThinking: boolean
  /** 当前模型实际支持的档位(pi 动态计算;配置不完整时只有 ["off"])。 */
  supportedThinkingLevels: string[]
  configured: boolean
  unavailableReason?: string
}

export interface ModelConfigurationUpdate {
  provider: string
  modelId: string
  baseUrl: string
  contextWindow: number
  thinkingEnabled: boolean
  reasoningEffort: string
  passthroughThinking: boolean
  apiKey?: string
  clearApiKey?: boolean
}

export interface DashboardModelConfiguration {
  snapshot(): ModelConfigurationView
  update(
    configuration: ModelConfigurationUpdate,
  ): Promise<ModelConfigurationView>
}

export type ModelAuthProviderId = "openai-codex" | "openai" | "anthropic"
export type ModelAuthMethodId =
  | "oauth_browser"
  | "oauth_device"
  | "oauth_token"
  | "api_key"
export type ModelAuthCredentialType = "oauth" | "api_key"

export interface ModelAuthMethodView {
  id: ModelAuthMethodId
  label: string
  description: string
  requiresSecret?: boolean
}

export interface ModelAuthModelView {
  id: string
  name: string
  contextWindow: number
  reasoning: boolean
}

export interface ModelAuthProviderView {
  id: ModelAuthProviderId
  name: string
  description: string
  configured: boolean
  credentialType?: ModelAuthCredentialType
  methods: ModelAuthMethodView[]
  models: ModelAuthModelView[]
}

export interface ModelAuthenticationView {
  providers: ModelAuthProviderView[]
  importPath: string
  importFileAvailable: boolean
}

export type ModelAuthLoginStatus =
  | "running"
  | "awaiting_input"
  | "success"
  | "error"
  | "cancelled"

export interface ModelAuthPromptView {
  type: "text" | "secret" | "select" | "manual_code"
  message: string
  placeholder?: string
  options?: { id: string; label: string; description?: string }[]
}

export interface ModelAuthLoginSessionView {
  id: string
  provider: ModelAuthProviderId
  method: ModelAuthMethodId
  status: ModelAuthLoginStatus
  authUrl?: string
  instructions?: string
  deviceCode?: {
    userCode: string
    verificationUri: string
    expiresInSeconds?: number
  }
  progress?: string
  prompt?: ModelAuthPromptView
  error?: string
  updatedAt: string
}

export interface ModelAuthImportResult {
  imported: { provider: ModelAuthProviderId; type: ModelAuthCredentialType }[]
  source: "upload" | "file"
}

export interface DashboardModelAuthentication {
  readonly models: import("@earendil-works/pi-ai").Models
  snapshot(): Promise<ModelAuthenticationView>
  hasCredential(provider: string): boolean
  credentialType(provider: string): ModelAuthCredentialType | undefined
  startLogin(input: {
    provider: string
    method: string
    secret?: string
  }): Promise<ModelAuthLoginSessionView>
  loginSession(sessionId: string): ModelAuthLoginSessionView
  submitPrompt(sessionId: string, value: string): ModelAuthLoginSessionView
  cancelLogin(sessionId: string): ModelAuthLoginSessionView
  logout(provider: string): Promise<ModelAuthenticationView>
  importJson(raw: string): Promise<ModelAuthImportResult>
  importFile(): Promise<ModelAuthImportResult>
}
