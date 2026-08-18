import { waitForEndpointReachable } from "./endpoint-readiness.ts"
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

const API_PATH = "/slab-match/api/v1/agent/"
const SUCCESS_CODE = "00000"
const DEFAULT_ACCESS_KEY_SECRET = "DASCTF_ACCESS_KEY"

export interface DASCTFPlatformConfig {
  baseUrl: string
  accessKeySecret: string
  name?: string
  timeoutMs: number
  /** Minimum spacing between Agent API request starts for this Project. */
  minRequestIntervalMs: number
  cacheTtlMs: number
  detailCacheTtlMs: number
  environmentPollIntervalMs: number
  environmentMaxPollIntervalMs: number
  environmentReadyTimeoutMs: number
}

const allowedConfigKeys = new Set([
  "baseUrl",
  "accessKeySecret",
  "name",
  "timeoutMs",
  "minRequestIntervalMs",
  "cacheTtlMs",
  "detailCacheTtlMs",
  "environmentPollIntervalMs",
  "environmentMaxPollIntervalMs",
  "environmentReadyTimeoutMs",
])

export const dasctfConfig: PlatformConfig<DASCTFPlatformConfig> = {
  parse(value): DASCTFPlatformConfig {
    const raw = object(value, "DASCTF 平台配置")
    rejectUnknown(raw, allowedConfigKeys, "DASCTF 平台配置")
    const baseUrl = text(raw.baseUrl, "DASCTF baseUrl").replace(/\/+$/, "")
    const url = new URL(baseUrl)
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("DASCTF baseUrl 仅支持 http 或 https")
    }
    if (url.username || url.password || url.search || url.hash) {
      throw new Error("DASCTF baseUrl 不能包含凭据、query 或 fragment")
    }
    if (url.pathname !== "/" && url.pathname !== "") {
      throw new Error("DASCTF baseUrl 只能填写站点根地址")
    }
    if (raw.name !== undefined && (typeof raw.name !== "string" || raw.name.trim() === "")) {
      throw new Error("DASCTF name 必须是非空字符串")
    }

    const environmentPollIntervalMs = optionalInteger(
      raw.environmentPollIntervalMs,
      3_000,
      "DASCTF environmentPollIntervalMs",
      100,
      30_000,
    )
    const environmentMaxPollIntervalMs = optionalInteger(
      raw.environmentMaxPollIntervalMs,
      10_000,
      "DASCTF environmentMaxPollIntervalMs",
      environmentPollIntervalMs,
      60_000,
    )

    return {
      baseUrl,
      accessKeySecret:
        raw.accessKeySecret === undefined
          ? DEFAULT_ACCESS_KEY_SECRET
          : text(raw.accessKeySecret, "DASCTF accessKeySecret"),
      timeoutMs: optionalInteger(raw.timeoutMs, 15_000, "DASCTF timeoutMs", 1_000, 120_000),
      // DASCTF Pro responds with business-level rate-limit errors without a
      // Retry-After header. Serialize only this Project's Agent API starts;
      // resource-CDN downloads remain independent.
      minRequestIntervalMs: optionalInteger(
        raw.minRequestIntervalMs,
        2_000,
        "DASCTF minRequestIntervalMs",
        1,
        30_000,
      ),
      cacheTtlMs: optionalInteger(raw.cacheTtlMs, 30_000, "DASCTF cacheTtlMs", 1_000, 300_000),
      detailCacheTtlMs: optionalInteger(
        raw.detailCacheTtlMs,
        3_000,
        "DASCTF detailCacheTtlMs",
        250,
        30_000,
      ),
      environmentPollIntervalMs,
      environmentMaxPollIntervalMs,
      environmentReadyTimeoutMs: optionalInteger(
        raw.environmentReadyTimeoutMs,
        3 * 60_000,
        "DASCTF environmentReadyTimeoutMs",
        1_000,
        4 * 60_000,
      ),
      ...(typeof raw.name === "string" ? { name: raw.name.trim() } : {}),
    }
  },
}

export const dasctfSetup: PlatformSetupDescriptor = {
  label: "DASCTF Pro",
  description: "使用 AI Agent AccessKey 读取 DASCTF Pro 比赛并管理题目远程环境。",
  defaultConfig: {
    baseUrl: "https://pro.dasctf.com",
    accessKeySecret: DEFAULT_ACCESS_KEY_SECRET,
  },
  fields: [
    {
      key: "baseUrl",
      label: "站点 URL",
      type: "url",
      required: true,
      placeholder: "https://pro.dasctf.com",
    },
  ],
  authStrategies: [
    {
      id: "access-key",
      label: "AI Agent AccessKey",
      config: { accessKeySecret: DEFAULT_ACCESS_KEY_SECRET },
      secrets: [
        {
          name: DEFAULT_ACCESS_KEY_SECRET,
          label: "Agent AccessKey",
          type: "token",
          required: true,
        },
      ],
    },
  ],
}

