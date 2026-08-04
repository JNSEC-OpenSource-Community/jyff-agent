export interface Attachment {
  id: string
  name: string
  size: number
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

export interface Announcement {
  id: string
  title: string
  content: string
  publishedAt: string
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
  downloadAttachment(attachmentId: string): Promise<{ attachment: Attachment; content: Uint8Array }>
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

export interface PlatformPlugin {
  readonly id: string
  connect(options: { eventId: string; config: unknown }): Promise<PlatformProject>
}
