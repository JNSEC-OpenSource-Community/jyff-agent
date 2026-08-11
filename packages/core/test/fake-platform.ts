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

export interface TestChallenge {
  id: string
  title: string
  category: string
  score: number
  description: string
  attachments: Array<{ id: string; name: string; content: string }>
  flag: string
  remote?: boolean
  failures?: Partial<Record<"bind" | "getInfo" | "download" | "submit" | "instanceStart", number>>
  retryableFailures?: Partial<
    Record<"bind" | "getInfo" | "download" | "submit" | "instanceStart", boolean>
  >
}

interface TestPlatformConfig {
  name?: string
  challenges?: TestChallenge[]
  announcements?: Announcement[]
}

export interface TestPlatformDiagnostics {
  bindAttempts: Record<string, number>
  submissions: Record<string, number>
  instanceStarts: number
  instanceDestroys: number
  activeEnvironments: number
  maxActiveEnvironments: number
}

type FailureKind = keyof NonNullable<TestChallenge["failures"]>

const defaultChallenges: TestChallenge[] = [
  {
    id: "warmup-flag",
    title: "Warmup Flag",
    category: "misc",
    score: 100,
    description: "Read the attachment and submit its flag.",
    attachments: [{ id: "flag.txt", name: "flag.txt", content: "TEST{fixture}" }],
    flag: "TEST{fixture}",
  },
]

class TestPlatformProject implements PlatformProject {
  private readonly challenges: TestChallenge[]
  private readonly announcements: Announcement[]
  private readonly solved = new Set<string>()
  private readonly environments = new Map<string, RemoteEnvironment>()
  private readonly remainingFailures = new Map<string, Record<FailureKind, number>>()
  private readonly bindAttempts = new Map<string, number>()
  private readonly submissions = new Map<string, number>()
  private instanceStarts = 0
  private instanceDestroys = 0
  private maxActiveEnvironments = 0