interface DASCTFEnvelope<T> {
  code: string
  message?: string
  data?: T
}

type DASCTFErrorKind =
  | "authentication"
  | "permission"
  | "not_found"
  | "rate_limited"
  | "http"
  | "network"
  | "protocol"
  | "business"

export class DASCTFApiError extends Error {
  constructor(
    message: string,
    readonly kind: DASCTFErrorKind,
    readonly status?: number,
    readonly apiCode?: string,
    readonly retryAfterMs?: number,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = "DASCTFApiError"
  }

  get retryable(): boolean {
    return (
      this.kind === "network" ||
      this.kind === "rate_limited" ||
      (this.kind === "http" && (this.status ?? 0) >= 500)
    )
  }
}

export class DASCTFClient {
  readonly apiBaseUrl: URL
  private readonly timeoutMs: number
  private readonly requestGate: DASCTFRequestGate

  constructor(
    config: DASCTFPlatformConfig,
    private readonly accessKey: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {
    this.apiBaseUrl = new URL(API_PATH, `${config.baseUrl}/`)
    this.timeoutMs = config.timeoutMs
    this.requestGate = new DASCTFRequestGate(config.minRequestIntervalMs)
  }

  async get<T>(
    path: string,
    query?: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<T> {
    return await this.requestData<T>(path, { query, signal })
  }

  async post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    return await this.requestData<T>(path, { method: "POST", body, signal })
  }

  async submitAnswer(
    exerciseId: number,
    flag: string,
    signal?: AbortSignal,
  ): Promise<FlagSubmission> {
    const envelope = await this.request<DASCTFAnswerData>("answer-panel/answer", {
      method: "POST",
      body: { exerciseId, flag },
      signal,
      allowBusinessFailure: true,
    })
    if (envelope.code !== SUCCESS_CODE) {
      return {
        status: "rejected",
        message: safeMessage(envelope.message, "答案错误", this.accessKey),
      }
    }
    return envelope.data?.isCorrect === true
      ? {
          status: "accepted",
          message: safeMessage(envelope.message, "Accepted", this.accessKey),
        }
      : {
          status: "rejected",
          message: safeMessage(envelope.message, "答案错误", this.accessKey),
        }
  }

  async recoverEnvironment(exerciseId: number): Promise<void> {
    try {
      await this.post("ctf/recover-exercise-env", { exerciseId })
    } catch (error) {
      if (
        error instanceof DASCTFApiError &&
        error.kind === "business" &&
        isAlreadyRecovered(error.message)
      ) {
        return
      }
      throw error
    }
  }

  async download(location: string, signal?: AbortSignal): Promise<Uint8Array> {
    const url = new URL(location, this.apiBaseUrl)
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new DASCTFApiError("DASCTF 返回了不支持的附件 URL", "protocol")
    }
    const sameOrigin = url.origin === this.apiBaseUrl.origin
    const response = await this.send(
      url,
      {
        headers: sameOrigin ? { "X-Agent-AccessKey": this.accessKey } : undefined,
      },
      signal,
    )
    if (!response.ok) {
      throw httpError(response, "DASCTF 附件下载失败")
    }
    try {
      return new Uint8Array(await response.arrayBuffer())
    } catch (error) {
      if (signal?.aborted) throw abortReason(signal)
      throw new DASCTFApiError(
        "DASCTF 附件响应读取超时或中断",
        "network",
        response.status,
        undefined,
        undefined,
        {
          cause: error,
        },
      )
    }
  }

  private async requestData<T>(
    path: string,
    options: {
      method?: "POST"
      body?: unknown
      query?: Readonly<Record<string, string>>
      signal?: AbortSignal
    } = {},
  ): Promise<T> {
    const envelope = await this.request<T>(path, options)
    return envelope.data as T
  }

  private async request<T>(
    path: string,
    options: {
      method?: "POST"
      body?: unknown
      query?: Readonly<Record<string, string>>
      signal?: AbortSignal
      allowBusinessFailure?: boolean
    } = {},
  ): Promise<DASCTFEnvelope<T>> {
    const url = new URL(path.replace(/^\/+/, ""), this.apiBaseUrl)
    for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, value)
    await this.requestGate.wait(options.signal)
    const headers = new Headers({
      Accept: "application/json",
      "X-Agent-AccessKey": this.accessKey,
    })
    if (options.method === "POST") headers.set("Content-Type", "application/json")
    const response = await this.send(
      url,
      {
        method: options.method ?? "GET",
        headers,
        ...(options.method === "POST" ? { body: JSON.stringify(options.body) } : {}),
      },
      options.signal,
    )

