export {
  createFileModelAuthentication,
  FileCredentialStore,
  type FileModelAuthenticationOptions,
  parseCredentialImport,
} from "./domain/model-auth.ts"
export {
  type AgentModelConfiguration,
  createFileModelConfiguration,
  type FileModelConfigurationOptions,
} from "./domain/model-pool.ts"
export { createFileProjectRuntimeConfiguration } from "./domain/runtime.ts"
export {
  buildChallengeDetails,
  buildDashboardSnapshot,
  buildEmptyDashboardSnapshot,
} from "./domain/view.ts"
export {
  DEFAULT_SOURCE_REPOSITORY,
  resolveBuildIdentity,
  type BuildIdentity,
} from "./domain/build-identity.ts"
export {
  createFileGitHubSourceUpdater,
  createHttpSourceUpdateExecutor,
  type GitHubSourceUpdater,
  type SourceUpdateCandidateView,
  type SourceUpdateExecutor,
  type SourceUpdateExecutorView,
  type SourceUpdateOperationView,
  type SourceUpdaterView,
} from "./domain/github-source-updater.ts"
export {
  createFileWebUiAuthentication,
  type WebUiAuthentication,
  type WebUiAuthenticationView,
  type WebUiLoginSession,
} from "./domain/webui-auth.ts"
export type { WebUiApp, WebUiOptions, WebUiServer } from "./server.ts"
export { createWebUiApp, startWebUi } from "./server.ts"
export type {
  ChallengeDetails,
  DashboardChallenge,
  DashboardChallengeStatus,
  DashboardControlPlane,
  DashboardModelAuthentication,
  DashboardModelConfiguration,
  DashboardProject,
  DashboardRun,
  DashboardScheduler,
  DashboardSnapshot,
  DashboardStats,
  ModelAuthCredentialType,
  ModelAuthenticationView,
  ModelAuthImportResult,
  ModelAuthLoginSessionView,
  ModelAuthMethodId,
  ModelAuthProviderId,
  ModelAuthProviderView,
  ModelConfigurationUpdate,
  ModelConfigurationView,
  ModelPoolEntryUpdate,
  ModelPoolEntryView,
} from "./types.ts"
