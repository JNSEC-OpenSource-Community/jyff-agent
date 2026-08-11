import { randomUUID } from "node:crypto"
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import type {
  AuthPrompt,
  Credential,
  CredentialInfo,
  CredentialStore,
  Models,
} from "@earendil-works/pi-ai"
import { builtinModels } from "@earendil-works/pi-ai/providers/all"
import type {
  DashboardModelAuthentication,
  ModelAuthCredentialType,
  ModelAuthenticationView,
  ModelAuthImportResult,
  ModelAuthLoginSessionView,
  ModelAuthMethodId,
  ModelAuthProviderId,
} from "../types.ts"

const PROVIDERS: ReadonlyArray<{
  id: ModelAuthProviderId
  name: string
  description: string
  methods: ModelAuthenticationView["providers"][number]["methods"]
}> = [
  {
    id: "openai-codex",
    name: "OpenAI Codex",
    description: "使用 ChatGPT Plus / Pro 订阅调用 Codex 原生 Responses。",
    methods: [
      {
        id: "oauth_browser",
        label: "浏览器登录",
        description: "通过 localhost 回调完成 ChatGPT OAuth。",
      },
      {
        id: "oauth_device",
        label: "Device Code",
        description: "适合容器、WSL 或无法接收本地回调的环境。",
      },
    ],
  },
  {
    id: "anthropic",
    name: "Claude",
    description: "使用 Claude Pro / Max OAuth，或 Anthropic Console API Key。",
    methods: [
      {
        id: "oauth_browser",
        label: "Claude 登录",
        description: "通过浏览器授权 Claude 订阅凭据。",
      },
      {
        id: "api_key",
        label: "API Key",
        description: "使用 Anthropic Console API Key。",
        requiresSecret: true,
      },
      {
        id: "oauth_token",
        label: "OAuth Token",
        description: "使用 Claude Code setup-token 或 ANTHROPIC_AUTH_TOKEN。",
        requiresSecret: true,
      },
    ],
  },
  {
    id: "openai",
    name: "OpenAI API",
    description: "使用 OpenAI Platform API Key，按 API 用量计费。",
    methods: [
      {
        id: "api_key",
        label: "API Key",
        description: "使用 OpenAI Platform API Key。",
        requiresSecret: true,
      },
    ],
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    description: "使用 DeepSeek Platform API Key，兼容 OpenAI 协议。",
    methods: [
      {
        id: "api_key",
        label: "API Key",
        description: "使用 DeepSeek API Key。",
        requiresSecret: true,
      },
    ],
  },
  {
    id: "nvidia",
    name: "NVIDIA NIM",
    description: "使用 NVIDIA NIM API Key 调用开源模型。",
    methods: [
      {
        id: "api_key",
        label: "API Key",
        description: "使用 NVIDIA API Key。",
        requiresSecret: true,
      },
    ],
  },
  {
    id: "google",
    name: "Google Gemini",
    description: "使用 Gemini API Key 调用 Google AI Studio。",
    methods: [
      {
        id: "api_key",
        label: "API Key",
        description: "使用 GEMINI_API_KEY。",
        requiresSecret: true,
      },
    ],
  },
  {
    id: "mistral",
    name: "Mistral",
    description: "使用 Mistral Platform API Key。",
    methods: [
      {
        id: "api_key",
        label: "API Key",
        description: "使用 MISTRAL_API_KEY。",
        requiresSecret: true,
      },
    ],
  },
  {
    id: "groq",
    name: "Groq",
    description: "使用 Groq API Key，高速推理。",
    methods: [
      {
        id: "api_key",
        label: "API Key",
        description: "使用 GROQ_API_KEY。",
        requiresSecret: true,
      },
    ],
  },
  {
    id: "cerebras",
    name: "Cerebras",
    description: "使用 Cerebras API Key。",
    methods: [
      {
        id: "api_key",
        label: "API Key",
        description: "使用 CEREBRAS_API_KEY。",
        requiresSecret: true,
      },
    ],
  },
  {
    id: "xai",
    name: "xAI",
    description: "使用 xAI (Grok) API Key。",
    methods: [
      {
        id: "api_key",
        label: "API Key",
        description: "使用 XAI_API_KEY。",
        requiresSecret: true,
      },
    ],
  },
  {
    id: "fireworks",
    name: "Fireworks",
    description: "使用 Fireworks AI API Key。",
    methods: [
      {
        id: "api_key",
        label: "API Key",
        description: "使用 FIREWORKS_API_KEY。",
        requiresSecret: true,
      },
    ],
  },
  {
    id: "together",
    name: "Together AI",
    description: "使用 Together AI API Key。",
    methods: [
      {
        id: "api_key",
        label: "API Key",
        description: "使用 TOGETHER_API_KEY。",
        requiresSecret: true,
      },
    ],
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    description: "使用 OpenRouter API Key，统一接入多种模型。",
    methods: [
      {
        id: "api_key",
        label: "API Key",
        description: "使用 OPENROUTER_API_KEY。",
        requiresSecret: true,
      },
    ],
  },
  {
    id: "huggingface",
    name: "Hugging Face",
    description: "使用 Hugging Face Inference API。",
    methods: [
      {
        id: "api_key",
        label: "API Key",
        description: "使用 HF_TOKEN。",
        requiresSecret: true,
      },
    ],
  },
  {
    id: "moonshotai",
    name: "Moonshot AI",
    description: "使用 Moonshot AI (Kimi) API Key。",
    methods: [
      {
        id: "api_key",
        label: "API Key",
        description: "使用 MOONSHOT_API_KEY。",
        requiresSecret: true,
      },
    ],
  },
  {
    id: "ant-ling",
    name: "Ant Ling",
    description: "使用 Ant Ling API Key。",
    methods: [
      {
        id: "api_key",
        label: "API Key",
        description: "使用 ANT_LING_API_KEY。",
        requiresSecret: true,
      },
    ],
  },
  {
    id: "azure-openai-responses",
    name: "Azure OpenAI",
    description: "使用 Azure OpenAI Service API Key + Base URL。",
    methods: [
      {
        id: "api_key",
        label: "API Key",
        description: "使用 AZURE_OPENAI_API_KEY。",
        requiresSecret: true,
      },
    ],
  },
  {
    id: "vercel-ai-gateway",
    name: "Vercel AI Gateway",
    description: "使用 Vercel AI Gateway API Key。",
    methods: [
      {
        id: "api_key",
        label: "API Key",
        description: "使用 AI_GATEWAY_API_KEY。",
        requiresSecret: true,
      },
    ],
  },
  {
    id: "cloudflare-ai-gateway",
    name: "Cloudflare AI Gateway",
    description: "使用 Cloudflare AI Gateway API Key。",
    methods: [
      {
        id: "api_key",
        label: "API Key",
        description: "使用 CLOUDFLARE_API_KEY + Gateway 凭据。",
        requiresSecret: true,
      },
    ],
  },
  {
    id: "kimi-coding",
    name: "Kimi For Coding",
    description: "使用 Moonshot AI 订阅端点的 Anthropic 兼容 API。",
    methods: [
      {
        id: "api_key",
        label: "API Key",
        description: "使用 KIMI_API_KEY。",
        requiresSecret: true,
      },
    ],
  },
  {
    id: "opencode",
    name: "OpenCode Zen",
    description: "使用 OpenCode Zen API。",
    methods: [
      {
        id: "api_key",
        label: "API Key",
        description: "使用 OPENCODE_API_KEY。",
        requiresSecret: true,
      },
    ],
  },
  {
    id: "opencode-go",
    name: "OpenCode Go",
    description: "使用 OpenCode Go API。",
    methods: [
      {
        id: "api_key",
        label: "API Key",
        description: "使用 OPENCODE_API_KEY。",
        requiresSecret: true,
      },
    ],
  },
  {
    id: "zai",
    name: "ZAI Coding Plan",
    description: "使用 ZAI Coding Plan API Key。",
    methods: [
      {
        id: "api_key",
        label: "API Key",
        description: "使用 ZAI_API_KEY。",
        requiresSecret: true,
      },
    ],
  },
  {
    id: "minimax",
    name: "MiniMax",
    description: "使用 MiniMax API Key。",
    methods: [
      {
        id: "api_key",
        label: "API Key",
        description: "使用 MINIMAX_API_KEY。",
        requiresSecret: true,
      },
    ],
  },
]

