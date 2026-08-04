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
  /** 是否需要申请远程环境(ctf_instance_start);缺失按 false 处理 */
  needsEnv?: boolean
}

export interface ChallengeInfo extends ChallengeSummary {
  description: string
  attachments: Attachment[]
  /** 平台提供的环境使用指引(远程题如何申请/连接/找 flag 的平台特定说明);缺失表示无附加指引 */
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

/** 该接口只会绑定一个题目，禁止设计任何 challengeId 入参。 */
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

/** Project 层的完整平台视图，绝不传给 Solver。 */
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
