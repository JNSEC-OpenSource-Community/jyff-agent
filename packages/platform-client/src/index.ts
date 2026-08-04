import type {
  Announcement, Attachment, ChallengeCapability, ChallengeInfo, ChallengeSummary,
  ContestOverview, FlagSubmission, PlatformPlugin, PlatformProject, RemoteEnvironment,
} from "@ctf-agent/platform"

export interface PlatformClientOptions {
  baseUrl: string
  token: string
  name?: string
}

const REQUEST_TIMEOUT_MS = 15_000

class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message)
    this.name = "ApiError"
  }
}

class RemoteClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  private url(path: string): string {
    return `${this.baseUrl.replace(/\/+$/, "")}${path}`
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await fetch(this.url(path), {
      ...init,
      headers: {
        "Authorization": `Bearer ${this.token}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) {
      let message = `HTTP ${response.status}`
      let code = "http_error"
      try {
        const body = await response.json() as { error?: string; message?: string }
        if (typeof body.message === "string" && body.message) message = body.message
        if (typeof body.error === "string" && body.error) code = body.error
      } catch { /* 非 JSON 响应保留默认文案 */ }
      throw new ApiError(message, response.status, code)
    }
    return response
  }

  async getJson<T>(path: string): Promise<T> {
    const response = await this.request(path)
    return await response.json() as T
  }

  async postJson<T>(path: string, body?: unknown): Promise<T> {
    const response = await this.request(path, {
      method: "POST",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return await response.json() as T
  }

  async getBytes(path: string): Promise<Uint8Array> {
    const response = await this.request(path)
    return new Uint8Array(await response.arrayBuffer())
  }

  /** 幂等语义:404 视为成功(实例已不存在) */
  async postJsonIdempotent<T>(path: string): Promise<T | undefined> {
    try {
      return await this.postJson<T>(path)
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return undefined
      throw error
    }
  }
}

class RemoteCapability implements ChallengeCapability {
  private readonly client: RemoteClient
  private cachedInfo: ChallengeInfo | undefined

  constructor(
    private readonly challengeId: string,
    private readonly baseUrl: string,
    private readonly token: string,
  ) {
    this.client = new RemoteClient(baseUrl, token)
  }

  async getInfo(): Promise<ChallengeInfo> {
    if (!this.cachedInfo) {
      this.cachedInfo = await this.client.getJson<ChallengeInfo>(
        `/challenges/${encodeURIComponent(this.challengeId)}`,
      )
    }
    return this.cachedInfo
  }

  async downloadAttachment(attachmentId: string): Promise<{ attachment: Attachment; content: Uint8Array }> {
    const info = await this.getInfo()
    const meta = info.attachments.find((a) => a.id === attachmentId)
    if (!meta) throw new Error(`当前题不存在附件: ${attachmentId}`)
    const content = await this.client.getBytes(
      `/challenges/${encodeURIComponent(this.challengeId)}/attachments/${encodeURIComponent(attachmentId)}`,
    )
    return { attachment: { ...meta, size: content.byteLength }, content }
  }

  async submitFlag(flag: string): Promise<FlagSubmission> {
    return await this.client.postJson<FlagSubmission>(
      `/challenges/${encodeURIComponent(this.challengeId)}/flag`,
      { flag },
    )
  }

  readonly instance: ChallengeCapability["instance"] = {
    start: async (): Promise<RemoteEnvironment> => {
      const raw = await this.client.postJson<RemoteEnvironment & { expiresAt?: string }>(
        `/challenges/${encodeURIComponent(this.challengeId)}/instance`,
      )
      const { expiresAt: _expiresAt, ...env } = raw
      return env
    },
    status: async (): Promise<RemoteEnvironment | null> => {
      const list = await this.client.getJson<RemoteEnvironment[]>(`/instances`)
      return list.find((item) => item.challengeId === this.challengeId && item.status === "running") ?? null
    },
    destroy: async (): Promise<void> => {
      // 语义:销毁本题全部实例(与 mock 的 destroy 一致:mock 销毁该题的 running 环境)
      const list = await this.client.getJson<Array<{ id: string; challengeId: string }>>(`/instances`)
      const mine = list.filter((item) => item.challengeId === this.challengeId)
      for (const item of mine) {
        await this.client.postJsonIdempotent(`/instances/${encodeURIComponent(item.id)}/destroy`)
      }
    },
  }
}

class RemoteProject implements PlatformProject {
  private readonly client: RemoteClient

  constructor(
    private readonly eventId: string,
    private readonly options: PlatformClientOptions,
  ) {
    this.client = new RemoteClient(options.baseUrl, options.token)
  }

  async refresh(): Promise<ContestOverview> { return this.getOverview() }

  async getOverview(): Promise<ContestOverview> {
    const list = await this.listChallenges()
    return {
      id: this.eventId,
      name: this.options.name ?? "Remote CTF",
      challenges: list.length,
      announcements: 0,
    }
  }

  async listChallenges(): Promise<ChallengeSummary[]> {
    return await this.client.getJson<ChallengeSummary[]>(`/challenges`)
  }

  async listAnnouncements(): Promise<Announcement[]> {
    return []   // 服务器无公告端点(契约文档已记录)
  }

  async listRemoteEnvironments(): Promise<RemoteEnvironment[]> {
    const list = await this.client.getJson<Array<RemoteEnvironment & { expiresAt?: string }>>(`/instances`)
    return list.map(({ expiresAt: _expiresAt, ...env }) => env)
  }

  async getRemoteEnvironment(id: string): Promise<RemoteEnvironment | null> {
    const list = await this.client.getJson<RemoteEnvironment[]>(`/instances`)
    return list.find((item) => item.id === id) ?? null
  }

  async destroyRemoteEnvironment(id: string): Promise<void> {
    await this.client.postJsonIdempotent(`/instances/${encodeURIComponent(id)}/destroy`)
  }

  async bindChallenge(challengeId: string): Promise<ChallengeCapability> {
    // 预校验:尽早暴露 404(与 mock 的 bind 语义对齐)
    await this.client.getJson<ChallengeInfo>(`/challenges/${encodeURIComponent(challengeId)}`)
    return new RemoteCapability(challengeId, this.options.baseUrl, this.options.token)
  }

  async close(): Promise<void> { /* 无状态,no-op */ }
}

export class RemotePlatformPlugin implements PlatformPlugin {
  readonly id = "remote"

  async connect(options: { eventId: string; config: unknown }): Promise<PlatformProject> {
    const config = options.config as PlatformClientOptions
    if (!config || typeof config.baseUrl !== "string" || !config.baseUrl) {
      throw new Error("platform-client 配置缺少 baseUrl")
    }
    if (typeof config.token !== "string" || !config.token) {
      throw new Error("platform-client 配置缺少 token")
    }
    return new RemoteProject(options.eventId, config)
  }
}

export const remotePlatform = new RemotePlatformPlugin()