const PROVIDER_IDS = new Set<ModelAuthProviderId>(PROVIDERS.map((provider) => provider.id))

export interface FileModelAuthenticationOptions {
  storagePath: string
  importPath?: string
  models?: Models
}

/**
 * Pi credential store backed by one atomically replaced JSON file. All writes
 * share one process-local queue, which also prevents concurrent OAuth refreshes
 * from rotating the same refresh token twice in this single-service runtime.
 */
export class FileCredentialStore implements CredentialStore {
  private chain: Promise<unknown> = Promise.resolve()

  private constructor(
    private readonly path: string,
    private readonly credentials: Map<string, Credential>,
  ) {}

  static async open(path: string): Promise<FileCredentialStore> {
    return new FileCredentialStore(path, await readCredentialFile(path))
  }

  peek(providerId: string): Credential | undefined {
    return cloneCredential(this.credentials.get(providerId))
  }

  async read(providerId: string): Promise<Credential | undefined> {
    return this.peek(providerId)
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return [...this.credentials].map(([providerId, credential]) => ({
      providerId,
      type: credential.type,
    }))
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    return this.enqueue(async () => {
      const current = cloneCredential(this.credentials.get(providerId))
      const next = await fn(current)
      if (next !== undefined) {
        this.credentials.set(providerId, cloneCredential(next) as Credential)
        await persistCredentials(this.path, this.credentials)
        return cloneCredential(next)
      }
      return current
    })
  }