  constructor(
    private readonly project: { id: string; name: string },
    private readonly name: string,
    config: TestPlatformConfig,
  ) {
    this.challenges = config.challenges ?? defaultChallenges
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

  async refresh(): Promise<ContestOverview> {
    return await this.getOverview()
  }

  async getOverview(): Promise<ContestOverview> {
    return {
      id: this.project.id,
      name: this.name,
      challenges: this.challenges.length,
      announcements: this.announcements.length,
    }
  }

  async listChallenges(): Promise<ChallengeSummary[]> {
    return this.challenges.map((challenge) => ({
      id: challenge.id,
      title: challenge.title,
      category: challenge.category,
      score: challenge.score,
      solved: this.solved.has(challenge.id),
      ...(challenge.remote ? { needsEnv: true } : {}),
    }))
  }

  async listAnnouncements(): Promise<Announcement[]> {
    return [...this.announcements]
  }
  async listRemoteEnvironments(): Promise<RemoteEnvironment[]> {
    return [...this.environments.values()]
  }
  async getRemoteEnvironment(id: string): Promise<RemoteEnvironment | null> {
    return this.environments.get(id) ?? null
  }

  async destroyRemoteEnvironment(id: string): Promise<void> {
    const environment = this.environments.get(id)
    if (!environment || environment.status === "stopped") return
    this.environments.set(id, { ...environment, status: "stopped" })
    this.instanceDestroys++
  }

  async bindChallenge(challengeId: string): Promise<ChallengeCapability> {
    const challenge = this.challenges.find((candidate) => candidate.id === challengeId)
    if (!challenge) throw new Error(`测试平台不存在题目: ${challengeId}`)
    this.bindAttempts.set(challengeId, (this.bindAttempts.get(challengeId) ?? 0) + 1)
    this.fail(challenge, "bind")

    const capability: ChallengeCapability = {
      getInfo: async () => {
        this.fail(challenge, "getInfo")
        return challengeInfo(challenge, this.solved.has(challenge.id))
      },
      downloadAttachment: async (attachmentId) => {
        this.fail(challenge, "download")
        const attachment = challenge.attachments.find((candidate) => candidate.id === attachmentId)
        if (!attachment) throw new Error(`当前题不存在附件: ${attachmentId}`)
        const content = new TextEncoder().encode(attachment.content)
        return {
          attachment: {
            id: attachment.id,
            name: attachment.name,
            size: content.byteLength,
          },
          content,
        }
      },
      submitFlag: async (flag): Promise<FlagSubmission> => {
        this.submissions.set(challenge.id, (this.submissions.get(challenge.id) ?? 0) + 1)
        this.fail(challenge, "submit")
        if (this.solved.has(challenge.id))
          return { status: "already_solved", message: "Already solved" }
        if (flag.trim() !== challenge.flag) return { status: "rejected", message: "Incorrect" }
        this.solved.add(challenge.id)
        return { status: "accepted", message: "Accepted" }
      },
    }

    if (challenge.remote) {
      capability.instance = {
        start: async () => {
          this.fail(challenge, "instanceStart")
          const running = this.running(challenge.id)
          if (running) return running
          const environment: RemoteEnvironment = {
            id: `${challenge.id}-${this.instanceStarts + 1}`,
            challengeId: challenge.id,
            status: "running",
            endpoint: `test://${challenge.id}`,
          }
          this.environments.set(environment.id, environment)
          this.instanceStarts++
          this.maxActiveEnvironments = Math.max(this.maxActiveEnvironments, this.activeCount())
          return environment
        },
        status: async () => this.running(challenge.id) ?? null,
        destroy: async () => {
          const current = this.running(challenge.id)
          if (!current) return
          this.environments.set(current.id, { ...current, status: "stopped" })
          this.instanceDestroys++
        },
      }
    }
    return capability
  }

  diagnostics(): TestPlatformDiagnostics {
    return {
      bindAttempts: Object.fromEntries(this.bindAttempts),
      submissions: Object.fromEntries(this.submissions),
      instanceStarts: this.instanceStarts,
      instanceDestroys: this.instanceDestroys,
      activeEnvironments: this.activeCount(),
      maxActiveEnvironments: this.maxActiveEnvironments,
    }
  }

  async close(): Promise<void> {}

  private running(challengeId: string): RemoteEnvironment | undefined {
    return [...this.environments.values()].find(
      (environment) => environment.challengeId === challengeId && environment.status === "running",
    )
  }

  private activeCount(): number {
    return [...this.environments.values()].filter((environment) => environment.status === "running")
      .length
  }

  private fail(challenge: TestChallenge, kind: FailureKind): void {
    const failures = this.remainingFailures.get(challenge.id)
    const remaining = failures?.[kind] ?? 0
    if (!failures || remaining < 1) return
    failures[kind] = remaining - 1
    throw Object.assign(new Error(`测试故障: ${challenge.id}.${kind}`), {
      retryable: challenge.retryableFailures?.[kind] === true,
    })
  }
}

export class TestPlatformPlugin implements PlatformPlugin {
  readonly id = "test"
  readonly config = { parse: parseConfig }
  private connected?: TestPlatformProject

  async connect(options: PlatformConnectOptions): Promise<PlatformProject> {
    const config = parseConfig(options.config)
    this.connected = new TestPlatformProject(
      options.project,
      config.name ?? options.project.name,
      config,
    )
    return this.connected
  }

  diagnostics(): TestPlatformDiagnostics {
    if (!this.connected) throw new Error("测试平台尚未连接")
    return this.connected.diagnostics()
  }
}

export const testPlatform = new TestPlatformPlugin()

function parseConfig(value: unknown): TestPlatformConfig {
  if (value === undefined) return {}
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("测试平台配置必须是对象")
  return value as TestPlatformConfig
}

function challengeInfo(challenge: TestChallenge, solved: boolean): ChallengeInfo {
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
    solved,
    ...(challenge.remote ? { needsEnv: true } : {}),
    description: challenge.description,
    attachments,
  }
}
