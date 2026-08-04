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
import { GZCTFApiError, GZCTFClient } from "./client.ts"
import { gzctfConfig, type GZCTFPlatformConfig } from "./config.ts"

interface GZCTFGame {
  id?: number
  title?: string
}

interface GZCTFChallengeSummary {
  id: number
  title: string
  category: string
  score: number
}

interface GZCTFSolvedChallenge {
  id: number
}

interface GZCTFGameDetails {
  challenges?: Record<string, GZCTFChallengeSummary[]>
  challengeCount?: number
  rank?: { solvedChallenges?: GZCTFSolvedChallenge[] } | null
}

interface GZCTFChallengeDetail {
  id?: number
  title?: string
  content?: string
  category?: string
  hints?: string[] | null
  score?: number
  type?: "StaticAttachment" | "StaticContainer" | "DynamicAttachment" | "DynamicContainer"
  context?: {
    closeTime?: number | null
    instanceEntry?: string | null
    url?: string | null
    fileSize?: number | null
  }
}

interface GZCTFNotice {
  id: number
  time: number
  type: string
  values: string[]
}

interface GZCTFContainer {
  status?: "Pending" | "Running" | "Destroyed"
  entry?: string
}

const noticeTitles: Record<string, string> = {
  Normal: "比赛公告",
  FirstBlood: "一血",
  SecondBlood: "二血",
  ThirdBlood: "三血",
  NewHint: "新提示",
  NewChallenge: "新题目",
}

class GZCTFChallengeCapability implements ChallengeCapability {
  readonly instance?: ChallengeCapability["instance"]
  private info?: ChallengeInfo
  private solved: boolean

  constructor(
    private readonly gameId: number,
    private readonly challengeId: number,
    private readonly client: GZCTFClient,
    private readonly config: GZCTFPlatformConfig,
    solved: boolean,
    detail: GZCTFChallengeDetail,
    private readonly environments: Map<string, RemoteEnvironment>,
  ) {
    this.solved = solved
    this.info = mapChallengeInfo(detail, solved)
    if (isContainer(detail.type)) {
      this.instance = {
        start: async () => {
          const container = await this.client.post<GZCTFContainer>(this.containerPath())
          return this.remember(mapContainer(this.environmentId(), this.challengeId, container))
        },
        status: async () => await this.getInstanceStatus(),
        destroy: async () => await this.destroyInstance(),
      }
    }
  }

  async getInfo(): Promise<ChallengeInfo> {
    if (!this.info) this.info = mapChallengeInfo(await this.detail(), this.solved)
    return this.info
  }

  async downloadAttachment(attachmentId: string): Promise<{ attachment: Attachment; content: Uint8Array }> {
    if (attachmentId !== "attachment") throw new Error(`当前题不存在附件: ${attachmentId}`)
    const detail = await this.detail()
    const location = detail.context?.url
    if (!location) throw new Error("当前题没有可下载的附件")
    const content = await this.client.download(location)
    const attachment = attachmentFor(detail, content.byteLength)
    if (!attachment) throw new Error("GZCTF 题目附件信息无效")
    return { attachment, content }
  }

  async submitFlag(flag: string): Promise<FlagSubmission> {
    if (this.solved) return { status: "already_solved", message: "Already solved" }
    const encrypted = await this.client.encrypt(flag)
    const submitId = await this.client.post<number>(this.challengePath(), { flag: encrypted })
    if (!Number.isInteger(submitId) || submitId < 1) {
      throw new GZCTFApiError("GZCTF 提交响应缺少有效 submission id", "protocol")
    }

    const deadline = Date.now() + this.config.submissionTimeoutMs
    while (Date.now() < deadline) {
      const status = await this.client.get<string>(`${this.challengePath()}/status/${submitId}`)
      if (status === "Accepted") {
        this.solved = true
        return { status: "accepted", message: "Accepted" }
      }
      if (status === "WrongAnswer" || status === "CheatDetected" || status === "NotFound") {
        return { status: "rejected", message: status }
      }
      if (status !== "FlagSubmitted") {
        throw new GZCTFApiError(`GZCTF 返回了未知判题状态: ${status}`, "protocol")
      }
      await delay(Math.min(this.config.submissionPollIntervalMs, Math.max(0, deadline - Date.now())))
    }
    throw new GZCTFApiError(`GZCTF 判题超过 ${this.config.submissionTimeoutMs}ms`, "network")
  }

