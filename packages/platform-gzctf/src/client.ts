import type { GZCTFPlatformConfig } from "./config.ts"
import { encryptGZCTFApiData } from "./crypto.ts"

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
    readonly kind: "authentication" | "permission" | "not_found" | "rate_limited" | "http" | "network" | "protocol",
    readonly status?: number,
    readonly details?: unknown,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = "GZCTFApiError"
  }
}

export class GZCTFClient {
  readonly baseUrl: URL
  readonly apiPublicKey?: string | null
  private readonly timeoutMs: number

  private constructor(
    config: GZCTFPlatformConfig,
    private readonly cookie: string,
    clientConfig: GZCTFClientConfig,
    private readonly fetchFn: typeof fetch,
  ) {
    this.baseUrl = new URL(`${config.baseUrl}/`)
    this.timeoutMs = config.timeoutMs
    this.apiPublicKey = clientConfig.apiPublicKey
  }

  static async connect(
    config: GZCTFPlatformConfig,
    credentials: { type: "password"; username: string; password: string } | { type: "cookie"; cookie: string },
    fetchFn: typeof fetch = fetch,
  ): Promise<GZCTFClient> {
    const clientConfig = await request<GZCTFClientConfig>(
      fetchFn, new URL("api/config", `${config.baseUrl}/`), config.timeoutMs, "", {}, true,
    )
    let cookie: string
    if (credentials.type === "cookie") {
      cookie = normalizeCookie(credentials.cookie)
    } else {
      const encryptedPassword = await encryptGZCTFApiData(credentials.password, clientConfig.apiPublicKey)
      const response = await rawRequest(fetchFn, new URL("api/account/login", `${config.baseUrl}/`), config.timeoutMs, "", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userName: credentials.username, password: encryptedPassword }),
      })
      await ensureSuccess(response)
      cookie = extractAuthCookie(response.headers)
    }
    const client = new GZCTFClient(config, cookie, clientConfig, fetchFn)
    await client.get("account/profile")
    return client
  }

  async encrypt(value: string): Promise<string> {
    return await encryptGZCTFApiData(value, this.apiPublicKey)
  }

  async get<T>(path: string): Promise<T> {
    return await this.api<T>(path, {}, true)
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    return await this.api<T>(path, {
      method: "POST",
      ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    }, true)
  }

  async delete(path: string): Promise<void> {
    await this.api(path, { method: "DELETE" }, false)
  }

  async download(location: string): Promise<Uint8Array> {
    const url = new URL(location, this.baseUrl)
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new GZCTFApiError("GZCTF 返回了不支持的附件 URL", "protocol")
    }
    const response = await rawRequest(
      this.fetchFn, url, this.timeoutMs, url.origin === this.baseUrl.origin ? this.cookie : "", {},
    )
    if (!response.ok) throw await errorFromResponse(response, "GZCTF 附件下载失败")
    return new Uint8Array(await response.arrayBuffer())
  }

  private async api<T>(path: string, init: RequestInit, expectJson: boolean): Promise<T> {
    const url = new URL(`api/${path.replace(/^\/+/, "")}`, this.baseUrl)
    return await request<T>(this.fetchFn, url, this.timeoutMs, this.cookie, init, expectJson)
  }
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
    throw new GZCTFApiError(`GZCTF API 返回了非 JSON 响应: HTTP ${response.status}`, "protocol", response.status)
  }
  try {
    return await response.json() as T
  } catch (error) {
    throw new GZCTFApiError("无法解析 GZCTF API 响应", "protocol", response.status, undefined, { cause: error })
  }
}

async function rawRequest(
  fetchFn: typeof fetch,
  url: URL,
  timeoutMs: number,
  cookie: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await fetchFn(url, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        Accept: "application/json",
        ...(cookie ? { Cookie: cookie } : {}),
        ...init.headers,
      },
    })
  } catch (error) {
    const timeout = error instanceof DOMException && error.name === "TimeoutError"
    throw new GZCTFApiError(
      timeout ? `GZCTF 请求超过 ${timeoutMs}ms` : "无法连接 GZCTF",
      "network", undefined, undefined, { cause: error },
    )
  }
}

async function ensureSuccess(response: Response): Promise<void> {
  if (response.status >= 300 && response.status < 400) {
    throw new GZCTFApiError("GZCTF API 将请求重定向到登录页，请检查登录凭据或 Cookie", "authentication", response.status)
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
  const values = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [headers.get("set-cookie") ?? ""]
  for (const value of values) {
    const match = /(?:^|[,;]\s*)GZCTF_Token=([^;,]+)/i.exec(value)
    if (match?.[1]) return `GZCTF_Token=${match[1]}`
  }
  throw new GZCTFApiError("GZCTF 登录成功但响应未设置 GZCTF_Token Cookie", "protocol")
}
