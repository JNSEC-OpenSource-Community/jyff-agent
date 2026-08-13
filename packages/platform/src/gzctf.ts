import { webcrypto } from "node:crypto"
import { waitForEndpointReachable } from "./endpoint-readiness.ts"
import type {
  Announcement,
  AnnouncementKind,
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

export type GZCTFAuthConfig =
  | { type: "password"; usernameSecret: string; passwordSecret: string }
  | { type: "cookie"; cookieSecret: string }

export interface GZCTFPlatformConfig {
  baseUrl: string
  gameId: number
  name?: string
  auth: GZCTFAuthConfig
  timeoutMs: number
  maxRequestAttempts: number
  retryBaseDelayMs: number
  cacheTtlMs: number
  submissionPollIntervalMs: number
  submissionTimeoutMs: number
}

const allowedKeys = new Set([
  "baseUrl",
  "gameId",
  "name",
  "auth",
  "timeoutMs",
  "maxRequestAttempts",
  "retryBaseDelayMs",
  "cacheTtlMs",
  "submissionPollIntervalMs",
  "submissionTimeoutMs",
])

export const gzctfConfig: PlatformConfig<GZCTFPlatformConfig> = {
  parse(value): GZCTFPlatformConfig {
    const raw = object(value, "GZCTF 平台配置")
    rejectUnknown(raw, allowedKeys, "GZCTF 平台配置")

    const baseUrl = text(raw.baseUrl, "GZCTF baseUrl").replace(/\/+$/, "")
    const url = new URL(baseUrl)
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("GZCTF baseUrl 仅支持 http 或 https")
    }
    if (url.username || url.password || url.search || url.hash) {
      throw new Error("GZCTF baseUrl 不能包含凭据、query 或 fragment")
    }

    const gameId = integer(raw.gameId, "GZCTF gameId", 1)
    const auth = parseAuth(raw.auth)
    const timeoutMs = optionalInteger(raw.timeoutMs, 15_000, "GZCTF timeoutMs", 1_000, 120_000)
    const maxRequestAttempts = optionalInteger(
      raw.maxRequestAttempts,
      3,
      "GZCTF maxRequestAttempts",
      1,
      10,
    )
    const retryBaseDelayMs = optionalInteger(
      raw.retryBaseDelayMs,
      250,
      "GZCTF retryBaseDelayMs",
      1,
      30_000,
    )
    const cacheTtlMs = optionalInteger(raw.cacheTtlMs, 5_000, "GZCTF cacheTtlMs", 250, 60_000)
    const submissionPollIntervalMs = optionalInteger(
      raw.submissionPollIntervalMs,
      500,
      "GZCTF submissionPollIntervalMs",
      50,
      10_000,
    )
    const submissionTimeoutMs = optionalInteger(
      raw.submissionTimeoutMs,
      30_000,
      "GZCTF submissionTimeoutMs",
      1_000,
      300_000,
    )
    if (raw.name !== undefined && (typeof raw.name !== "string" || raw.name.trim() === "")) {
      throw new Error("GZCTF name 必须是非空字符串")
    }

    return {
      baseUrl,
      gameId,
      auth,
      timeoutMs,
      maxRequestAttempts,
      retryBaseDelayMs,
      cacheTtlMs,
      submissionPollIntervalMs,
      submissionTimeoutMs,
      ...(typeof raw.name === "string" ? { name: raw.name.trim() } : {}),
    }
  },
}

export const gzctfSetup: PlatformSetupDescriptor = {
  label: "GZCTF",
  description: "使用玩家账号或 GZCTF_Token Cookie 参与指定比赛。",
  defaultConfig: {
    baseUrl: "https://gz.imxbt.cn",
    gameId: 1,
    auth: {
      type: "password",
      usernameSecret: "GZCTF_USERNAME",
      passwordSecret: "GZCTF_PASSWORD",
    },
  },
  fields: [
    {
      key: "baseUrl",
      label: "Base URL",
      type: "url",
      required: true,
      placeholder: "https://gz.imxbt.cn",
    },
    {
      key: "gameId",
      label: "Game ID",
      type: "integer",
      required: true,
      minimum: 1,
    },
  ],
  authStrategies: [
    {
      id: "password",
      label: "用户名和密码",
      config: {
        auth: {
          type: "password",
          usernameSecret: "GZCTF_USERNAME",
          passwordSecret: "GZCTF_PASSWORD",
        },
      },
      secrets: [
        {
          name: "GZCTF_USERNAME",
          label: "用户名",
          type: "text",
          required: true,
        },
        {
          name: "GZCTF_PASSWORD",
          label: "密码",
          type: "password",
          required: true,
        },
      ],
    },
    {
      id: "cookie",
      label: "浏览器 Cookie",
      config: { auth: { type: "cookie", cookieSecret: "GZCTF_COOKIE" } },
      secrets: [
        {
          name: "GZCTF_COOKIE",
          label: "GZCTF_Token Cookie",
          type: "cookie",
          required: true,
        },
      ],
    },
  ],
}

