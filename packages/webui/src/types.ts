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

export type DashboardChallengeStatus =
  | "queued"
  | "pending"
  | "preparing"
  | "running"
  | "solved"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "interrupted"
  | "closed"

export interface DashboardChallenge {
  id: string
  title: string
  category: string
  score: number
  status: DashboardChallengeStatus
  platformSolved: boolean
  attempts: number
  latestRunId: string | null
  latestRunStatus: RunRecord["status"] | null
  lastActivityAt: string | null
  progress: string
  queuePosition: number | null
  dispatchSource: RunRecord["source"] | null
  schedulerAttempts: number
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
}

export interface DashboardRun extends RunRecord {
  events: RunEvent[]
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
  blackboard(challengeId: string): BlackboardSummary
  blackboardStats(): BlackboardStats[]
  schedulerAttemptCount(challengeId: string): number
}

export interface DashboardScheduler {
  snapshot(): ContestSchedulerSnapshot
  reconcile(): Promise<ContestSchedulerSnapshot>
  startAuto(): Promise<ContestSchedulerSnapshot>
  pauseAuto(): ContestSchedulerSnapshot
  dispatch(challengeId: string, options?: { force?: boolean }): Promise<ContestSchedulerSnapshot>
  cancel(challengeId: string): Promise<ContestSchedulerSnapshot>
}

export interface ModelConfigurationView {
  provider: string
  modelId: string
  baseUrl: string
  contextWindow: number
  maxTokens: number
  apiKeyConfigured: boolean
  apiKeySource: "environment" | "webui" | "none"
  configured: boolean
  unavailableReason?: string
}

export interface ModelConfigurationUpdate {
  provider: string
  modelId: string
  baseUrl: string
  contextWindow: number
  maxTokens: number
  apiKey?: string
  clearApiKey?: boolean
}

export interface DashboardModelConfiguration {
  snapshot(): ModelConfigurationView
  update(configuration: ModelConfigurationUpdate): Promise<ModelConfigurationView>
}
