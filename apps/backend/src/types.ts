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
  ControlPlaneProjectSnapshot,
  ControlPlaneSetupSnapshot,
  ControlPlaneSnapshot,
  FatherSessionRecord,
  PlatformCandidateView,
  PlatformConnectionTest,
  PlatformExtensionView,
  PlatformValidationProfile,
  PlatformValidationReport,
  PlatformViewCache,
  ProjectConfig,
  RemoteEnvironment,
  RunEvent,
  RunFilter,
  RunRecord,
  RunSessionExportMetadata,
  SchedulerQueueRecord,
  SubagentRecord,
  TldrRecord,
  WorkspaceArtifactListing,
} from "@ctf-agent/core"
import type { AgentMessage, AgentOptions } from "@earendil-works/pi-agent-core"

export interface DashboardConversationMessage {
  entryId: string
  timestamp: string
  message: AgentMessage
}

export interface DashboardConversation {
  messages: DashboardConversationMessage[]
}

export interface DashboardFather {
  list(): FatherSessionRecord[]
  get(id: string): FatherSessionRecord | undefined
  sessionPath(id: string): string
  workspace(id: string): string
  create(input: { createdBy: string; parentSessionId?: string }): Promise<FatherSessionRecord>
  send(id: string, message: string): Promise<FatherSessionRecord>
  stop(id: string): Promise<FatherSessionRecord>
  complete(id: string): Promise<FatherSessionRecord>
  delete(id: string): Promise<void>
  subscribe(id: string, listener: AgentStreamListener): () => void
  setGateStatus(id: string, gate: FatherSessionRecord["gate"]): Promise<FatherSessionRecord>
  notifyValidation(id: string, report: PlatformValidationReport): Promise<void>
  close(): Promise<void>
}

export interface DashboardPlatformExtensions {
  describeCandidate(candidateDirectory: string): Promise<PlatformCandidateView>
  list(): Promise<PlatformExtensionView[]>
  readCandidateEntry(candidateDirectory: string): Promise<{
    filename: string
    content: Buffer
  }>
  validate(input: {
    sessionId: string
    candidateDirectory: string
    profile: PlatformValidationProfile
  }): Promise<PlatformValidationReport>
  activate(input: {
    sessionId: string
    candidateDirectory: string
    validationReport?: PlatformValidationReport
  }): Promise<PlatformExtensionView>
  deleteValidationReport(sessionId: string): Promise<void>
}

export interface DashboardFatherValidationConfigs {
  read(
    sessionId: string,
    schemaFingerprint: string,
  ): Promise<
    | {
        config: unknown
        configuredSecrets: Record<string, { configured: boolean }>
        secrets: Record<string, string | undefined>
      }
    | undefined
  >
  save(input: {
    sessionId: string
    schemaFingerprint: string
    config: unknown
    secrets: Record<string, string | undefined>
    secretNames: string[]
  }): Promise<void>
  delete(sessionId: string): Promise<void>
}

export type DashboardChallengeStatus =
  | "queued"
  | "pending"
  | "preparing"
  | "running"
  | "blocking"
  | "writing_writeup"
  | "solved"
  | "excluded"
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
  schedulingDisposition?: "excluded" | "solved"
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
  announcementCandidates: ChallengeAnnouncementRecord[]
  environments: RemoteEnvironment[]
  scheduler: ContestSchedulerSnapshot | null
  controlPlane: ControlPlaneSnapshot | null
}

export interface AgentCacheStats {
  inputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  cacheRate: number | null
}

export interface DashboardRun extends RunRecord {
  events: RunEvent[]
  subagents: DashboardSubagent[]
  cache: AgentCacheStats
  hasConversation: boolean
}

export interface DashboardSubagent extends SubagentRecord {
  hasConversation: boolean
}

export interface ChallengeWriteup {
  validation: {
    valid: boolean
    path: string
    errors: string[]
    size: number
  }
  content: string | null
}

export interface ChallengeDetails {
  generatedAt: string
  solverAvailable: boolean
  challenge: DashboardChallenge
  runs: DashboardRun[]
  blackboard: BlackboardSummary
  environment: RemoteEnvironment | null
  writeup: ChallengeWriteup
  tldr: TldrRecord | null
}