    let envelope: DASCTFEnvelope<T>
    try {
      envelope = (await response.json()) as DASCTFEnvelope<T>
    } catch (error) {
      if (options.signal?.aborted) throw abortReason(options.signal)
      if (
        error instanceof DOMException &&
        (error.name === "AbortError" || error.name === "TimeoutError")
      ) {
        throw new DASCTFApiError(
          "DASCTF 响应读取超时或中断",
          "network",
          response.status,
          undefined,
          undefined,
          {
            cause: error,
          },
        )
      }
      if (!response.ok) {
        throw httpError(response, "DASCTF API 请求失败")
      }
      throw new DASCTFApiError(
        `DASCTF API 返回了无法解析的响应: HTTP ${response.status}`,
        "protocol",
        response.status,
        undefined,
        undefined,
        { cause: error },
      )
    }
    if (!envelope || typeof envelope !== "object" || typeof envelope.code !== "string") {
      throw new DASCTFApiError("DASCTF API 响应缺少 code", "protocol", response.status)
    }
    if (!response.ok) {
      throw apiError(response, envelope.code, envelope.message, this.accessKey)
    }
    if (envelope.code !== SUCCESS_CODE) {
      const error = apiError(response, envelope.code, envelope.message, this.accessKey)
      if (!(options.allowBusinessFailure && error.kind === "business")) throw error
    }
    return envelope
  }

  private async send(url: URL, init: RequestInit, callerSignal?: AbortSignal): Promise<Response> {
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs)
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal
    try {
      return await this.fetchFn(url, { ...init, redirect: "manual", signal })
    } catch (error) {
      if (callerSignal?.aborted) throw abortReason(callerSignal)
      throw new DASCTFApiError(
        timeoutSignal.aborted ? `DASCTF 请求超过 ${this.timeoutMs}ms` : "无法连接 DASCTF",
        "network",
        undefined,
        undefined,
        undefined,
        { cause: error },
      )
    }
  }
}

class DASCTFRequestGate {
  private tail: Promise<void> = Promise.resolve()
  private nextRequestAt = 0

  constructor(private readonly intervalMs: number) {}

  async wait(signal?: AbortSignal): Promise<void> {
    let release!: () => void
    const turn = new Promise<void>((resolve) => {
      release = resolve
    })
    const previous = this.tail
    this.tail = turn
    try {
      await waitForSignal(previous, signal)
      await delay(Math.max(0, this.nextRequestAt - Date.now()), signal)
      throwIfAborted(signal)
      this.nextRequestAt = Date.now() + this.intervalMs
    } finally {
      release()
    }
  }
}

interface DASCTFExerciseGroup {
  id: number | string
  name: string
  order?: number
  corpus?: DASCTFExerciseSummary[]
}

interface DASCTFExerciseSummary {
  id: number | string
  name: string
  order?: number
  isOpen?: boolean
  hasSolved?: boolean
}

interface DASCTFAttachmentFile {
  key?: string
  signature?: string
  url?: string
  name?: string
  previewUrl?: string
  /** Documented payloads use ext; the production API currently uses extension. */
  ext?: string
  extension?: string
}

interface DASCTFAttachment extends DASCTFAttachmentFile {
  /** Legacy/documented shape. Production currently returns a single file object instead. */
  files?: DASCTFAttachmentFile[]
}

interface DASCTFEndpointUser {
  username?: string
  password?: string
}

interface DASCTFPortMapping {
  type?: string
  port?: string | number
  proxy?: string | number
}

interface DASCTFEndpoint {
  exposeIps?: string[]
  ports?: Array<string | number>
  users?: DASCTFEndpointUser[]
  portMappings?: DASCTFPortMapping[]
  proxyIps?: string[]
  isProxy?: boolean
  expireTime?: number
}

interface DASCTFExerciseDetail {
  id: number | string
  name?: string
  description?: string
  hasSolved?: boolean
  score?: string | number
  difficulty?: string
  attachment?: DASCTFAttachment
  endpoints?: DASCTFEndpoint[]
  canRefreshEndpoint?: boolean
  isNeedInit?: boolean
  endpointType?: string | null
  currentTime?: number
  isNeedCheck?: boolean
}

interface DASCTFNotice {
  id: number | string
  title?: string
  content?: string
  createdAt?: string
  createdTime?: number
  userName?: string
}

interface DASCTFAnswerData {
  isCorrect?: boolean
}

interface AttachmentBinding {
  attachment: Attachment
  location: string
}

