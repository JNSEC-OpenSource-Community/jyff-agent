import type {
  Announcement,
  Attachment,
  ChallengeCapability,
  ChallengeInfo,
  ChallengeSummary,
  ContestOverview,
  FlagSubmission,
  PlatformConnectOptions,
  PlatformPlugin,
  PlatformProject,
  RemoteEnvironment,
} from "@ctf-agent/platform"
import { CTFdApiError, CTFdClient } from "./client.ts"
import { ctfdConfig, type CTFdPlatformConfig } from "./config.ts"

interface CTFdChallenge {
  id: number | string
  name: string
  category: string
  value: number
  description?: string
  files?: string[]
  connection_info?: string | null
  solved_by_me?: boolean
}

interface CTFdNotification {
  id: number | string
  title: string
  content: string
  date: string
}

interface CTFdAttempt {
  status: string
  message?: string
}

interface FileBinding {
  attachment: Attachment
  location: string
}

class CTFdChallengeCapability implements ChallengeCapability {
  private info?: ChallengeInfo

  constructor(private readonly challengeId: string, private readonly client: CTFdClient) {}

  async getInfo(): Promise<ChallengeInfo> {
    if (!this.info) this.info = mapChallengeInfo(await this.detail())
    return this.info
  }

  async downloadAttachment(attachmentId: string): Promise<{ attachment: Attachment; content: Uint8Array }> {
    // Refresh details so short-lived signed file URLs are never restored from a stale session.
    const detail = await this.detail()
    const binding = fileBindings(detail.files ?? []).find((item) => item.attachment.id === attachmentId)
    if (!binding) throw new Error(`当前题不存在附件: ${attachmentId}`)
    const content = await this.client.download(binding.location)
    return { attachment: { ...binding.attachment, size: content.byteLength }, content }
  }

  async submitFlag(flag: string): Promise<FlagSubmission> {
    const attempt = await this.client.post<CTFdAttempt>("challenges/attempt", {
      challenge_id: numericId(this.challengeId),
      submission: flag,
    })
    if (attempt.status === "authentication_required") {
      throw new CTFdApiError(attempt.message ?? "CTFd 需要有效身份", "authentication", 403)
    }
    if (attempt.status === "correct") {
      return { status: "accepted", message: attempt.message ?? "Correct" }
    }
    if (attempt.status === "already_solved") {
      return { status: "already_solved", message: attempt.message ?? "Already solved" }
    }
    return { status: "rejected", message: attempt.message ?? attempt.status }
  }

  private async detail(): Promise<CTFdChallenge> {
    return await this.client.get<CTFdChallenge>(`challenges/${encodeURIComponent(this.challengeId)}`)
  }
}

class CTFdProject implements PlatformProject {
  constructor(
    private readonly project: { id: string; name: string },
    private readonly config: CTFdPlatformConfig,
    private readonly client: CTFdClient,
  ) {}

  async refresh(): Promise<ContestOverview> { return await this.getOverview() }

  async getOverview(): Promise<ContestOverview> {
    const [challenges, announcements] = await Promise.all([
      this.listChallenges(),
      this.listAnnouncements(),
    ])
    return {
      id: this.project.id,
      name: this.config.name ?? this.project.name,
      challenges: challenges.length,
      announcements: announcements.length,
    }
  }

  async listChallenges(): Promise<ChallengeSummary[]> {
    const challenges = await this.client.get<CTFdChallenge[]>("challenges")
    return challenges.map(mapChallengeSummary)
  }

  async listAnnouncements(): Promise<Announcement[]> {
    const notifications = await this.client.get<CTFdNotification[]>("notifications")
    return notifications.map((item) => ({
      id: String(item.id),
      title: item.title,
      content: item.content,
      publishedAt: item.date,
    }))
  }

  async listRemoteEnvironments(): Promise<RemoteEnvironment[]> { return [] }
  async getRemoteEnvironment(): Promise<RemoteEnvironment | null> { return null }
  async destroyRemoteEnvironment(): Promise<void> {
    throw new Error("CTFd 核心 API 不支持远程实例销毁")
  }

  async bindChallenge(challengeId: string): Promise<ChallengeCapability> {
    const capability = new CTFdChallengeCapability(challengeId, this.client)
    await capability.getInfo()
    return capability
  }

  async close(): Promise<void> {}
}

export class CTFdPlatformPlugin implements PlatformPlugin {
  readonly id = "ctfd"
  readonly config = ctfdConfig

  async connect(options: PlatformConnectOptions): Promise<PlatformProject> {
    const config = this.config.parse(options.config)
    const token = options.resolveSecret(config.tokenSecret)?.trim()
    if (!token) throw new Error(`缺少 CTFd access token secret: ${config.tokenSecret}`)
    return new CTFdProject(options.project, config, new CTFdClient(config, token))
  }
}

export const ctfdPlatform = new CTFdPlatformPlugin()
export { CTFdApiError, CTFdClient, ctfdConfig }
export type { CTFdPlatformConfig }

function mapChallengeSummary(challenge: CTFdChallenge): ChallengeSummary {
  return {
    id: String(challenge.id),
    title: challenge.name,
    category: challenge.category,
    score: challenge.value,
    solved: challenge.solved_by_me === true,
  }
}

function mapChallengeInfo(challenge: CTFdChallenge): ChallengeInfo {
  return {
    ...mapChallengeSummary(challenge),
    description: challenge.description ?? "",
    attachments: fileBindings(challenge.files ?? []).map((item) => item.attachment),
    ...(challenge.connection_info ? { environmentGuide: challenge.connection_info } : {}),
  }
}

function fileBindings(files: readonly string[]): FileBinding[] {
  return files.map((location, index) => ({
    attachment: {
      id: `file-${index + 1}`,
      name: fileName(location, index),
    },
    location,
  }))
}

function fileName(location: string, index: number): string {
  try {
    const pathname = new URL(location, "https://ctfd.invalid/").pathname
    const segment = pathname.split("/").filter(Boolean).at(-1)
    return segment ? decodeURIComponent(segment) : `attachment-${index + 1}`
  } catch {
    return `attachment-${index + 1}`
  }
}

function numericId(id: string): number | string {
  return /^\d+$/.test(id) ? Number(id) : id
}