export interface DashboardProject {
  refresh(): Promise<ContestOverview>
  overview(): Promise<ContestOverview>
  challenges(): Promise<ChallengeSummary[]>
  announcements(): Promise<Announcement[]>
  announcementCandidates(): ChallengeAnnouncementRecord[]
  reviewChallengeAnnouncement(
    challengeId: string,
    announcementKey: string,
    status: "approved" | "rejected",
  ): Promise<ChallengeAnnouncementRecord>
  environments(): Promise<RemoteEnvironment[]>
  cachedPlatformView?(): PlatformViewCache
  schedulerQueue?(): SchedulerQueueRecord[]
  setMaxRemoteEnvironments(maxConcurrent: number): Promise<void>
  runs(filter?: RunFilter): RunRecord[]
  /** 返回已持久化的原生 Pi session，供 HTML 导出读取。 */
  runSessionPath(runId: string): string
  /** 返回 Pi HTML 导出所需的 system prompt 和工具元数据。 */
  runSessionExportMetadata(runId: string): Promise<RunSessionExportMetadata | undefined>
  subscribeAgentStream(target: AgentStreamTarget, listener: AgentStreamListener): () => void
  runEvents(runId: string): RunEvent[]
  latestRunEvent(runId: string): RunEvent | undefined
  subagents(runId: string): SubagentRecord[]
  availableSubagents(): Array<{
    name: string
    displayName: string
    model?: string
  }>
  blackboard(challengeId: string): BlackboardSummary
  blackboardStats(): BlackboardStats[]
  challengeWriteup(challengeId: string): Promise<ChallengeWriteup>
  challengeWorkspaceFiles(challengeId: string): Promise<WorkspaceArtifactListing>
  challengeWorkspaceFile(challengeId: string, artifactPath: string): Promise<Uint8Array>
  tldr(challengeId: string): TldrRecord | undefined
  refreshTldr(challengeId: string, agent: AgentOptions): Promise<TldrRecord>
  schedulerAttemptCount(challengeId: string): number
  sessionInterruptionCount(challengeId: string): number
  challengeSchedulingDisposition(challengeId: string): "excluded" | "solved" | null
  setChallengeSchedulingDisposition(
    challengeId: string,
    disposition: "excluded" | "solved" | null,
  ): unknown
  removeSchedulerChallenge(challengeId: string): boolean
  /**
   * 向某题当前活跃的 solver 发送人工消息(题目级对话框)。
   * 无活跃 solver 时 reject 一个带 code:"no_active_run" 的 Error。
   */
  sendMessage(challengeId: string, text: string): Promise<{ runId: string }>
  /**
   * 切换某题当前活跃 solver 的思考强度(当前 run 下一 turn 边界生效)。
   * 无活跃 solver → code:"no_active_run";非法档位 → code:"invalid_level"。
   */
  setThinkingLevel(challengeId: string, level: string): Promise<{ runId: string }>
  steerSubagent(runId: string, subagentId: string, message: string): Promise<SubagentRecord>
  cancelSubagent(runId: string, subagentId: string): Promise<SubagentRecord>
}

export interface DashboardScheduler {
  snapshot(): ContestSchedulerSnapshot
  reconcile(): Promise<ContestSchedulerSnapshot>
  startAuto(): Promise<ContestSchedulerSnapshot>
  pauseAuto(): ContestSchedulerSnapshot
  resume(): ContestSchedulerSnapshot
  setMaxConcurrent(maxConcurrent: number): Promise<ContestSchedulerSnapshot>
  dispatch(challengeId: string, options?: { force?: boolean }): Promise<ContestSchedulerSnapshot>
  retryAttempt(runId: string, options?: { prompt?: string }): Promise<ContestSchedulerSnapshot>
  reorderQueue(
    challengeId: string,
    options: {
      position: number
      expectedVersion: number
      overrideBlockedLane?: boolean
    },
  ): ContestSchedulerSnapshot
  cancel(challengeId: string): Promise<ContestSchedulerSnapshot>
}

export interface DashboardControlPlane {
  snapshot(projectId?: string): ControlPlaneSnapshot
  projectSnapshots(): ControlPlaneProjectSnapshot[]
  setupSnapshot(projectId?: string): ControlPlaneSetupSnapshot
  selectProject(projectId: string): ControlPlaneSnapshot
  currentProject(projectId?: string): DashboardProject | undefined
  currentScheduler(projectId?: string): DashboardScheduler | undefined
  shouldPollProject?(projectId?: string): boolean
  canStartSolver?(projectId?: string): boolean
  reportPlatformFailure?(projectId: string | undefined, error: unknown): void
  reportPlatformSuccess?(projectId?: string): void
  testConnection(input: {
    config: ProjectConfig
    secrets?: Readonly<Record<string, string | undefined>>
  }): Promise<PlatformConnectionTest>
  applySetup(input: {
    config: ProjectConfig
    secrets?: Readonly<Record<string, string | undefined>>
  }): Promise<ControlPlaneSnapshot>
  connect(projectId?: string): Promise<ControlPlaneSnapshot>
  deleteProject(projectId: string): Promise<ControlPlaneSnapshot>
  resetProject(projectId: string): Promise<ControlPlaneSnapshot>
  archiveProject(projectId: string, archived: boolean): Promise<ControlPlaneSnapshot>
  disconnectArchivedIdleProjects?(): Promise<ControlPlaneSnapshot>
}