  delete(providerId: string): Promise<void> {
    return this.enqueue(async () => {
      if (!this.credentials.delete(providerId)) return
      await persistCredentials(this.path, this.credentials)
    })
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const queued = this.chain.catch(() => undefined).then(operation)
    this.chain = queued.catch(() => undefined)
    return queued
  }
}

interface PendingPrompt {
  resolve(value: string): void
  reject(error: Error): void
  cleanup(): void
}

interface LoginSession {
  view: ModelAuthLoginSessionView
  controller: AbortController
  initialSecret?: string
  pendingPrompt?: PendingPrompt
}

export async function createFileModelAuthentication(
  options: FileModelAuthenticationOptions,
): Promise<DashboardModelAuthentication> {
  const store = await FileCredentialStore.open(options.storagePath)
  return new PersistentModelAuthentication(
    store,
    options.importPath ?? "/auth.json",
    options.models ?? builtinModels({ credentials: store }),
  )
}

class PersistentModelAuthentication implements DashboardModelAuthentication {
  readonly models: Models
  private readonly sessions = new Map<string, LoginSession>()

  constructor(
    private readonly store: FileCredentialStore,
    private readonly importPath: string,
    models: Models,
  ) {
    this.models = models
  }

  hasCredential(provider: string): boolean {
    return this.store.peek(provider) !== undefined
  }

  credentialType(provider: string): ModelAuthCredentialType | undefined {
    return this.store.peek(provider)?.type
  }

  async snapshot(): Promise<ModelAuthenticationView> {
    const imported = await stat(this.importPath)
      .then((value) => value.isFile())
      .catch(() => false)
    return {
      importPath: this.importPath,
      importFileAvailable: imported,
      providers: PROVIDERS.map((descriptor) => ({
        ...descriptor,
        configured: this.hasCredential(descriptor.id),
        ...(this.credentialType(descriptor.id)
          ? { credentialType: this.credentialType(descriptor.id) }
          : {}),
        models: this.models
          .getModels(descriptor.id)
          .map((model) => ({
            id: model.id,
            name: model.name,
            contextWindow: model.contextWindow,
            reasoning: model.reasoning,
          }))
          .sort((left, right) => left.name.localeCompare(right.name)),
      })),
    }
  }