class AsyncTtlCache<T> {
  private value?: T
  private hasValue = false
  private expiresAt = 0
  private pending?: { generation: number; promise: Promise<T> }
  private generation = 0

  constructor(private readonly ttlMs: number) {}

  async get(load: () => Promise<T>, force = false): Promise<T> {
    const generation = this.generation
    if (this.pending?.generation === generation) return await this.pending.promise
    if (!force && this.hasValue && Date.now() < this.expiresAt) return this.value as T

    let promise!: Promise<T>
    promise = (async () => {
      try {
        const value = await load()
        if (generation !== this.generation) return await this.get(load)
        this.value = value
        this.hasValue = true
        this.expiresAt = Date.now() + this.ttlMs
        return value
      } finally {
        if (this.pending?.promise === promise) this.pending = undefined
      }
    })()
    this.pending = { generation, promise }
    return await promise
  }

  clear(): void {
    this.generation++
    this.value = undefined
    this.hasValue = false
    this.expiresAt = 0
  }
}

class DASCTFChallengeCapability implements ChallengeCapability {
  readonly instance?: ChallengeCapability["instance"]
  private detail: DASCTFExerciseDetail
  private cleanupRequired = false

  constructor(
    private readonly challengeId: number,
    initialDetail: DASCTFExerciseDetail,
    private readonly client: DASCTFClient,
    private readonly config: DASCTFPlatformConfig,
    private readonly loadDetail: (
      force: boolean,
      signal?: AbortSignal,
    ) => Promise<DASCTFExerciseDetail>,
    private readonly rememberEnvironment: (environment: RemoteEnvironment | null) => void,
    private readonly invalidateDetail: () => void,
  ) {
    this.detail = initialDetail
    const initialEnvironment = environmentFromDetail(initialDetail, challengeId)
    if (initialEnvironment) {
      this.cleanupRequired = true
      this.rememberEnvironment(initialEnvironment)
    }
    if (isManagedEnvironment(initialDetail)) {
      this.instance = {
        start: async (signal) => await this.startEnvironment(signal),
        waitUntilReady: async (environment, signal) =>
          await this.waitUntilReady(environment, signal),
        status: async () => await this.environmentStatus(),
        destroy: async () => await this.destroyEnvironment(),
      }
    }
  }

  async getInfo(): Promise<ChallengeInfo> {
    return mapChallengeInfo(this.detail)
  }

  async downloadAttachment(
    attachmentId: string,
  ): Promise<{ attachment: Attachment; content: Uint8Array }> {
    this.detail = await this.loadDetail(true)
    const binding = attachmentBindings(this.detail).find(
      (candidate) => candidate.attachment.id === attachmentId,
    )
    if (!binding) throw new Error(`当前题不存在附件: ${attachmentId}`)
    const content = await this.client.download(binding.location)
    return {
      attachment: { ...binding.attachment, size: content.byteLength },
      content,
    }
  }

  async submitFlag(flag: string): Promise<FlagSubmission> {
    if (this.detail.hasSolved === true) {
      return { status: "already_solved", message: "Already solved" }
    }
    const result = await this.client.submitAnswer(this.challengeId, flag)
    if (result.status === "accepted") this.detail = { ...this.detail, hasSolved: true }
    return result
  }

  private async startEnvironment(signal?: AbortSignal): Promise<RemoteEnvironment> {
    throwIfAborted(signal)
    const existing = environmentFromDetail(this.detail, this.challengeId)
    if (existing) {
      this.cleanupRequired = true
      this.rememberEnvironment(existing)
      return existing
    }
    if (this.detail.isNeedInit !== true) {
      throw new DASCTFApiError(
        "DASCTF 题目当前没有可用 endpoint，且平台未允许初始化环境",
        "business",
      )
    }

    // build 是非幂等 POST。先记录 starting，使 Core 在超时或响应丢失时的
    // 补偿 destroy 能调用 recover；失败后只读一次详情以识别已经到达平台的 POST。
    this.cleanupRequired = true
    this.detail = { ...this.detail, isNeedInit: false, isNeedCheck: true, endpoints: [] }
    const starting = environmentFromDetail(this.detail, this.challengeId)
    if (!starting) throw new DASCTFApiError("DASCTF 环境启动状态无效", "protocol")
    this.rememberEnvironment(starting)
    try {
      await this.client.post("ctf/build-exercise-env", { exerciseId: this.challengeId }, signal)
    } catch (error) {
      this.invalidateDetail()
      try {
        this.detail = await this.loadDetail(true, signal)
        const created = environmentFromDetail(this.detail, this.challengeId)
        if (created) {
          this.rememberEnvironment(created)
          return created
        }
      } catch {
        // Preserve the original POST error and the local starting marker so
        // Core's bounded compensation path attempts an idempotent recover.
      }
      throw error
    }
    this.invalidateDetail()
    return starting
  }