export interface ModelPoolEntryView {
  id: string
  provider: string
  modelId: string
  contextWindow: number
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

export interface ModelPoolEntryUpdate {
  id: string
  provider: string
  modelId: string
  contextWindow: number
  thinkingEnabled: boolean
  reasoningEffort: string
  passthroughThinking: boolean
}

export type CustomModelProviderApi =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages"

export interface CustomModelProviderView {
  id: string
  name: string
  api: CustomModelProviderApi
  baseUrl: string
  apiKeyConfigured: boolean
}

export interface CustomModelProviderUpdate {
  name: string
  api: CustomModelProviderApi
  baseUrl: string
  apiKey: string
}

export interface CustomModelProviderEdit {
  name: string
  api: CustomModelProviderApi
  baseUrl: string
  apiKey?: string
}

export interface ModelConfigurationView {
  models: ModelPoolEntryView[]
  customProviders: CustomModelProviderView[]
  solverModelId: string
  tldrModelId: string
  fatherModelId?: string
  subagentModels: Record<string, string>
  /** WebUI 根据当前 Project 动态补充，未连接平台时可以为空。 */
  subagentRoles?: Array<{ name: string; displayName: string }>
  /** Solver 当前模型支持的档位，供题目详情中的运行时切换使用。 */
  supportedThinkingLevels: string[]
  configured: boolean
  unavailableReason?: string
}

export interface AgentModelBindings {
  solverModelId: string
  tldrModelId: string
  subagentModels: Record<string, string>
}

export interface ProjectRuntimeConfigurationView extends AgentModelBindings {
  maxConcurrent: number
  maxRemoteEnvironments: number
}

export interface DashboardProjectRuntimeConfiguration {
  snapshot(): ProjectRuntimeConfigurationView
  update(configuration: ProjectRuntimeConfigurationView): Promise<ProjectRuntimeConfigurationView>
}

export interface ModelConfigurationUpdate {
  models: ModelPoolEntryUpdate[]
  solverModelId: string
  tldrModelId: string
  fatherModelId?: string
  subagentModels: Record<string, string>
}

export interface DashboardModelConfiguration {
  snapshot(bindings?: AgentModelBindings): ModelConfigurationView
  createAgentOptions(target?: "solver" | "tldr", bindings?: AgentModelBindings): AgentOptions
  modelForSubagent(role: string, bindings?: AgentModelBindings): string | undefined
  update(configuration: ModelConfigurationUpdate): Promise<ModelConfigurationView>
  addCustomProvider(provider: CustomModelProviderUpdate): Promise<ModelConfigurationView>
  updateCustomProvider(
    providerId: string,
    provider: CustomModelProviderEdit,
  ): Promise<ModelConfigurationView>
  removeCustomProvider(providerId: string): Promise<ModelConfigurationView>
  discoverCustomProviderModels(providerId: string): Promise<string[]>
  /**
   * 把模型池适配成 web-access 的 ModelAuthResolver（find / getApiKeyAndHeaders /
   * getAvailable），供搜索 + auto-summary 使用。
   */
  resolveModelAuth(): WebAccessModelAuth
}

/** 与 @ctf-agent/web-access 的 ModelAuthResolver 结构一致（避免后端→包反向依赖）。 */
export interface WebAccessModelAuth {
  find(provider: string, modelId: string): { provider: string; id: string } | undefined
  getApiKeyAndHeaders(model: {
    provider: string
    id: string
  }): Promise<{ ok: true; apiKey: string; headers?: Record<string, string> } | { ok: false }>
  getAvailable(): readonly { provider: string; id: string }[]
}

export type ModelAuthProviderId =
  | "openai-codex"
  | "openai"
  | "anthropic"
  | "deepseek"
  | "nvidia"
  | "google"
  | "mistral"
  | "groq"
  | "cerebras"
  | "xai"
  | "fireworks"
  | "together"
  | "openrouter"
  | "huggingface"
  | "moonshotai"
  | "ant-ling"
  | "azure-openai-responses"
  | "vercel-ai-gateway"
  | "cloudflare-ai-gateway"
  | "kimi-coding"
  | "opencode"
  | "opencode-go"
  | "zai"
  | "minimax"
export type ModelAuthMethodId = "oauth_browser" | "oauth_device" | "oauth_token" | "api_key"
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

export type ModelAuthLoginStatus = "running" | "awaiting_input" | "success" | "error" | "cancelled"

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

export interface DashboardWebUiAuthentication {
  snapshot(): { enabled: boolean; username: string | null }
  configure(input: {
    enabled: boolean
    username?: string
    password?: string
  }): Promise<{ enabled: boolean; username: string | null }>
  login(
    username: string,
    password: string,
  ): Promise<{ token: string; username: string; expiresAt: string }>
  authenticate(token: string | undefined): boolean
  logout(token: string | undefined): void
}
