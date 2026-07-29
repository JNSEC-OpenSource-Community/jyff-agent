import { randomUUID } from "node:crypto"
import type {
  Announcement,
  Attachment,
  ChallengeCapability,
  ChallengeInfo,
  ChallengeSummary,
  ContestOverview,
  FlagSubmission,
  PlatformPlugin,
  PlatformProject,
  RemoteEnvironment,
} from "@ctf-agent/solver"

export interface MockChallenge {
  id: string
  title: string
  category: string
  score: number
  description: string
  attachments: Array<{ id: string; name: string; content: string }>
  flag: string
  remote?: boolean
}

export interface MockPlatformConfig {
  name?: string
  challenges?: MockChallenge[]
  announcements?: Announcement[]
}

const defaults: MockChallenge[] = [{
  id: "warmup-flag",
  title: "Warmup Flag",
  category: "misc",
  score: 100,
  description: "附件中藏着本题 Flag。下载附件并读取它。",
  attachments: [{ id: "flag.txt", name: "flag.txt", content: "TU9DS3twbGF0Zm9ybS1wbHVnaW4td29ya3N9Cg==\n" }],
  flag: "MOCK{platform-plugin-works}",
}]

function copyInfo(challenge: MockChallenge): ChallengeInfo {
  const attachments: Attachment[] = challenge.attachments.map((attachment) => ({
    id: attachment.id,
    name: attachment.name,
    size: Buffer.byteLength(attachment.content),
  }))
  return {
    id: challenge.id,
    title: challenge.title,
    category: challenge.category,
    score: challenge.score,
    description: challenge.description,
    attachments,
  }
}

class MockContest implements PlatformProject {
  private readonly challenges: MockChallenge[]
  private readonly announcements: Announcement[]
  private readonly environments = new Map<string, RemoteEnvironment>()
  private readonly solved = new Set<string>()

  constructor(private readonly eventId: string, config: MockPlatformConfig) {
    this.challenges = config.challenges ?? defaults
    this.announcements = config.announcements ?? []
  }

  async refresh(): Promise<ContestOverview> { return this.getOverview() }

  async getOverview(): Promise<ContestOverview> {
    return { id: this.eventId, name: "Mock CTF", challenges: this.challenges.length, announcements: this.announcements.length }
  }

  async listChallenges(): Promise<ChallengeSummary[]> {
    return this.challenges.map((challenge) => ({ ...copyInfo(challenge), attachments: undefined, description: undefined, solved: this.solved.has(challenge.id) }))
      .map(({ attachments: _attachments, description: _description, ...summary }) => summary)
  }

  async listAnnouncements(): Promise<Announcement[]> { return [...this.announcements] }
  async listRemoteEnvironments(): Promise<RemoteEnvironment[]> { return [...this.environments.values()] }
  async getRemoteEnvironment(id: string): Promise<RemoteEnvironment | null> { return this.environments.get(id) ?? null }

  async destroyRemoteEnvironment(id: string): Promise<void> {
    const environment = this.environments.get(id)
    if (!environment) return
    this.environments.set(id, { ...environment, status: "stopped" })
  }

  async bindChallenge(challengeId: string): Promise<ChallengeCapability> {
    const challenge = this.challenges.find((item) => item.id === challengeId)
    if (!challenge) throw new Error(`Mock 平台不存在题目: ${challengeId}`)

    const capability: ChallengeCapability = {
      getInfo: async () => copyInfo(challenge),
      downloadAttachment: async (attachmentId) => {
        const attachment = challenge.attachments.find((item) => item.id === attachmentId)
        if (!attachment) throw new Error(`当前题不存在附件: ${attachmentId}`)
        if (attachment.name.includes("/") || attachment.name.includes("\\") || attachment.name === "." || attachment.name === "..") {
          throw new Error("附件文件名不安全")
        }
        return {
          attachment: { id: attachment.id, name: attachment.name, size: Buffer.byteLength(attachment.content) },
          content: new TextEncoder().encode(attachment.content),
        }
      },
      submitFlag: async (flag): Promise<FlagSubmission> => {
        if (this.solved.has(challenge.id)) return { status: "already_solved", message: "该题已经解决" }
        if (flag.trim() !== challenge.flag) return { status: "rejected", message: "Flag 不正确" }
        this.solved.add(challenge.id)
        return { status: "accepted", message: "Flag accepted" }
      },
    }

    if (challenge.remote) {
      capability.instance = {
        start: async () => {
          const existing = [...this.environments.values()].find((item) => item.challengeId === challenge.id && item.status === "running")
          if (existing) return existing
          const environment: RemoteEnvironment = {
            id: randomUUID(), challengeId: challenge.id, status: "running", endpoint: `mock://${challenge.id}`,
          }
          this.environments.set(environment.id, environment)
          return environment
        },
        status: async () => [...this.environments.values()].find((item) => item.challengeId === challenge.id && item.status === "running") ?? null,
        destroy: async () => {
          const current = [...this.environments.values()].find((item) => item.challengeId === challenge.id && item.status === "running")
          if (current) this.environments.set(current.id, { ...current, status: "stopped" })
        },
      }
    }
    return capability
  }

  async close(): Promise<void> { }
}

export class MockPlatformPlugin implements PlatformPlugin {
  readonly id = "mock"

  async connect(options: { eventId: string; config: unknown }): Promise<PlatformProject> {
    const config = options.config as MockPlatformConfig
    return new MockContest(options.eventId, config ?? {})
  }
}

export const mockPlatform = new MockPlatformPlugin()