  private async waitUntilReady(
    initial: RemoteEnvironment,
    signal?: AbortSignal,
  ): Promise<RemoteEnvironment> {
    const deadline = Date.now() + this.config.environmentReadyTimeoutMs
    let environment: RemoteEnvironment | null = initial
    let pollDelayMs = this.config.environmentPollIntervalMs
    while (Date.now() < deadline) {
      throwIfAborted(signal)
      if (environment?.status === "running" && environment.endpoint) {
        await waitForEndpointReachable(environment.endpoint, signal, {
          timeoutMs: Math.max(1, deadline - Date.now()),
          retryDelayMs: this.config.environmentPollIntervalMs,
        })
        const ready: RemoteEnvironment = { ...environment, readyAt: new Date().toISOString() }
        this.rememberEnvironment(ready)
        return ready
      }
      await delay(Math.min(pollDelayMs, Math.max(1, deadline - Date.now())), signal)
      this.detail = await this.loadDetail(true, signal)
      environment = environmentFromDetail(this.detail, this.challengeId)
      if (!environment && this.detail.isNeedInit === true) {
        throw retryableEnvironmentError("DASCTF 远程环境在就绪前被回收")
      }
      if (environment) this.rememberEnvironment(environment)
      pollDelayMs = Math.min(this.config.environmentMaxPollIntervalMs, Math.ceil(pollDelayMs * 1.5))
    }
    throw retryableEnvironmentError(
      `DASCTF 远程环境在 ${this.config.environmentReadyTimeoutMs}ms 内未就绪`,
    )
  }

  private async environmentStatus(): Promise<RemoteEnvironment | null> {
    this.detail = await this.loadDetail(true)
    const environment = environmentFromDetail(this.detail, this.challengeId)
    this.rememberEnvironment(environment)
    return environment
  }

  private async destroyEnvironment(): Promise<void> {
    const environment = environmentFromDetail(this.detail, this.challengeId)
    if (!environment && !this.cleanupRequired) {
      this.rememberEnvironment(null)
      return
    }
    await this.client.recoverEnvironment(this.challengeId)
    this.cleanupRequired = false
    this.invalidateDetail()
    this.detail = {
      ...this.detail,
      endpoints: [],
      isNeedCheck: false,
      isNeedInit: true,
    }
    this.rememberEnvironment(null)
  }
}

class DASCTFProject implements PlatformProject {
  private readonly challengeList: AsyncTtlCache<ChallengeSummary[]>
  private readonly announcements: AsyncTtlCache<Announcement[]>
  private readonly detailCaches = new Map<number, AsyncTtlCache<DASCTFExerciseDetail>>()
  private readonly environments = new Map<string, RemoteEnvironment>()

  constructor(
    private readonly project: { id: string; name: string },
    private readonly config: DASCTFPlatformConfig,
    private readonly client: DASCTFClient,
  ) {
    this.challengeList = new AsyncTtlCache(config.cacheTtlMs)
    this.announcements = new AsyncTtlCache(config.cacheTtlMs)
  }

  async refresh(): Promise<ContestOverview> {
    this.challengeList.clear()
    this.announcements.clear()
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
    return await this.challengeList.get(async () => {
      const groups = await this.client.get<DASCTFExerciseGroup[]>("ctf/exercise-list")
      if (!Array.isArray(groups)) throw new DASCTFApiError("DASCTF 题目列表不是数组", "protocol")
      return groups.flatMap((group) => mapExerciseGroup(group))
    })
  }

  async listAnnouncements(): Promise<Announcement[]> {
    return await this.announcements.get(async () => {
      const notices = await this.client.get<DASCTFNotice[]>("match/notice/now-list")
      if (!Array.isArray(notices)) throw new DASCTFApiError("DASCTF 公告列表不是数组", "protocol")
      return notices.map(mapNotice)
    })
  }

  async listRemoteEnvironments(): Promise<RemoteEnvironment[]> {
    // 平台没有全局实例列表。只投影本进程已经通过题目详情确认的实例，
    // 避免 Dashboard 每轮为所有题目逐一请求详情并触发严格限流。
    return [...this.environments.values()]
      .filter((environment) => environment.status === "running")
      .map((environment) => ({ ...environment }))
  }

  async getRemoteEnvironment(id: string): Promise<RemoteEnvironment | null> {
    const challengeId = parseEnvironmentId(id)
    if (challengeId === null || !this.environments.has(id)) return null
    const capability = await this.bindChallenge(String(challengeId))
    return capability.instance ? await capability.instance.status() : null
  }