  async startLogin(input: {
    provider: string
    method: string
    secret?: string
  }): Promise<ModelAuthLoginSessionView> {
    const provider = supportedProvider(input.provider)
    const method = supportedMethod(provider, input.method)
    this.pruneSessions()
    for (const session of this.sessions.values()) {
      if (
        session.view.provider === provider.id &&
        ["running", "awaiting_input"].includes(session.view.status)
      ) {
        this.cancelSession(session)
      }
    }

    const now = new Date().toISOString()
    const session: LoginSession = {
      controller: new AbortController(),
      ...(input.secret?.trim() ? { initialSecret: input.secret.trim() } : {}),
      view: {
        id: randomUUID(),
        provider: provider.id,
        method,
        status: "running",
        updatedAt: now,
      },
    }
    this.sessions.set(session.view.id, session)
    if (method === "oauth_token") {
      void this.store
        .modify(provider.id, async () => {
          const secret = session.initialSecret
          if (!secret) throw new Error("OAuth Token 不能为空")
          return bearerTokenCredential(secret)
        })
        .then(() => {
          session.initialSecret = undefined
          session.view.status = "success"
          session.view.progress = "OAuth Token 已保存"
          this.touch(session)
        })
        .catch((error: unknown) => {
          session.initialSecret = undefined
          session.view.status = "error"
          session.view.error = errorText(error)
          this.touch(session)
        })
      return cloneSessionView(session.view)
    }
    const authType = method === "api_key" ? "api_key" : "oauth"
    void this.models
      .login(provider.id, authType, {
        signal: session.controller.signal,
        prompt: (prompt) => this.answerPrompt(session, prompt),
        notify: (event) => {
          if (event.type === "auth_url") {
            session.view.authUrl = event.url
            session.view.instructions = event.instructions
          } else if (event.type === "device_code") {
            session.view.deviceCode = {
              userCode: event.userCode,
              verificationUri: event.verificationUri,
              ...(event.expiresInSeconds !== undefined
                ? { expiresInSeconds: event.expiresInSeconds }
                : {}),
            }
          } else {
            session.view.progress = event.message
          }
          this.touch(session)
        },
      })
      .then(() => {
        session.pendingPrompt?.cleanup()
        session.pendingPrompt = undefined
        session.view.prompt = undefined
        session.view.status = "success"
        session.view.progress = "凭据已保存"
        this.touch(session)
      })
      .catch((error: unknown) => {
        session.pendingPrompt?.cleanup()
        session.pendingPrompt = undefined
        session.view.prompt = undefined
        if (session.controller.signal.aborted) {
          session.view.status = "cancelled"
          session.view.error = undefined
        } else {
          session.view.status = "error"
          session.view.error = errorText(error)
        }
        this.touch(session)
      })
    return cloneSessionView(session.view)
  }

  loginSession(sessionId: string): ModelAuthLoginSessionView {
    return cloneSessionView(this.requireSession(sessionId).view)
  }

  submitPrompt(sessionId: string, value: string): ModelAuthLoginSessionView {
    const session = this.requireSession(sessionId)
    const pending = session.pendingPrompt
    if (!pending) throw new Error("当前登录会话没有等待输入")
    session.pendingPrompt = undefined
    session.view.prompt = undefined
    session.view.status = "running"
    this.touch(session)
    pending.cleanup()
    pending.resolve(value)
    return cloneSessionView(session.view)
  }

  cancelLogin(sessionId: string): ModelAuthLoginSessionView {
    const session = this.requireSession(sessionId)
    this.cancelSession(session)
    return cloneSessionView(session.view)
  }

  async logout(providerId: string): Promise<ModelAuthenticationView> {
    const provider = supportedProvider(providerId)
    await this.models.logout(provider.id)
    return this.snapshot()
  }

  importJson(raw: string): Promise<ModelAuthImportResult> {
    return this.importRaw(raw, "upload")
  }

  async importFile(): Promise<ModelAuthImportResult> {
    let raw: string
    try {
      raw = await readFile(this.importPath, "utf8")
    } catch (error) {
      throw new Error(`无法读取凭据文件 ${this.importPath}`, { cause: error })
    }
    return this.importRaw(raw, "file")
  }

