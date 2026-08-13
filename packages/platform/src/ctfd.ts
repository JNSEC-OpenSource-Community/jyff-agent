import type {
  Announcement,
  Attachment,
  ChallengeCapability,
  ChallengeInfo,
  ChallengeSummary,
  ContestOverview,
  FlagSubmission,
  PlatformConfig,
  PlatformConnectOptions,
  PlatformPlugin,
  PlatformProject,
  PlatformSetupDescriptor,
  RemoteEnvironment,
} from "./index.ts"

export interface CTFdPlatformConfig {
  baseUrl: string
  tokenSecret: string
  name?: string
  timeoutMs: number
}

const allowedKeys = new Set(["baseUrl", "tokenSecret", "name", "timeoutMs"])

export const ctfdConfig: PlatformConfig<CTFdPlatformConfig> = {
  parse(value): CTFdPlatformConfig {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("CTFd 平台配置必须是对象")
    }
    const raw = value as Record<string, unknown>
    for (const key of Object.keys(raw)) {
      if (!allowedKeys.has(key)) throw new Error(`CTFd 平台配置包含未知字段: ${key}`)
    }

    const baseUrl = requiredText(raw.baseUrl, "baseUrl").replace(/\/+$/, "")
    const url = new URL(baseUrl)
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("CTFd baseUrl 仅支持 http 或 https")
    }
    if (url.username || url.password || url.search || url.hash) {
      throw new Error("CTFd baseUrl 不能包含凭据、query 或 fragment")
    }

    const tokenSecret =
      raw.tokenSecret === undefined ? "CTFD_TOKEN" : requiredText(raw.tokenSecret, "tokenSecret")
    const timeoutMs = raw.timeoutMs === undefined ? 15_000 : raw.timeoutMs
    if (
      !Number.isInteger(timeoutMs) ||
      (timeoutMs as number) < 1_000 ||
      (timeoutMs as number) > 120_000
    ) {
      throw new Error("CTFd timeoutMs 必须是 1000 到 120000 之间的整数")
    }
    if (raw.name !== undefined && (typeof raw.name !== "string" || raw.name.trim() === "")) {
      throw new Error("CTFd name 必须是非空字符串")
    }

    return {
      baseUrl,
      tokenSecret,
      timeoutMs: timeoutMs as number,
      ...(typeof raw.name === "string" ? { name: raw.name.trim() } : {}),
    }
  },
}

export const ctfdSetup: PlatformSetupDescriptor = {
  label: "CTFd",
  description: "使用 CTFd 用户 Access Token 读取题目、附件、公告并提交 Flag。",
  defaultConfig: {
    baseUrl: "https://demo.ctfd.io",
    tokenSecret: "CTFD_TOKEN",
  },
  fields: [
    {
      key: "baseUrl",
      label: "Base URL",
      type: "url",
      required: true,
      placeholder: "https://demo.ctfd.io",
    },
  ],
  authStrategies: [
    {
      id: "token",
      label: "Access Token",
      config: { tokenSecret: "CTFD_TOKEN" },
      secrets: [
        {
          name: "CTFD_TOKEN",
          label: "CTFd Access Token",
          type: "token",
          required: true,
        },
      ],
    },
  ],
}

function requiredText(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`CTFd ${name} 必须是非空字符串`)
  }
  return value.trim()
}

interface CTFdEnvelope<T> {
  success: boolean
  data?: T
  errors?: unknown
}

export class CTFdApiError extends Error {
  constructor(
    message: string,
    readonly kind:
      | "authentication"
      | "permission"
      | "not_found"
      | "rate_limited"
      | "http"
      | "network"
      | "protocol",
    readonly status?: number,
    readonly details?: unknown,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = "CTFdApiError"
  }

  get retryable(): boolean {
    return (
      this.kind === "network" ||
      this.kind === "rate_limited" ||
      (this.kind === "http" && (this.status ?? 0) >= 500)
    )
  }
}

export class CTFdClient {
  readonly baseUrl: URL

  constructor(
    config: CTFdPlatformConfig,
    private readonly token: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {
    this.baseUrl = new URL(`${config.baseUrl}/`)
    this.timeoutMs = config.timeoutMs
  }

  private readonly timeoutMs: number

  async get<T>(path: string): Promise<T> {
    return await this.api<T>(path)
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    return await this.api<T>(path, {
      method: "POST",
      body: JSON.stringify(body),
    })
  }

  async download(location: string): Promise<Uint8Array> {
    const url = new URL(location, this.baseUrl)
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new CTFdApiError("CTFd 返回了不支持的附件 URL", "protocol")
    }
    const sameOrigin = url.origin === this.baseUrl.origin
    const response = await this.send(url, {
      headers: sameOrigin ? { Authorization: `Token ${this.token}` } : undefined,
    })
    if (!response.ok) {
      throw new CTFdApiError(
        `CTFd 附件下载失败: HTTP ${response.status}`,
        kindForStatus(response.status),
        response.status,
      )
    }
    return new Uint8Array(await response.arrayBuffer())
  }