  async destroyRemoteEnvironment(id: string): Promise<void> {
    const challengeId = parseEnvironmentId(id)
    if (challengeId === null || !this.environments.has(id)) {
      throw new Error(`未知 DASCTF 远程实例: ${id}`)
    }
    const capability = await this.bindChallenge(String(challengeId))
    if (!capability.instance) throw new Error(`DASCTF 题目 ${challengeId} 没有远程环境`)
    await capability.instance.destroy()
  }

  async bindChallenge(challengeId: string): Promise<ChallengeCapability> {
    const id = positiveId(challengeId)
    const detail = await this.challengeDetail(id, false)
    return new DASCTFChallengeCapability(
      id,
      detail,
      this.client,
      this.config,
      async (force, signal) => await this.challengeDetail(id, force, signal),
      (environment) => this.rememberEnvironment(id, environment),
      () => this.detailCaches.get(id)?.clear(),
    )
  }

  async close(): Promise<void> {
    this.challengeList.clear()
    this.announcements.clear()
    for (const cache of this.detailCaches.values()) cache.clear()
    this.detailCaches.clear()
    this.environments.clear()
  }

  private async challengeDetail(
    id: number,
    force: boolean,
    signal?: AbortSignal,
  ): Promise<DASCTFExerciseDetail> {
    let cache = this.detailCaches.get(id)
    if (!cache) {
      cache = new AsyncTtlCache(this.config.detailCacheTtlMs)
      this.detailCaches.set(id, cache)
    }
    return await cache.get(async () => {
      const detail = await this.client.get<DASCTFExerciseDetail>(
        "ctf/exercise",
        { exerciseId: String(id) },
        signal,
      )
      if (!detail || typeof detail !== "object" || String(detail.id) !== String(id)) {
        throw new DASCTFApiError("DASCTF 题目详情 ID 无效", "protocol")
      }
      return detail
    }, force)
  }

  private rememberEnvironment(challengeId: number, environment: RemoteEnvironment | null): void {
    const id = environmentId(challengeId)
    if (!environment || environment.status === "stopped") this.environments.delete(id)
    else this.environments.set(id, { ...environment })
  }
}

export class DASCTFPlatformPlugin implements PlatformPlugin {
  readonly id = "dasctf"
  readonly config = dasctfConfig
  readonly setup = dasctfSetup

  async connect(options: PlatformConnectOptions): Promise<PlatformProject> {
    const config = this.config.parse(options.config)
    const accessKey = options.resolveSecret(config.accessKeySecret)?.trim()
    if (!accessKey) throw new Error(`缺少 DASCTF Agent AccessKey secret: ${config.accessKeySecret}`)
    return new DASCTFProject(options.project, config, new DASCTFClient(config, accessKey))
  }
}

export const dasctfPlatform = new DASCTFPlatformPlugin()

function mapExerciseGroup(group: DASCTFExerciseGroup): ChallengeSummary[] {
  if (!group || typeof group !== "object" || !Array.isArray(group.corpus)) {
    throw new DASCTFApiError("DASCTF 题目分组结构无效", "protocol")
  }
  const category =
    typeof group.name === "string" && group.name.trim() ? group.name.trim() : "unknown"
  return group.corpus
    .filter((exercise) => exercise?.isOpen !== false)
    .map((exercise) => {
      const id = String(exercise.id ?? "")
      if (!/^\d+$/.test(id) || typeof exercise.name !== "string" || !exercise.name.trim()) {
        throw new DASCTFApiError("DASCTF 题目摘要结构无效", "protocol")
      }
      return {
        id,
        title: exercise.name.trim(),
        category,
        // 列表 API 不提供分值、附件或环境字段。不能为得到这些字段对每题
        // 追加详情请求，否则一次 Dashboard 刷新会迅速撞上平台限流。
        score: 0,
        solved: exercise.hasSolved === true,
      }
    })
}

function mapChallengeInfo(detail: DASCTFExerciseDetail): ChallengeInfo {
  const id = String(detail.id)
  const score = Number(detail.score)
  const attachments = attachmentBindings(detail).map(({ attachment }) => attachment)
  const environment = environmentFromDetail(detail, positiveId(id))
  return {
    id,
    title:
      typeof detail.name === "string" && detail.name.trim()
        ? detail.name.trim()
        : `Challenge ${id}`,
    category:
      typeof detail.difficulty === "string" && detail.difficulty.trim()
        ? detail.difficulty.trim()
        : "unknown",
    score: Number.isFinite(score) ? score : 0,
    solved: detail.hasSolved === true,
    needsEnv: isManagedEnvironment(detail),
    hasAttachments: attachments.length > 0,
    description: withSubmissionGuide(detail.description ?? ""),
    attachments,
    ...(environmentGuide(detail, environment)
      ? { environmentGuide: environmentGuide(detail, environment) }
      : {}),
  }
}