function parseAuth(value: unknown): GZCTFAuthConfig {
  if (value === undefined) {
    return {
      type: "password",
      usernameSecret: "GZCTF_USERNAME",
      passwordSecret: "GZCTF_PASSWORD",
    }
  }
  const raw = object(value, "GZCTF auth")
  const type = text(raw.type, "GZCTF auth.type")
  if (type === "password") {
    rejectUnknown(raw, new Set(["type", "usernameSecret", "passwordSecret"]), "GZCTF password auth")
    return {
      type,
      usernameSecret:
        raw.usernameSecret === undefined
          ? "GZCTF_USERNAME"
          : text(raw.usernameSecret, "GZCTF usernameSecret"),
      passwordSecret:
        raw.passwordSecret === undefined
          ? "GZCTF_PASSWORD"
          : text(raw.passwordSecret, "GZCTF passwordSecret"),
    }
  }
  if (type === "cookie") {
    rejectUnknown(raw, new Set(["type", "cookieSecret"]), "GZCTF cookie auth")
    return {
      type,
      cookieSecret:
        raw.cookieSecret === undefined
          ? "GZCTF_COOKIE"
          : text(raw.cookieSecret, "GZCTF cookieSecret"),
    }
  }
  throw new Error("GZCTF auth.type 必须是 password 或 cookie")
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${label}必须是对象`)
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

function integer(value: unknown, label: string, minimum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum)
    throw new Error(`${label} 必须是大于等于 ${minimum} 的整数`)
  return value as number
}

function optionalInteger(
  value: unknown,
  fallback: number,
  label: string,
  min: number,
  max: number,
): number {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`${label} 必须是 ${min} 到 ${max} 之间的整数`)
  }
  return value as number
}

const X25519_PUBLIC_KEY_BYTES = 32
const NONCE_BYTES = 12

/** Implements GZCTF's X25519 + SHA-256 + AES-256-GCM request encryption. */
export async function encryptGZCTFApiData(
  plainText: string,
  publicKey?: string | null,
): Promise<string> {
  if (!publicKey) return plainText
  if (plainText.length === 0) throw new Error("GZCTF 加密内容不能为空")

  let recipientBytes: Uint8Array
  try {
    recipientBytes = Buffer.from(publicKey, "base64")
  } catch (error) {
    throw new Error("GZCTF API 公钥不是有效的 Base64", { cause: error })
  }
  if (recipientBytes.byteLength !== X25519_PUBLIC_KEY_BYTES)
    throw new Error("GZCTF API 公钥长度无效")

  try {
    const recipientKey = await webcrypto.subtle.importKey(
      "raw",
      recipientBytes,
      "X25519",
      false,
      [],
    )
    const ephemeral = (await webcrypto.subtle.generateKey("X25519", true, [
      "deriveBits",
    ])) as webcrypto.CryptoKeyPair
    const shared = await webcrypto.subtle.deriveBits(
      { name: "X25519", public: recipientKey },
      ephemeral.privateKey,
      256,
    )
    const aesBytes = await webcrypto.subtle.digest("SHA-256", shared)
    const aesKey = await webcrypto.subtle.importKey(
      "raw",
      aesBytes,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt"],
    )
    const nonce = webcrypto.getRandomValues(new Uint8Array(NONCE_BYTES))
    const ciphertext = new Uint8Array(
      await webcrypto.subtle.encrypt(
        { name: "AES-GCM", iv: nonce, tagLength: 128 },
        aesKey,
        new TextEncoder().encode(plainText),
      ),
    )
    const ephemeralPublic = new Uint8Array(
      await webcrypto.subtle.exportKey("raw", ephemeral.publicKey),
    )
    return Buffer.concat([ephemeralPublic, nonce, ciphertext]).toString("base64")
  } catch (error) {
    throw new Error("无法按 GZCTF 协议加密 API 数据", { cause: error })
  }
}

export interface GZCTFClientConfig {
  apiPublicKey?: string | null
  title?: string
}

interface GZCTFErrorBody {
  title?: string
  status?: number
}

export class GZCTFApiError extends Error {
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
    this.name = "GZCTFApiError"
  }

  get retryable(): boolean {
    return (
      this.kind === "network" ||
      this.kind === "rate_limited" ||
      (this.kind === "http" && (this.status ?? 0) >= 500)
    )
  }
}

type GZCTFCredentials =
  | { type: "password"; username: string; password: string }
  | { type: "cookie"; cookie: string }

export class GZCTFClient {
  readonly baseUrl: URL
  readonly apiPublicKey?: string | null
  private readonly timeoutMs: number
  private cookie: string
  private reauthentication?: Promise<void>
  private authenticationVersion = 0

  private constructor(
    private readonly config: GZCTFPlatformConfig,
    cookie: string,
    private readonly credentials: GZCTFCredentials,
    private readonly clientConfig: GZCTFClientConfig,
    private readonly fetchFn: typeof fetch,
  ) {
    this.baseUrl = new URL(`${config.baseUrl}/`)
    this.timeoutMs = config.timeoutMs
    this.apiPublicKey = clientConfig.apiPublicKey
    this.cookie = cookie
  }

  static async connect(
    config: GZCTFPlatformConfig,
    credentials: GZCTFCredentials,
    fetchFn: typeof fetch = fetch,
  ): Promise<GZCTFClient> {
    const baseUrl = new URL(`${config.baseUrl}/`)
    const clientConfig = await retryRequest(
      () =>
        request<GZCTFClientConfig>(
          fetchFn,
          new URL("api/config", baseUrl),
          config.timeoutMs,
          "",
          {},
          true,
        ),
      config,
    )
    const cookie =
      credentials.type === "cookie"
        ? normalizeCookie(credentials.cookie)
        : await retryRequest(
            () => loginCookie(fetchFn, baseUrl, config.timeoutMs, clientConfig, credentials),
            config,
          )
    const client = new GZCTFClient(config, cookie, credentials, clientConfig, fetchFn)
    await client.get("account/profile")
    return client
  }

  async encrypt(value: string): Promise<string> {
    return await encryptGZCTFApiData(value, this.apiPublicKey)
  }

  async get<T>(path: string, signal?: AbortSignal): Promise<T> {
    return await this.api<T>(path, signal ? { signal } : {}, true)
  }

  async post<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    return await this.api<T>(
      path,
      {
        method: "POST",
        ...(signal ? { signal } : {}),
        ...(body === undefined
          ? {}
          : {
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            }),
      },
      true,
    )
  }

  async delete(path: string, signal?: AbortSignal): Promise<void> {
    await this.api(path, { method: "DELETE", ...(signal ? { signal } : {}) }, false)
  }

  async download(location: string): Promise<Uint8Array> {
    const url = new URL(location, this.baseUrl)
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new GZCTFApiError("GZCTF 返回了不支持的附件 URL", "protocol")
    }
    const sameOrigin = url.origin === this.baseUrl.origin
    try {
      const response = await this.execute(
        async () => {
          const result = await rawRequest(
            this.fetchFn,
            url,
            this.timeoutMs,
            sameOrigin ? this.cookie : "",
            {},
          )
          if (!result.ok) throw await errorFromResponse(result, "GZCTF 附件下载失败")
          return result
        },
        true,
        sameOrigin,
      )
      return new Uint8Array(await response.arrayBuffer())
    } catch (error) {
      throw requestContext(error, "GET", url)
    }
  }

  private async api<T>(path: string, init: RequestInit, expectJson: boolean): Promise<T> {
    const url = new URL(`api/${path.replace(/^\/+/, "")}`, this.baseUrl)
    const method = init.method ?? "GET"
    try {
      return await this.execute(
        () => request<T>(this.fetchFn, url, this.timeoutMs, this.cookie, init, expectJson),
        method === "GET" || method === "HEAD",
        true,
        init.signal ?? undefined,
      )
    } catch (error) {
      throw requestContext(error, method, url)
    }
  }

  private async execute<T>(
    operation: () => Promise<T>,
    retryableMethod: boolean,
    allowReauthentication: boolean,
    signal?: AbortSignal,
  ): Promise<T> {
    let authenticatedAgain = false
    let authenticationVersion = this.authenticationVersion
    for (let attempt = 1; ; attempt += 1) {
      throwIfAborted(signal)
      try {
        return await operation()
      } catch (error) {
        if (
          allowReauthentication &&
          !authenticatedAgain &&
          error instanceof GZCTFApiError &&
          error.kind === "authentication" &&
          this.credentials.type === "password"
        ) {
          if (authenticationVersion === this.authenticationVersion) {
            await this.reauthenticate()
          }
          authenticatedAgain = true
          authenticationVersion = this.authenticationVersion
          attempt -= 1
          continue
        }
        if (
          !retryableMethod ||
          !isRetryableGZCTFError(error) ||
          attempt >= this.config.maxRequestAttempts
        ) {
          throw error
        }
        await delay(retryDelay(this.config.retryBaseDelayMs, attempt), signal)
      }
    }
  }

  private async reauthenticate(): Promise<void> {
    if (this.credentials.type !== "password") return
    if (!this.reauthentication) {
      this.reauthentication = retryRequest(
        () =>
          loginCookie(
            this.fetchFn,
            this.baseUrl,
            this.timeoutMs,
            this.clientConfig,
            this.credentials as Extract<GZCTFCredentials, { type: "password" }>,
          ),
        this.config,
      )
        .then((cookie) => {
          this.cookie = cookie
          this.authenticationVersion += 1
        })
        .finally(() => {
          this.reauthentication = undefined
        })
    }
    await this.reauthentication
  }
}

async function loginCookie(
  fetchFn: typeof fetch,
  baseUrl: URL,
  timeoutMs: number,
  clientConfig: GZCTFClientConfig,
  credentials: Extract<GZCTFCredentials, { type: "password" }>,
): Promise<string> {
  const encryptedPassword = await encryptGZCTFApiData(
    credentials.password,
    clientConfig.apiPublicKey,
  )
  const response = await rawRequest(fetchFn, new URL("api/account/login", baseUrl), timeoutMs, "", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      userName: credentials.username,
      password: encryptedPassword,
    }),
  })
  await ensureSuccess(response)
  return extractAuthCookie(response.headers)
}

async function retryRequest<T>(
  operation: () => Promise<T>,
  config: Pick<GZCTFPlatformConfig, "maxRequestAttempts" | "retryBaseDelayMs">,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      if (!isRetryableGZCTFError(error) || attempt >= config.maxRequestAttempts) {
        throw error
      }
      await delay(retryDelay(config.retryBaseDelayMs, attempt))
    }
  }
}

function retryDelay(baseDelayMs: number, attempt: number): number {
  const exponential = Math.min(30_000, baseDelayMs * 2 ** (attempt - 1))
  return Math.max(1, Math.round(exponential * (0.8 + Math.random() * 0.4)))
}

function isRetryableGZCTFError(error: unknown): boolean {
  return error instanceof GZCTFApiError && error.retryable
}

function requestContext(error: unknown, method: string, url: URL): Error {
  if (!(error instanceof GZCTFApiError))
    return error instanceof Error ? error : new Error(String(error))
  return new GZCTFApiError(
    `${method} ${url.pathname}${url.search}: ${error.message}`,
    error.kind,
    error.status,
    error.details,
    { cause: error },
  )
}

async function request<T>(
  fetchFn: typeof fetch,
  url: URL,
  timeoutMs: number,
  cookie: string,
  init: RequestInit,
  expectJson: boolean,
): Promise<T> {
  const response = await rawRequest(fetchFn, url, timeoutMs, cookie, init)
  await ensureSuccess(response)
  if (!expectJson) return undefined as T
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? ""
  if (!contentType.includes("application/json")) {
    throw new GZCTFApiError(
      `GZCTF API 返回了非 JSON 响应: HTTP ${response.status}`,
      "protocol",
      response.status,
    )
  }
  try {
    return (await response.json()) as T
  } catch (error) {
    if (init.signal?.aborted) throw abortReason(init.signal)
    if (
      error instanceof DOMException &&
      (error.name === "AbortError" || error.name === "TimeoutError")
    ) {
      throw new GZCTFApiError(`GZCTF 请求超过 ${timeoutMs}ms`, "network", undefined, undefined, {
        cause: error,
      })
    }
    throw new GZCTFApiError("无法解析 GZCTF API 响应", "protocol", response.status, undefined, {
      cause: error,
    })
  }
}

async function rawRequest(
  fetchFn: typeof fetch,
  url: URL,
  timeoutMs: number,
  cookie: string,
  init: RequestInit,
): Promise<Response> {
  const callerSignal = init.signal ?? undefined
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal
  try {
    const headers = new Headers(init.headers)
    headers.set("Accept", headers.get("Accept") ?? "application/json")
    if (cookie && !headers.has("Cookie")) headers.set("Cookie", cookie)
    return await fetchFn(url, {
      ...init,
      redirect: "manual",
      signal,
      headers,
    })
  } catch (error) {
    if (callerSignal?.aborted) throw abortReason(callerSignal)
    const timeout = timeoutSignal.aborted
    throw new GZCTFApiError(
      timeout ? `GZCTF 请求超过 ${timeoutMs}ms` : "无法连接 GZCTF",
      "network",
      undefined,
      undefined,
      { cause: error },
    )
  }
}

async function ensureSuccess(response: Response): Promise<void> {
  if (response.status >= 300 && response.status < 400) {
    throw new GZCTFApiError(
      "GZCTF API 将请求重定向到登录页，请检查登录凭据或 Cookie",
      "authentication",
      response.status,
    )
  }
  if (!response.ok) throw await errorFromResponse(response, "GZCTF API 请求失败")
}

async function errorFromResponse(response: Response, fallback: string): Promise<GZCTFApiError> {
  let details: unknown
  let message = `${fallback}: HTTP ${response.status}`
  if (response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    try {
      details = await response.json()
      const title = (details as GZCTFErrorBody | null)?.title
      if (typeof title === "string" && title.trim()) message = title
    } catch {
      // Preserve the HTTP error when an error body is malformed.
    }
  }
  return new GZCTFApiError(message, kindForStatus(response.status), response.status, details)
}

function kindForStatus(status: number): GZCTFApiError["kind"] {
  if (status === 401) return "authentication"
  if (status === 403) return "permission"
  if (status === 404) return "not_found"
  if (status === 429) return "rate_limited"
  return "http"
}

function normalizeCookie(value: string): string {
  const cookie = value.trim()
  if (!cookie) throw new Error("GZCTF Cookie secret 不能为空")
  if (!cookie.includes("=")) return `GZCTF_Token=${cookie}`
  const match = /(?:^|;\s*)GZCTF_Token=([^;]+)/i.exec(cookie)
  if (!match?.[1]) throw new Error("GZCTF Cookie secret 不包含 GZCTF_Token")
  return `GZCTF_Token=${match[1]}`
}

function extractAuthCookie(headers: Headers): string {
  const values =
    typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : [headers.get("set-cookie") ?? ""]
  for (const value of values) {
    const match = /(?:^|[,;]\s*)GZCTF_Token=([^;,]+)/i.exec(value)
    if (match?.[1]) return `GZCTF_Token=${match[1]}`
  }
  throw new GZCTFApiError("GZCTF 登录成功但响应未设置 GZCTF_Token Cookie", "protocol")
}

interface GZCTFGame {
  id?: number
  title?: string
}

interface GZCTFChallengeSummary {
  id: number
  title: string
  category: string
  score: number
  type?: GZCTFChallengeDetail["type"]
  context?: GZCTFChallengeDetail["context"]
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

const noticeKinds: Record<string, AnnouncementKind> = {
  Normal: "normal",
  FirstBlood: "solve_broadcast",
  SecondBlood: "solve_broadcast",
  ThirdBlood: "solve_broadcast",
  NewHint: "hint",
  NewChallenge: "new_challenge",
}

const noticeTitles: Record<string, string> = {
  Normal: "比赛公告",
  FirstBlood: "一血",
  SecondBlood: "二血",
  ThirdBlood: "三血",
  NewHint: "新提示",
  NewChallenge: "新题目",
}

class AsyncTtlCache<T> {
  private value?: T
  private hasValue = false
  private expiresAt = 0
  private pending?: Promise<T>
  private generation = 0

  constructor(private readonly ttlMs: number) {}

  async get(load: () => Promise<T>): Promise<T> {
    if (this.hasValue && Date.now() < this.expiresAt) return this.value as T
    if (this.pending) return await this.pending
    const generation = this.generation
    const pending = load()
      .then((value) => {
        if (this.generation === generation) {
          this.value = value
          this.hasValue = true
          this.expiresAt = Date.now() + this.ttlMs
        }
        return value
      })
      .finally(() => {
        if (this.pending === pending) this.pending = undefined
      })
    this.pending = pending
    return await pending
  }

  clear(): void {
    this.generation += 1
    this.hasValue = false
    this.expiresAt = 0
    this.pending = undefined
  }
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
    private readonly loadDetail: () => Promise<GZCTFChallengeDetail>,
    private readonly invalidate: () => void,
  ) {
    this.solved = solved
    this.info = mapChallengeInfo(detail, solved)
    if (isContainer(detail.type)) {
      this.instance = {
        start: async (signal) => {
          const existing = await this.getInstanceStatus(signal)
          if (existing) return existing
          try {
            const container = await this.client.post<GZCTFContainer>(
              this.containerPath(),
              undefined,
              signal,
            )
            this.invalidate()
            return this.remember(mapContainer(this.environmentId(), this.challengeId, container))
          } catch (error) {
            // POST may have reached GZCTF even when its response was lost, and
            // GZCTF reports an already-created instance as an error. Re-read
            // status before exposing a noisy/non-idempotent failure to Agent.
            this.invalidate()
            try {
              const created = await this.getInstanceStatus(signal)
              if (created) return created
            } catch {
              // Preserve the original start failure; it carries retryability.
            }
            throw error
          }
        },
        waitUntilReady: async (environment, signal) =>
          await this.waitUntilReady(environment, signal),
        status: async () => await this.getInstanceStatus(),
        destroy: async () => await this.destroyInstance(),
      }
    }
  }

  async getInfo(): Promise<ChallengeInfo> {
    if (!this.info) this.info = mapChallengeInfo(await this.detail(), this.solved)
    return this.info
  }

  async downloadAttachment(
    attachmentId: string,
  ): Promise<{ attachment: Attachment; content: Uint8Array }> {
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
    const submitId = await this.client.post<number>(this.challengePath(), {
      flag: encrypted,
    })
    if (!Number.isInteger(submitId) || submitId < 1) {
      throw new GZCTFApiError("GZCTF 提交响应缺少有效 submission id", "protocol")
    }

    const deadline = Date.now() + this.config.submissionTimeoutMs
    while (Date.now() < deadline) {
      const status = await this.client.get<string>(`${this.challengePath()}/status/${submitId}`)
      if (status === "Accepted") {
        this.solved = true
        this.invalidate()
        return { status: "accepted", message: "Accepted" }
      }
      if (status === "WrongAnswer" || status === "CheatDetected" || status === "NotFound") {
        return { status: "rejected", message: status }
      }
      if (status !== "FlagSubmitted") {
        throw new GZCTFApiError(`GZCTF 返回了未知判题状态: ${status}`, "protocol")
      }
      await delay(
        Math.min(this.config.submissionPollIntervalMs, Math.max(0, deadline - Date.now())),
      )
    }
    throw new GZCTFApiError(`GZCTF 判题超过 ${this.config.submissionTimeoutMs}ms`, "network")
  }

  private async detail(): Promise<GZCTFChallengeDetail> {
    return await this.loadDetail()
  }

  private async getInstanceStatus(signal?: AbortSignal): Promise<RemoteEnvironment | null> {
    throwIfAborted(signal)
    const detail = signal
      ? await this.client.get<GZCTFChallengeDetail>(this.challengePath(), signal)
      : await this.detail()
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
      ...(context.closeTime ? { expiresAt: platformTimestamp(context.closeTime) } : {}),
    })
  }

  private async waitUntilReady(
    initial: RemoteEnvironment,
    signal?: AbortSignal,
  ): Promise<RemoteEnvironment> {
    const deadline = Date.now() + 3 * 60_000
    let environment: RemoteEnvironment | null = initial
    while (Date.now() < deadline) {
      throwIfAborted(signal)
      if (environment.status === "running" && environment.endpoint) {
        await waitForEndpointReachable(environment.endpoint, signal, {
          timeoutMs: Math.max(1, deadline - Date.now()),
          retryDelayMs: Math.max(250, this.config.retryBaseDelayMs),
        })
        return this.remember({ ...environment, readyAt: new Date().toISOString() })
      }
      await delay(Math.min(1_000, Math.max(1, deadline - Date.now())), signal)
      environment = await this.getInstanceStatus(signal)
      if (!environment) break
    }
    throw new GZCTFApiError("GZCTF 远程环境在启动期限内未通过 endpoint 就绪检测", "network")
  }

  private async destroyInstance(): Promise<void> {
    // Solver shutdown calls destroy for every container-capable challenge. Avoid
    // turning "never started" into a noisy platform error.
    if (!(await this.getInstanceStatus())) return
    let firstError: unknown
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        await this.client.delete(this.containerPath())
        this.invalidate()
        this.environments.delete(this.environmentId())
        return
      } catch (error) {
        firstError ??= error
        this.invalidate()
        try {
          if (!(await this.getInstanceStatus())) return
        } catch {
          // Preserve the first DELETE failure if verification also failed.
        }
        if (attempt < 2) await delay(this.config.retryBaseDelayMs)
      }
    }
    throw firstError
  }

  private remember(environment: RemoteEnvironment): RemoteEnvironment {
    this.environments.set(environment.id, environment)
    return environment
  }

  private environmentId(): string {
    return `${this.gameId}:${this.challengeId}`
  }
  private challengePath(): string {
    return `game/${this.gameId}/challenges/${this.challengeId}`
  }
  private containerPath(): string {
    return `game/${this.gameId}/container/${this.challengeId}`
  }
}

class GZCTFProject implements PlatformProject {
  private readonly environments = new Map<string, RemoteEnvironment>()
  private readonly game: AsyncTtlCache<GZCTFGame>
  private readonly details: AsyncTtlCache<GZCTFGameDetails>
  private readonly notices: AsyncTtlCache<GZCTFNotice[]>
  private readonly challengeDetails = new Map<number, AsyncTtlCache<GZCTFChallengeDetail>>()

  constructor(
    private readonly project: { id: string; name: string },
    private readonly config: GZCTFPlatformConfig,
    private readonly client: GZCTFClient,
  ) {
    this.game = new AsyncTtlCache(Math.max(30_000, config.cacheTtlMs * 6))
    this.details = new AsyncTtlCache(config.cacheTtlMs)
    this.notices = new AsyncTtlCache(Math.max(30_000, config.cacheTtlMs * 6))
  }

  async refresh(): Promise<ContestOverview> {
    this.game.clear()
    this.details.clear()
    this.notices.clear()
    for (const cache of this.challengeDetails.values()) cache.clear()
    return await this.getOverview()
  }

  async getOverview(): Promise<ContestOverview> {
    const [game, challenges, announcements] = await Promise.all([
      this.game.get(async () => await this.client.get<GZCTFGame>(`game/${this.config.gameId}`)),
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
    return Object.values(details.challenges ?? {})
      .flat()
      .map((challenge) => ({
        id: String(challenge.id),
        title: challenge.title,
        category: challenge.category,
        score: challenge.score,
        solved: solved.has(challenge.id),
        ...(challenge.type === undefined ? {} : { needsEnv: isContainer(challenge.type) }),
        ...(challenge.context === undefined
          ? {}
          : { hasAttachments: Boolean(challenge.context.url) }),
      }))
  }

  async listAnnouncements(): Promise<Announcement[]> {
    const notices = await this.notices.get(
      async () =>
        await this.client.get<GZCTFNotice[]>(`game/${this.config.gameId}/notices?count=100&skip=0`),
    )
    return notices.map((notice) => ({
      id: String(notice.id),
      title: noticeTitles[notice.type] ?? notice.type,
      content: notice.values.join(" · "),
      publishedAt: new Date(notice.time).toISOString(),
      kind: noticeKinds[notice.type] ?? "unknown",
      rawType: notice.type,
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
    if (challengeId === null || !this.environments.has(id))
      throw new Error(`未知 GZCTF 远程实例: ${id}`)
    const capability = await this.bindChallenge(String(challengeId))
    if (!capability.instance) throw new Error(`GZCTF 题目 ${challengeId} 不是容器题`)
    await capability.instance.destroy()
  }

  async bindChallenge(challengeId: string): Promise<ChallengeCapability> {
    const id = positiveId(challengeId)
    const [detail, game] = await Promise.all([this.challengeDetail(id), this.gameDetails()])
    const solved = game.rank?.solvedChallenges?.some((item) => item.id === id) === true
    return new GZCTFChallengeCapability(
      this.config.gameId,
      id,
      this.client,
      this.config,
      solved,
      detail,
      this.environments,
      async () => await this.challengeDetail(id),
      () => this.invalidateChallenge(id),
    )
  }

  async close(): Promise<void> {}

  private async gameDetails(): Promise<GZCTFGameDetails> {
    return await this.details.get(
      async () => await this.client.get<GZCTFGameDetails>(`game/${this.config.gameId}/details`),
    )
  }

  private async challengeDetail(id: number): Promise<GZCTFChallengeDetail> {
    let cache = this.challengeDetails.get(id)
    if (!cache) {
      cache = new AsyncTtlCache(this.config.cacheTtlMs)
      this.challengeDetails.set(id, cache)
    }
    return await cache.get(
      async () =>
        await this.client.get<GZCTFChallengeDetail>(`game/${this.config.gameId}/challenges/${id}`),
    )
  }

  private invalidateChallenge(id: number): void {
    this.challengeDetails.get(id)?.clear()
    this.details.clear()
  }
}

export class GZCTFPlatformPlugin implements PlatformPlugin {
  readonly id = "gzctf"
  readonly config = gzctfConfig
  readonly setup = gzctfSetup

  async connect(options: PlatformConnectOptions): Promise<PlatformProject> {
    const config = this.config.parse(options.config)
    const credentials = resolveCredentials(config, (name) => options.resolveSecret(name))
    const client = await GZCTFClient.connect(config, credentials)
    return new GZCTFProject(options.project, config, client)
  }
}

export const gzctfPlatform = new GZCTFPlatformPlugin()

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
  const hints = detail.hints?.length
    ? `\n\n## Hints\n\n${detail.hints.map((hint) => `- ${hint}`).join("\n")}`
    : ""
  return {
    id: String(detail.id ?? ""),
    title: detail.title ?? `Challenge ${detail.id ?? ""}`,
    category: detail.category ?? "unknown",
    score: detail.score ?? 0,
    solved,
    needsEnv: isContainer(detail.type),
    hasAttachments: attachment !== undefined,
    description: `${detail.content ?? ""}${hints}`,
    attachments: attachment ? [attachment] : [],
    ...(context?.instanceEntry ? { environmentGuide: context.instanceEntry } : {}),
  }
}