  private async detail(): Promise<GZCTFChallengeDetail> {
    return await this.client.get<GZCTFChallengeDetail>(this.challengePath())
  }

  private async getInstanceStatus(): Promise<RemoteEnvironment | null> {
    const detail = await this.detail()
    const context = detail.context
    if (!context?.instanceEntry && !context?.closeTime) {
      this.environments.delete(this.environmentId())
      return null
    }
    return this.remember({
      id: this.environmentId(),
      challengeId: String(this.challengeId),
      status: context.instanceEntry ? "running" : "starting",
      ...(context.instanceEntry ? { endpoint: context.instanceEntry } : {}),
    })
  }

  private async destroyInstance(): Promise<void> {
    // Solver shutdown calls destroy for every container-capable challenge. Avoid
    // turning "never started" into a noisy platform error.
    if (!await this.getInstanceStatus()) return
    await this.client.delete(this.containerPath())
    this.environments.delete(this.environmentId())
  }

  private remember(environment: RemoteEnvironment): RemoteEnvironment {
    this.environments.set(environment.id, environment)
    return environment
  }

  private environmentId(): string { return `${this.gameId}:${this.challengeId}` }
  private challengePath(): string { return `game/${this.gameId}/challenges/${this.challengeId}` }
  private containerPath(): string { return `game/${this.gameId}/container/${this.challengeId}` }
}

class GZCTFProject implements PlatformProject {
  private readonly environments = new Map<string, RemoteEnvironment>()

  constructor(
    private readonly project: { id: string; name: string },
    private readonly config: GZCTFPlatformConfig,
    private readonly client: GZCTFClient,
  ) {}

  async refresh(): Promise<ContestOverview> { return await this.getOverview() }

  async getOverview(): Promise<ContestOverview> {
    const [game, challenges, announcements] = await Promise.all([
      this.client.get<GZCTFGame>(`game/${this.config.gameId}`),
      this.listChallenges(),
      this.listAnnouncements(),
    ])
    return {
      id: this.project.id,
      name: this.config.name ?? game.title ?? this.project.name,
      challenges: challenges.length,
      announcements: announcements.length,
    }
  }

  async listChallenges(): Promise<ChallengeSummary[]> {
    const details = await this.gameDetails()
    const solved = new Set(details.rank?.solvedChallenges?.map((item) => item.id) ?? [])
    return Object.values(details.challenges ?? {}).flat().map((challenge) => ({
      id: String(challenge.id),
      title: challenge.title,
      category: challenge.category,
      score: challenge.score,
      solved: solved.has(challenge.id),
    }))
  }

  async listAnnouncements(): Promise<Announcement[]> {
    const notices = await this.client.get<GZCTFNotice[]>(`game/${this.config.gameId}/notices?count=100&skip=0`)
    return notices.map((notice) => ({
      id: String(notice.id),
      title: noticeTitles[notice.type] ?? notice.type,
      content: notice.values.join(" · "),
      publishedAt: new Date(notice.time).toISOString(),
    }))
  }

  async listRemoteEnvironments(): Promise<RemoteEnvironment[]> {
    const ids = [...this.environments.keys()]
    const current = await Promise.all(ids.map(async (id) => await this.getRemoteEnvironment(id)))
    return current.filter((item): item is RemoteEnvironment => item !== null)
  }

  async getRemoteEnvironment(id: string): Promise<RemoteEnvironment | null> {
    const challengeId = parseEnvironmentId(id, this.config.gameId)
    if (challengeId === null || !this.environments.has(id)) return null
    const capability = await this.bindChallenge(String(challengeId))
    return capability.instance ? await capability.instance.status() : null
  }

  async destroyRemoteEnvironment(id: string): Promise<void> {
    const challengeId = parseEnvironmentId(id, this.config.gameId)
    if (challengeId === null || !this.environments.has(id)) throw new Error(`未知 GZCTF 远程实例: ${id}`)
    const capability = await this.bindChallenge(String(challengeId))
    if (!capability.instance) throw new Error(`GZCTF 题目 ${challengeId} 不是容器题`)
    await capability.instance.destroy()
  }

  async bindChallenge(challengeId: string): Promise<ChallengeCapability> {
    const id = positiveId(challengeId)
    const [detail, game] = await Promise.all([
      this.client.get<GZCTFChallengeDetail>(`game/${this.config.gameId}/challenges/${id}`),
      this.gameDetails(),
    ])
    const solved = game.rank?.solvedChallenges?.some((item) => item.id === id) === true
    return new GZCTFChallengeCapability(
      this.config.gameId, id, this.client, this.config, solved, detail, this.environments,
    )
  }