/**
 * `ChallengeInfo.description` is rendered into the Solver/SubAgent prompt by
 * `challengeContextPrompt`. DASCTF Pro's Agent endpoint validates the raw
 * payload rather than the display wrapper advertised by some challenges.
 */
function withSubmissionGuide(description: string): string {
  return `${description}\n\n## DASCTF Pro submission format\n\nSubmit only the raw payload inside an outer \`DASCTF{...}\` wrapper. For example, if your recovered display flag is \`DASCTF{abc}\`, call \`ctf_submit_flag\` with \`abc\`, not the wrapped value.`
}

function attachmentBindings(detail: DASCTFExerciseDetail): AttachmentBinding[] {
  return attachmentFiles(detail.attachment).flatMap((file, index) => {
    if (!file.url || typeof file.url !== "string") return []
    return [
      {
        attachment: {
          id: `attachment-${index + 1}`,
          name: attachmentName(file, index),
        },
        location: file.url,
      },
    ]
  })
}

/**
 * DASCTF's published Agent API shows `attachment.files[]`, while the Pro
 * service currently returns `attachment` itself as the single file record.
 * Normalize both wire formats at the boundary so callers never need platform
 * shape knowledge.
 */
function attachmentFiles(attachment: DASCTFAttachment | undefined): DASCTFAttachmentFile[] {
  if (!attachment) return []
  if (Array.isArray(attachment.files)) return attachment.files
  return typeof attachment.url === "string" ? [attachment] : []
}

function attachmentName(file: DASCTFAttachmentFile, index: number): string {
  if (typeof file.name === "string" && file.name.trim()) return file.name.trim()
  try {
    const segment = new URL(file.url ?? "", "https://dasctf.invalid/").pathname
      .split("/")
      .filter(Boolean)
      .at(-1)
    if (segment) return decodeURIComponent(segment)
  } catch {
    // Fall through to a deterministic display name.
  }
  const extension = file.extension ?? file.ext
  return `attachment-${index + 1}${extension ? `.${extension.replace(/^\./, "")}` : ""}`
}

function mapNotice(notice: DASCTFNotice): Announcement {
  const timestamp =
    typeof notice.createdAt === "string" && Number.isFinite(Date.parse(notice.createdAt))
      ? new Date(notice.createdAt).toISOString()
      : typeof notice.createdTime === "number" && Number.isFinite(notice.createdTime)
        ? new Date(notice.createdTime).toISOString()
        : new Date(0).toISOString()
  return {
    id: String(notice.id),
    title: notice.title?.trim() || "比赛公告",
    content: notice.content ?? "",
    publishedAt: timestamp,
    kind: "normal",
    rawType: notice.userName,
  }
}

function isManagedEnvironment(detail: DASCTFExerciseDetail): boolean {
  return (
    detail.isNeedInit === true ||
    detail.isNeedCheck === true ||
    (detail.endpoints?.length ?? 0) > 0 ||
    (typeof detail.endpointType === "string" && detail.endpointType.trim() !== "")
  )
}

function environmentFromDetail(
  detail: DASCTFExerciseDetail,
  challengeId: number,
): RemoteEnvironment | null {
  const selected = primaryEndpoint(detail)
  if (!selected && detail.isNeedCheck !== true) return null
  return {
    id: environmentId(challengeId),
    challengeId: String(challengeId),
    status: selected && detail.isNeedCheck !== true ? "running" : "starting",
    ...(selected ? { endpoint: selected.endpoint } : {}),
    ...(selected?.expiresAt ? { expiresAt: selected.expiresAt } : {}),
  }
}

function primaryEndpoint(
  detail: DASCTFExerciseDetail,
): { endpoint: string; expiresAt?: string } | undefined {
  const currentTime =
    typeof detail.currentTime === "number" && Number.isFinite(detail.currentTime)
      ? detail.currentTime
      : Date.now()
  for (const candidate of detail.endpoints ?? []) {
    const expiry = candidate.expireTime
    if (typeof expiry === "number" && Number.isFinite(expiry) && expiry <= currentTime) continue
    const expiresAt =
      typeof expiry === "number" && Number.isFinite(expiry)
        ? new Date(expiry).toISOString()
        : undefined
    if (candidate.isProxy === true) {
      const host = candidate.proxyIps?.find(nonEmptyText)
      for (const mapping of candidate.portMappings ?? []) {
        const port = validPort(mapping.proxy)
        if (host && port) {
          return { endpoint: formatEndpoint(host, port), ...(expiresAt ? { expiresAt } : {}) }
        }
      }
    }
    const host = candidate.exposeIps?.find(nonEmptyText)
    for (const rawPort of candidate.ports ?? []) {
      const port = validPort(rawPort)
      if (host && port) {
        return { endpoint: formatEndpoint(host, port), ...(expiresAt ? { expiresAt } : {}) }
      }
    }
  }
  return undefined
}