function platformTimestamp(value: number): string {
  const milliseconds = value < 1_000_000_000_000 ? value * 1_000 : value
  return new Date(milliseconds).toISOString()
}

function attachmentFor(
  detail: GZCTFChallengeDetail,
  downloadedSize?: number,
): Attachment | undefined {
  const location = detail.context?.url
  if (!location) return undefined
  let name = "attachment"
  try {
    const segment = new URL(location, "https://gzctf.invalid/").pathname
      .split("/")
      .filter(Boolean)
      .at(-1)
    if (segment) name = decodeURIComponent(segment)
  } catch {
    // The download path remains authoritative even when its display name is malformed.
  }
  const size = downloadedSize ?? detail.context?.fileSize ?? undefined
  return { id: "attachment", name, ...(size === undefined ? {} : { size }) }
}

function mapContainer(
  id: string,
  challengeId: number,
  container: GZCTFContainer,
): RemoteEnvironment {
  return {
    id,
    challengeId: String(challengeId),
    status:
      container.status === "Running"
        ? "running"
        : container.status === "Destroyed"
          ? "stopped"
          : "starting",
    ...(container.entry ? { endpoint: container.entry } : {}),
  }
}

function isContainer(type: GZCTFChallengeDetail["type"]): boolean {
  return type === "StaticContainer" || type === "DynamicContainer"
}

function positiveId(value: string): number {
  if (!/^\d+$/.test(value) || Number(value) < 1)
    throw new Error(`GZCTF challenge id 无效: ${value}`)
  return Number(value)
}

function parseEnvironmentId(value: string, gameId: number): number | null {
  const match = new RegExp(`^${gameId}:(\\d+)$`).exec(value)
  return match?.[1] ? Number(match[1]) : null
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