  private async importRaw(
    raw: string,
    source: ModelAuthImportResult["source"],
  ): Promise<ModelAuthImportResult> {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      throw new Error("auth.json 不是有效 JSON", { cause: error })
    }
    const credentials = parseCredentialImport(parsed)
    if (credentials.size === 0) {
      throw new Error("未识别到 Codex、OpenAI 或 Claude 凭据；请检查 auth.json 格式")
    }
    const imported: ModelAuthImportResult["imported"] = []
    for (const [provider, credential] of credentials) {
      await this.store.modify(provider, async () => credential)
      imported.push({ provider, type: credential.type })
    }
    return { imported, source }
  }

  private answerPrompt(session: LoginSession, prompt: AuthPrompt): Promise<string> {
    if (prompt.type === "select" && session.view.provider === "openai-codex") {
      return Promise.resolve(session.view.method === "oauth_device" ? "device_code" : "browser")
    }
    if (prompt.type === "secret" && session.initialSecret !== undefined) {
      const secret = session.initialSecret
      session.initialSecret = undefined
      return Promise.resolve(secret)
    }

    session.view.status = "awaiting_input"
    session.view.prompt = {
      type: prompt.type,
      message: prompt.message,
      ...("placeholder" in prompt && prompt.placeholder ? { placeholder: prompt.placeholder } : {}),
      ...(prompt.type === "select"
        ? { options: prompt.options.map((option) => ({ ...option })) }
        : {}),
    }
    this.touch(session)
    return new Promise<string>((resolve, reject) => {
      let settled = false
      const signal = prompt.signal
      const onAbort = () => {
        if (settled) return
        settled = true
        session.pendingPrompt = undefined
        signal?.removeEventListener("abort", onAbort)
        reject(new Error("登录输入已由回调完成或被取消"))
      }
      const cleanup = () => signal?.removeEventListener("abort", onAbort)
      session.pendingPrompt = {
        cleanup,
        resolve: (value) => {
          if (settled) return
          settled = true
          resolve(value)
        },
        reject: (error) => {
          if (settled) return
          settled = true
          reject(error)
        },
      }
      signal?.addEventListener("abort", onAbort, { once: true })
      if (signal?.aborted) onAbort()
    })
  }

  private cancelSession(session: LoginSession): void {
    session.pendingPrompt?.cleanup()
    session.pendingPrompt?.reject(new Error("登录已取消"))
    session.pendingPrompt = undefined
    session.controller.abort(new Error("登录已取消"))
    session.view.prompt = undefined
    session.view.status = "cancelled"
    session.view.error = undefined
    this.touch(session)
  }

  private requireSession(sessionId: string): LoginSession {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`OAuth 登录会话不存在: ${sessionId}`)
    return session
  }

  private touch(session: LoginSession): void {
    session.view.updatedAt = new Date().toISOString()
  }

  private pruneSessions(): void {
    const oldest = Date.now() - 30 * 60_000
    for (const [id, session] of this.sessions) {
      if (Date.parse(session.view.updatedAt) < oldest) {
        if (["running", "awaiting_input"].includes(session.view.status)) {
          this.cancelSession(session)
        }
        this.sessions.delete(id)
      }
    }
  }
}

export function parseCredentialImport(value: unknown): Map<ModelAuthProviderId, Credential> {
  if (!isRecord(value)) return new Map()
  const result = new Map<ModelAuthProviderId, Credential>()
  const put = (provider: ModelAuthProviderId, credential: Credential | undefined) => {
    if (credential) result.set(provider, credential)
  }

  // Pi's current auth.json: { "provider-id": { type, ...credential } }.
  for (const provider of PROVIDER_IDS) {
    put(provider, credentialFromUnknown(value[provider]))
  }
  for (const container of [value.credentials, value.auth]) {
    if (!isRecord(container)) continue
    for (const provider of PROVIDER_IDS) {
      put(provider, credentialFromUnknown(container[provider]))
    }
  }

  // Codex CLI ~/.codex/auth.json.
  if (isRecord(value.tokens)) {
    const access = stringValue(value.tokens.access_token)
    const refresh = stringValue(value.tokens.refresh_token)
    if (access && refresh) {
      const expires = jwtExpiry(access) ?? timestampFromUnknown(value.expires)
      if (expires) {
        put("openai-codex", {
          type: "oauth",
          access,
          refresh,
          expires,
          ...(stringValue(value.tokens.account_id)
            ? { accountId: stringValue(value.tokens.account_id) }
            : {}),
        })
      }
    }
  }
  const openAiKey = stringValue(value.OPENAI_API_KEY)
  if (openAiKey) put("openai", { type: "api_key", key: openAiKey })

  // Claude Code's ~/.claude/.credentials.json and common exported aliases.
  const claudeOauth = isRecord(value.claudeAiOauth)
    ? value.claudeAiOauth
    : isRecord(value.claude_ai_oauth)
      ? value.claude_ai_oauth
      : undefined
  if (claudeOauth) {
    put(
      "anthropic",
      oauthCredential({
        access: claudeOauth.accessToken ?? claudeOauth.access_token ?? claudeOauth.access,
        refresh: claudeOauth.refreshToken ?? claudeOauth.refresh_token ?? claudeOauth.refresh,
        expires: claudeOauth.expiresAt ?? claudeOauth.expires_at ?? claudeOauth.expires,
        extras: claudeOauth,
      }),
    )
  }
  const anthropicBearer =
    stringValue(value.CLAUDE_CODE_OAUTH_TOKEN) ?? stringValue(value.ANTHROPIC_AUTH_TOKEN)
  if (anthropicBearer && !result.has("anthropic")) {
    put("anthropic", bearerTokenCredential(anthropicBearer))
  }
  const anthropicKey = stringValue(value.ANTHROPIC_API_KEY)
  if (anthropicKey && !result.has("anthropic")) {
    put("anthropic", { type: "api_key", key: anthropicKey })
  }

  return result
}