function formatEndpoint(host: string, port: number): string {
  const normalizedHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host
  return `${normalizedHost}:${port}`
}

function environmentGuide(
  detail: DASCTFExerciseDetail,
  environment: RemoteEnvironment | null,
): string | undefined {
  if (!isManagedEnvironment(detail)) return undefined
  const lines = [
    environment?.endpoint ? `Primary endpoint: ${environment.endpoint}` : "环境尚未就绪。",
  ]
  for (const [index, endpoint] of (detail.endpoints ?? []).entries()) {
    const users = (endpoint.users ?? [])
      .filter((user) => user.username || user.password)
      .map((user) => `${user.username ?? ""}${user.password ? ` / ${user.password}` : ""}`)
    if (users.length > 0) lines.push(`Endpoint ${index + 1} credentials: ${users.join(", ")}`)
  }
  return lines.join("\n")
}

function apiError(
  response: Response,
  apiCode: string,
  message: string | undefined,
  accessKey: string,
): DASCTFApiError {
  const safe = safeMessage(message, `DASCTF API 请求失败: HTTP ${response.status}`, accessKey)
  const kind = errorKind(response.status, safe)
  return new DASCTFApiError(
    safe,
    kind,
    response.status,
    apiCode,
    retryAfterMilliseconds(response.headers.get("retry-after")),
  )
}

function httpError(response: Response, label: string): DASCTFApiError {
  return new DASCTFApiError(
    `${label}: HTTP ${response.status}`,
    errorKind(response.status, ""),
    response.status,
    undefined,
    retryAfterMilliseconds(response.headers.get("retry-after")),
  )
}

function errorKind(status: number, message: string): DASCTFErrorKind {
  if (status === 401) return "authentication"
  if (status === 403) return "permission"
  if (status === 404) return "not_found"
  if (status === 429) return "rate_limited"
  if (status >= 500) return "http"
  if (/access\s*key|accesskey|认证|鉴权|未登录|unauthor/i.test(message)) {
    return "authentication"
  }
  if (/无权限|forbidden|permission/i.test(message)) return "permission"
  if (/限流|频繁|rate.?limit|too many/i.test(message)) return "rate_limited"
  return "business"
}

function retryAfterMilliseconds(value: string | null): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000)
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined
}

function safeMessage(value: string | undefined, fallback: string, secret?: string): string {
  const message = typeof value === "string" ? value.trim() : ""
  const safe = secret ? (message || fallback).split(secret).join("[redacted]") : message || fallback
  return safe.slice(0, 500)
}

function isAlreadyRecovered(message: string): boolean {
  return /未启动|不存在|无需回收|已经?回收|已释放|not found|not running/i.test(message)
}

function retryableEnvironmentError(message: string): DASCTFApiError {
  return new DASCTFApiError(message, "network")
}

function environmentId(challengeId: number): string {
  return `dasctf:${challengeId}`
}

function parseEnvironmentId(value: string): number | null {
  const match = /^dasctf:(\d+)$/.exec(value)
  return match?.[1] ? Number(match[1]) : null
}

function positiveId(value: string): number {
  if (!/^\d+$/.test(value) || Number(value) < 1)
    throw new Error(`DASCTF challenge id 无效: ${value}`)
  return Number(value)
}

function validPort(value: string | number | undefined): number | undefined {
  const port = Number(value)
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : undefined
}

function nonEmptyText(value: string): boolean {
  return value.trim() !== ""
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label}必须是对象`)
  }
  return value as Record<string, unknown>
}

function rejectUnknown(
  raw: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw new Error(`${label}包含未知字段: ${key}`)
  }
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} 必须是非空字符串`)
  return value.trim()
}

function optionalInteger(
  value: unknown,
  fallback: number,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`${label} 必须是 ${minimum} 到 ${maximum} 之间的整数`)
  }
  return Number(value)
}

async function waitForSignal(operation: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return await operation
  if (signal.aborted) throw abortReason(signal)
  return await new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal))
    signal.addEventListener("abort", onAbort, { once: true })
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort))
  })
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    throwIfAborted(signal)
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortReason(signal as AbortSignal))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal)
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason
  return new DOMException("aborted", "AbortError")
}
