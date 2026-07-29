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
  failures?: {
    bind?: number
    getInfo?: number
    download?: number
    submit?: number
    instanceStart?: number
  }
}

export interface MockPlatformConfig {
  name?: string
  challenges?: MockChallenge[]
  announcements?: Announcement[]
}

export interface MockPlatformDiagnostics {
  bindAttempts: Record<string, number>
  submissions: Record<string, number>
  instanceStarts: number
  instanceDestroys: number
  activeEnvironments: number
  maxActiveEnvironments: number
}

type FailureKind = keyof NonNullable<MockChallenge["failures"]>

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

export class MockContest implements PlatformProject {
  private readonly challenges: MockChallenge[]
  private readonly announcements: Announcement[]
  private readonly environments = new Map<string, RemoteEnvironment>()
  private readonly solved = new Set<string>()
  private readonly remainingFailures = new Map<string, Record<FailureKind, number>>()
  private readonly bindAttempts = new Map<string, number>()
  private readonly submissions = new Map<string, number>()
  private instanceStarts = 0
  private instanceDestroys = 0
  private maxActiveEnvironments = 0

  constructor(private readonly eventId: string, config: MockPlatformConfig) {
    this.challenges = config.challenges ?? defaults
    this.announcements = config.announcements ?? []
    for (const challenge of this.challenges) {
      this.remainingFailures.set(challenge.id, {
        bind: challenge.failures?.bind ?? 0,
        getInfo: challenge.failures?.getInfo ?? 0,
        download: challenge.failures?.download ?? 0,
        submit: challenge.failures?.submit ?? 0,
        instanceStart: challenge.failures?.instanceStart ?? 0,
      })
    }
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
    if (!environment || environment.status === "stopped") return
    this.environments.set(id, { ...environment, status: "stopped" })
    this.instanceDestroys++
  }

  async bindChallenge(challengeId: string): Promise<ChallengeCapability> {
    const challenge = this.challenges.find((item) => item.id === challengeId)
    if (!challenge) throw new Error(`Mock 平台不存在题目: ${challengeId}`)
    this.bindAttempts.set(challengeId, (this.bindAttempts.get(challengeId) ?? 0) + 1)
    this.fail(challenge, "bind")

    const capability: ChallengeCapability = {
      getInfo: async () => {
        this.fail(challenge, "getInfo")
        return copyInfo(challenge)
      },
      downloadAttachment: async (attachmentId) => {
        this.fail(challenge, "download")
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
        this.submissions.set(challenge.id, (this.submissions.get(challenge.id) ?? 0) + 1)
        this.fail(challenge, "submit")
        if (this.solved.has(challenge.id)) return { status: "already_solved", message: "该题已经解决" }
        if (flag.trim() !== challenge.flag) return { status: "rejected", message: "Flag 不正确" }
        this.solved.add(challenge.id)
        return { status: "accepted", message: "Flag accepted" }
      },
    }

    if (challenge.remote) {
      capability.instance = {
        start: async () => {
          this.fail(challenge, "instanceStart")
          const existing = [...this.environments.values()].find((item) => item.challengeId === challenge.id && item.status === "running")
          if (existing) return existing
          const environment: RemoteEnvironment = {
            id: randomUUID(), challengeId: challenge.id, status: "running", endpoint: `mock://${challenge.id}`,
          }
          this.environments.set(environment.id, environment)
          this.instanceStarts++
          this.maxActiveEnvironments = Math.max(this.maxActiveEnvironments, this.activeEnvironmentCount())
          return environment
        },
        status: async () => [...this.environments.values()].find((item) => item.challengeId === challenge.id && item.status === "running") ?? null,
        destroy: async () => {
          const current = [...this.environments.values()].find((item) => item.challengeId === challenge.id && item.status === "running")
          if (current) {
            this.environments.set(current.id, { ...current, status: "stopped" })
            this.instanceDestroys++
          }
        },
      }
    }
    return capability
  }

  diagnostics(): MockPlatformDiagnostics {
    return {
      bindAttempts: Object.fromEntries(this.bindAttempts),
      submissions: Object.fromEntries(this.submissions),
      instanceStarts: this.instanceStarts,
      instanceDestroys: this.instanceDestroys,
      activeEnvironments: this.activeEnvironmentCount(),
      maxActiveEnvironments: this.maxActiveEnvironments,
    }
  }

  async close(): Promise<void> { }

  private activeEnvironmentCount(): number {
    return [...this.environments.values()].filter((environment) => environment.status === "running").length
  }

  private fail(challenge: MockChallenge, kind: FailureKind): void {
    const failures = this.remainingFailures.get(challenge.id)
    const remaining = failures?.[kind] ?? 0
    if (remaining <= 0 || !failures) return
    failures[kind] = remaining - 1
    throw new Error(`Mock 注入故障: ${challenge.id}.${kind}`)
  }
}

export class MockPlatformPlugin implements PlatformPlugin {
  readonly id = "mock"
  private contest?: MockContest

  async connect(options: { eventId: string; config: unknown }): Promise<PlatformProject> {
    const config = options.config as MockPlatformConfig
    this.contest = new MockContest(options.eventId, config ?? {})
    return this.contest
  }

  diagnostics(): MockPlatformDiagnostics {
    if (!this.contest) throw new Error("Mock 平台尚未连接")
    return this.contest.diagnostics()
  }
}

export const mockPlatform = new MockPlatformPlugin()