  private async api<T>(path: string, init: RequestInit = {}): Promise<T> {
    const url = new URL(`api/v1/${path.replace(/^\/+/, "")}`, this.baseUrl)
    const headers = new Headers(init.headers)
    headers.set("Accept", headers.get("Accept") ?? "application/json")
    headers.set("Authorization", headers.get("Authorization") ?? `Token ${this.token}`)
    headers.set("Content-Type", headers.get("Content-Type") ?? "application/json")
    const response = await this.send(url, {
      ...init,
      redirect: "manual",
      // CTFd's token middleware only inspects Authorization when Flask
      // considers the request JSON, including bodyless GET requests.
      headers,
    })

    if (response.status >= 300 && response.status < 400) {
      throw new CTFdApiError(
        "CTFd API 将请求重定向到登录页，请检查 access token",
        "authentication",
        response.status,
      )
    }

    const contentType = response.headers.get("content-type") ?? ""
    if (!contentType.toLowerCase().includes("application/json")) {
      throw new CTFdApiError(
        `CTFd API 返回了非 JSON 响应: HTTP ${response.status}`,
        "protocol",
        response.status,
      )
    }

    let envelope: CTFdEnvelope<T>
    try {
      envelope = (await response.json()) as CTFdEnvelope<T>
    } catch (error) {
      throw new CTFdApiError("无法解析 CTFd API 响应", "protocol", response.status, undefined, {
        cause: error,
      })
    }

    // CTFd 的 attempt API 会用 403/429 携带 success:true 的业务状态。
    if (envelope.success === true && envelope.data !== undefined) return envelope.data
    if (!response.ok || envelope.success !== true) {
      throw new CTFdApiError(
        apiErrorMessage(envelope.errors, response.status),
        kindForStatus(response.status),
        response.status,
        envelope.errors,
      )
    }
    throw new CTFdApiError("CTFd API 成功响应缺少 data", "protocol", response.status)
  }

  private async send(url: URL, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchFn(url, {
        ...init,
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (error) {
      const timeout = error instanceof DOMException && error.name === "TimeoutError"
      throw new CTFdApiError(
        timeout ? `CTFd 请求超过 ${this.timeoutMs}ms` : "无法连接 CTFd",
        "network",
        undefined,
        undefined,
        { cause: error },
      )
    }
  }
}

function kindForStatus(status: number): CTFdApiError["kind"] {
  if (status === 401) return "authentication"
  if (status === 403) return "permission"
  if (status === 404) return "not_found"
  if (status === 429) return "rate_limited"
  return "http"
}

function apiErrorMessage(errors: unknown, status: number): string {
  if (typeof errors === "string" && errors) return errors
  if (Array.isArray(errors)) {
    const messages = errors.filter((item): item is string => typeof item === "string")
    if (messages.length > 0) return messages.join("; ")
  }
  if (typeof errors === "object" && errors !== null) {
    const messages = Object.entries(errors as Record<string, unknown>).flatMap(([field, value]) =>
      Array.isArray(value)
        ? value
            .filter((item): item is string => typeof item === "string")
            .map((item) => `${field}: ${item}`)
        : typeof value === "string"
          ? [`${field}: ${value}`]
          : [],
    )
    if (messages.length > 0) return messages.join("; ")
  }
  return `CTFd API 请求失败: HTTP ${status}`
}

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

  constructor(
    private readonly challengeId: string,
    private readonly client: CTFdClient,
  ) {}

  async getInfo(): Promise<ChallengeInfo> {
    if (!this.info) this.info = mapChallengeInfo(await this.detail())
    return this.info
  }

  async downloadAttachment(
    attachmentId: string,
  ): Promise<{ attachment: Attachment; content: Uint8Array }> {
    // Refresh details so short-lived signed file URLs are never restored from a stale session.
    const detail = await this.detail()
    const binding = fileBindings(detail.files ?? []).find(
      (item) => item.attachment.id === attachmentId,
    )
    if (!binding) throw new Error(`当前题不存在附件: ${attachmentId}`)
    const content = await this.client.download(binding.location)
    return {
      attachment: { ...binding.attachment, size: content.byteLength },
      content,
    }
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
      return {
        status: "already_solved",
        message: attempt.message ?? "Already solved",
      }
    }
    return { status: "rejected", message: attempt.message ?? attempt.status }
  }

  private async detail(): Promise<CTFdChallenge> {
    return await this.client.get<CTFdChallenge>(
      `challenges/${encodeURIComponent(this.challengeId)}`,
    )
  }
}

class CTFdProject implements PlatformProject {
  constructor(
    private readonly project: { id: string; name: string },
    private readonly config: CTFdPlatformConfig,
    private readonly client: CTFdClient,
  ) {}

  async refresh(): Promise<ContestOverview> {
    return await this.getOverview()
  }

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
      kind: "unknown",
    }))
  }

  async listRemoteEnvironments(): Promise<RemoteEnvironment[]> {
    return []
  }
  async getRemoteEnvironment(): Promise<RemoteEnvironment | null> {
    return null
  }
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
  readonly setup = ctfdSetup

  async connect(options: PlatformConnectOptions): Promise<PlatformProject> {
    const config = this.config.parse(options.config)
    const token = options.resolveSecret(config.tokenSecret)?.trim()
    if (!token) throw new Error(`缺少 CTFd access token secret: ${config.tokenSecret}`)
    return new CTFdProject(options.project, config, new CTFdClient(config, token))
  }
}

export const ctfdPlatform = new CTFdPlatformPlugin()

function mapChallengeSummary(challenge: CTFdChallenge): ChallengeSummary {
  return {
    id: String(challenge.id),
    title: challenge.name,
    category: challenge.category,
    score: challenge.value,
    solved: challenge.solved_by_me === true,
    needsEnv: false,
    hasAttachments: (challenge.files?.length ?? 0) > 0,
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