function credentialFromUnknown(value: unknown): Credential | undefined {
  if (typeof value === "string" && value.trim()) {
    return { type: "api_key", key: value.trim() }
  }
  if (!isRecord(value)) return undefined
  if (value.type === "api_key") {
    const key = stringValue(value.key)
    return key ? { ...value, type: "api_key", key } : undefined
  }
  const oauth = oauthCredential({
    access: value.access ?? value.access_token ?? value.accessToken,
    refresh: value.refresh ?? value.refresh_token ?? value.refreshToken,
    expires: value.expires ?? value.expires_at ?? value.expiresAt,
    extras: value,
  })
  if (oauth) return oauth
  const key = stringValue(value.key) ?? stringValue(value.apiKey) ?? stringValue(value.api_key)
  return key ? { type: "api_key", key } : undefined
}

function oauthCredential(input: {
  access: unknown
  refresh: unknown
  expires: unknown
  extras?: Record<string, unknown>
}): Credential | undefined {
  const access = stringValue(input.access)
  const refresh = stringValue(input.refresh)
  const expires = timestampFromUnknown(input.expires) ?? jwtExpiry(access)
  if (!access || !refresh || !expires) return undefined
  const extras = Object.fromEntries(
    Object.entries(input.extras ?? {}).filter(
      ([key]) =>
        ![
          "type",
          "access",
          "access_token",
          "accessToken",
          "refresh",
          "refresh_token",
          "refreshToken",
          "expires",
          "expires_at",
          "expiresAt",
        ].includes(key),
    ),
  )
  return { ...extras, type: "oauth", access, refresh, expires }
}

function bearerTokenCredential(token: string): Credential {
  return {
    type: "oauth",
    access: token,
    // Setup tokens do not expose a refresh token. Keeping the same opaque
    // value here satisfies Pi's canonical credential shape; the far-future
    // expiry prevents an invalid refresh attempt while toAuth preserves the
    // required Authorization: Bearer semantics.
    refresh: token,
    expires: 8_640_000_000_000_000,
    staticToken: true,
  }
}

function timestampFromUnknown(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value < 10_000_000_000 ? value * 1_000 : value
  }
  if (typeof value !== "string" || !value.trim()) return undefined
  const numeric = Number(value)
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric < 10_000_000_000 ? numeric * 1_000 : numeric
  }
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function jwtExpiry(token: string | undefined): number | undefined {
  if (!token) return undefined
  const encoded = token.split(".")[1]
  if (!encoded) return undefined
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown
    if (!isRecord(payload)) return undefined
    return timestampFromUnknown(payload.exp)
  } catch {
    return undefined
  }
}

function supportedProvider(providerId: string) {
  const provider = PROVIDERS.find((candidate) => candidate.id === providerId)
  if (!provider) throw new Error(`不支持的模型认证 Provider: ${providerId}`)
  return provider
}

function supportedMethod(
  provider: (typeof PROVIDERS)[number],
  methodId: string,
): ModelAuthMethodId {
  const method = provider.methods.find((candidate) => candidate.id === methodId)
  if (!method) {
    throw new Error(`${provider.name} 不支持登录方式: ${methodId}`)
  }
  return method.id
}

async function readCredentialFile(path: string): Promise<Map<string, Credential>> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(path, "utf8"))
  } catch (error) {
    if (hasCode(error, "ENOENT")) return new Map()
    throw new Error(`无法读取模型凭据: ${path}`, { cause: error })
  }
  if (!isRecord(parsed)) throw new Error(`模型凭据格式无效: ${path}`)
  const credentials = new Map<string, Credential>()
  for (const [providerId, value] of Object.entries(parsed)) {
    const credential = credentialFromUnknown(value)
    if (credential) credentials.set(providerId, credential)
  }
  return credentials
}

async function persistCredentials(
  path: string,
  credentials: ReadonlyMap<string, Credential>,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  const value = Object.fromEntries(
    [...credentials].map(([provider, credential]) => [provider, credential]),
  )
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  })
  await chmod(temporary, 0o600)
  await rename(temporary, path)
}

function cloneCredential(value: Credential | undefined): Credential | undefined {
  return value ? structuredClone(value) : undefined
}

function cloneSessionView(value: ModelAuthLoginSessionView): ModelAuthLoginSessionView {
  return structuredClone(value)
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  )
}
