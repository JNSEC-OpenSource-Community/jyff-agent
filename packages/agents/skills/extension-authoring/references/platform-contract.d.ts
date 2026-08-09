export interface Attachment {
  id: string
  name: string
  size?: number
}

export interface ChallengeSummary {
  id: string
  title: string
  category: string
  score: number
  solved?: boolean
  needsEnv?: boolean
}

export interface ChallengeInfo extends ChallengeSummary {
  description: string
  attachments: Attachment[]
  environmentGuide?: string
}

export interface Announcement {
  id: string
  title: string
  content: string
  publishedAt: string
  kind?: "normal" | "hint" | "new_challenge" | "solve_broadcast" | "unknown"
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

export interface ChallengeCapability {
  getInfo(): Promise<ChallengeInfo>
  downloadAttachment(
    attachmentId: string,
  ): Promise<{ attachment: Attachment; content: Uint8Array }>
  submitFlag(flag: string): Promise<FlagSubmission>
  instance?: {
    start(signal?: AbortSignal): Promise<RemoteEnvironment>
    status(): Promise<RemoteEnvironment | null>
    destroy(): Promise<void>
  }
}

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

export interface PlatformPlugin {
  readonly id: string
  readonly config: { parse(value: unknown): unknown }
  readonly setup?: PlatformSetupDescriptor
  connect(options: {
    project: { id: string; name: string }
    config: unknown
    resolveSecret(name: string): string | undefined
  }): Promise<PlatformProject>
}
