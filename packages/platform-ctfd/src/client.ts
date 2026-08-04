import type { CTFdPlatformConfig } from "./config.ts"

interface CTFdEnvelope<T> {
  success: boolean
  data?: T
  errors?: unknown
}

export class CTFdApiError extends Error {
  constructor(
    message: string,
    readonly kind: "authentication" | "permission" | "not_found" | "rate_limited" | "http" | "network" | "protocol",
    readonly status?: number,
    readonly details?: unknown,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = "CTFdApiError"
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
    return await this.api<T>(path, { method: "POST", body: JSON.stringify(body) })
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
      throw new CTFdApiError(`CTFd 附件下载失败: HTTP ${response.status}`, kindForStatus(response.status), response.status)
    }
    return new Uint8Array(await response.arrayBuffer())
  }

  private async api<T>(path: string, init: RequestInit = {}): Promise<T> {
    const url = new URL(`api/v1/${path.replace(/^\/+/, "")}`, this.baseUrl)
    const response = await this.send(url, {
      ...init,
      redirect: "manual",
      headers: {
        Accept: "application/json",
        Authorization: `Token ${this.token}`,
        // CTFd's token middleware only inspects Authorization when Flask
        // considers the request JSON, including bodyless GET requests.
        "Content-Type": "application/json",
        ...init.headers,
      },
    })

    if (response.status >= 300 && response.status < 400) {
      throw new CTFdApiError("CTFd API 将请求重定向到登录页，请检查 access token", "authentication", response.status)
    }

    const contentType = response.headers.get("content-type") ?? ""
    if (!contentType.toLowerCase().includes("application/json")) {
      throw new CTFdApiError(`CTFd API 返回了非 JSON 响应: HTTP ${response.status}`, "protocol", response.status)
    }

    let envelope: CTFdEnvelope<T>
    try {
      envelope = await response.json() as CTFdEnvelope<T>
    } catch (error) {
      throw new CTFdApiError("无法解析 CTFd API 响应", "protocol", response.status, undefined, { cause: error })
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
    const messages = Object.entries(errors as Record<string, unknown>)
      .flatMap(([field, value]) => Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string").map((item) => `${field}: ${item}`)
        : typeof value === "string" ? [`${field}: ${value}`] : [])
    if (messages.length > 0) return messages.join("; ")
  }
  return `CTFd API 请求失败: HTTP ${status}`
}