  async close(): Promise<void> {}

  private async gameDetails(): Promise<GZCTFGameDetails> {
    return await this.client.get<GZCTFGameDetails>(`game/${this.config.gameId}/details`)
  }
}

export class GZCTFPlatformPlugin implements PlatformPlugin {
  readonly id = "gzctf"
  readonly config = gzctfConfig

  async connect(options: PlatformConnectOptions): Promise<PlatformProject> {
    const config = this.config.parse(options.config)
    const credentials = resolveCredentials(config, options.resolveSecret)
    const client = await GZCTFClient.connect(config, credentials)
    return new GZCTFProject(options.project, config, client)
  }
}

export const gzctfPlatform = new GZCTFPlatformPlugin()
export { encryptGZCTFApiData } from "./crypto.ts"
export { GZCTFApiError, GZCTFClient } from "./client.ts"
export { gzctfConfig } from "./config.ts"
export type { GZCTFAuthConfig, GZCTFPlatformConfig } from "./config.ts"

function resolveCredentials(
  config: GZCTFPlatformConfig,
  resolveSecret: (name: string) => string | undefined,
): { type: "password"; username: string; password: string } | { type: "cookie"; cookie: string } {
  if (config.auth.type === "cookie") {
    const cookie = resolveSecret(config.auth.cookieSecret)?.trim()
    if (!cookie) throw new Error(`缺少 GZCTF Cookie secret: ${config.auth.cookieSecret}`)
    return { type: "cookie", cookie }
  }
  const username = resolveSecret(config.auth.usernameSecret)?.trim()
  const password = resolveSecret(config.auth.passwordSecret)
  if (!username) throw new Error(`缺少 GZCTF username secret: ${config.auth.usernameSecret}`)
  if (!password) throw new Error(`缺少 GZCTF password secret: ${config.auth.passwordSecret}`)
  return { type: "password", username, password }
}

function mapChallengeInfo(detail: GZCTFChallengeDetail, solved: boolean): ChallengeInfo {
  const context = detail.context
  const attachment = attachmentFor(detail)
  const hints = detail.hints?.length ? `\n\n## Hints\n\n${detail.hints.map((hint) => `- ${hint}`).join("\n")}` : ""
  return {
    id: String(detail.id ?? ""),
    title: detail.title ?? `Challenge ${detail.id ?? ""}`,
    category: detail.category ?? "unknown",
    score: detail.score ?? 0,
    solved,
    ...(isContainer(detail.type) ? { needsEnv: true } : {}),
    description: `${detail.content ?? ""}${hints}`,
    attachments: attachment ? [attachment] : [],
    ...(context?.instanceEntry ? { environmentGuide: context.instanceEntry } : {}),
  }
}

function attachmentFor(detail: GZCTFChallengeDetail, downloadedSize?: number): Attachment | undefined {
  const location = detail.context?.url
  if (!location) return undefined
  let name = "attachment"
  try {
    const segment = new URL(location, "https://gzctf.invalid/").pathname.split("/").filter(Boolean).at(-1)
    if (segment) name = decodeURIComponent(segment)
  } catch {
    // The download path remains authoritative even when its display name is malformed.
  }
  const size = downloadedSize ?? detail.context?.fileSize ?? undefined
  return { id: "attachment", name, ...(size === undefined ? {} : { size }) }
}

function mapContainer(id: string, challengeId: number, container: GZCTFContainer): RemoteEnvironment {
  return {
    id,
    challengeId: String(challengeId),
    status: container.status === "Running" ? "running" : container.status === "Destroyed" ? "stopped" : "starting",
    ...(container.entry ? { endpoint: container.entry } : {}),
  }
}

function isContainer(type: GZCTFChallengeDetail["type"]): boolean {
  return type === "StaticContainer" || type === "DynamicContainer"
}

function positiveId(value: string): number {
  if (!/^\d+$/.test(value) || Number(value) < 1) throw new Error(`GZCTF challenge id 无效: ${value}`)
  return Number(value)
}

function parseEnvironmentId(value: string, gameId: number): number | null {
  const match = new RegExp(`^${gameId}:(\\d+)$`).exec(value)
  return match?.[1] ? Number(match[1]) : null
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms))
}
