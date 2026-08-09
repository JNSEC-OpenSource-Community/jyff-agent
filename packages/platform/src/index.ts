export interface Attachment {
  id: string
  name: string
  /** Some platforms only reveal the size after download. */
  size?: number
}

export interface ChallengeSummary {
  id: string
  title: string
  category: string
  score: number
  solved?: boolean
  /** Whether this challenge exposes a remotely managed environment. */
  needsEnv?: boolean
}

export interface ChallengeInfo extends ChallengeSummary {
  description: string
  attachments: Attachment[]
  environmentGuide?: string
}

export type AnnouncementKind =
  | "normal"
  | "hint"
  | "new_challenge"
  | "solve_broadcast"
  | "unknown"

export interface Announcement {
  id: string
  title: string
  content: string
  publishedAt: string
  kind?: AnnouncementKind
  rawType?: string
}

export interface ContestOverview {
  id: string
  name: string
  challenges: number
  announcements: number
}

export interface RemoteEnvironment {
  id: string
  challengeId: string
  status: "starting" | "running" | "stopped"
  endpoint?: string
}

export interface FlagSubmission {
  status: "accepted" | "rejected" | "already_solved"
  message: string
}

/** A challenge-scoped capability. Methods intentionally take no challenge id. */
export interface ChallengeCapability {
  getInfo(): Promise<ChallengeInfo>
  downloadAttachment(
    attachmentId: string,
  ): Promise<{ attachment: Attachment; content: Uint8Array }>
  submitFlag(flag: string): Promise<FlagSubmission>
  instance?: {
    start(): Promise<RemoteEnvironment>
    status(): Promise<RemoteEnvironment | null>
    destroy(): Promise<void>
  }
}

/** Full contest control plane. This capability must never be passed to an agent. */
export interface PlatformProject {
  refresh(): Promise<ContestOverview>
  getOverview(): Promise<ContestOverview>
  listChallenges(): Promise<ChallengeSummary[]>
  listAnnouncements(): Promise<Announcement[]>
  listRemoteEnvironments(): Promise<RemoteEnvironment[]>
  getRemoteEnvironment(id: string): Promise<RemoteEnvironment | null>
  destroyRemoteEnvironment(id: string): Promise<void>
  bindChallenge(challengeId: string): Promise<ChallengeCapability>
  close(): Promise<void>
}

export interface PlatformConfig<T = unknown> {
  parse(value: unknown): T
}

export interface PlatformSetupField {
  key: string
  label: string
  type: "text" | "url" | "integer"
  required: boolean
  placeholder?: string
  minimum?: number
  maximum?: number
}

export interface PlatformSecretField {
  name: string
  label: string
  type: "text" | "password" | "token" | "cookie"
  required: boolean
}

export interface PlatformAuthStrategy {
  id: string
  label: string
  config: Record<string, unknown>
  secrets: readonly PlatformSecretField[]
}

export interface PlatformSetupDescriptor {
  label: string
  description: string
  defaultConfig: Record<string, unknown>
  fields: readonly PlatformSetupField[]
  authStrategies: readonly PlatformAuthStrategy[]
}

export interface PlatformConnectOptions<T = unknown> {
  project: { id: string; name: string }
  config: T
  resolveSecret(name: string): string | undefined
}

/**
 * Runtime-erased platform plugin contract. A plugin owns validation of its
 * configuration; Project only selects the plugin and supplies secrets.
 */
export interface PlatformPlugin {
  readonly id: string
  readonly config: PlatformConfig
  readonly setup?: PlatformSetupDescriptor
  connect(options: PlatformConnectOptions): Promise<PlatformProject>
}

/**
 * Platform adapters mark failures that are safe to retry without charging an
 * Agent attempt. Keep the check structural so Core does not depend on a
 * concrete platform error class.
 */
export function isRetryablePlatformError(error: unknown): boolean {
  if (
    error &&
    typeof error === "object" &&
    (error as { retryable?: unknown }).retryable === true
  ) {
    return true
  }
  if (error instanceof AggregateError) {
    return (
      error.errors.length > 0 &&
      error.errors.every((item) => isRetryablePlatformError(item))
    )
  }
  if (!error || typeof error !== "object") return false
  const cause = (error as { cause?: unknown }).cause
  return cause !== undefined && isRetryablePlatformError(cause)
}

export * from "./ctfd.ts"
export * from "./gzctf.ts"
export * from "./registry.ts"
export * from "./validation.ts"
