import { createHash } from "node:crypto"
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import {
  attachModelsToAgentOptions,
  DEFAULT_SOLVER_THINKING_LEVEL,
  isThinkingLevel,
  type SecretStore,
} from "@ctf-agent/core"
import { SOLVER_SYSTEM_PROMPT } from "@ctf-agent/prompts"
import type { AgentOptions, ThinkingLevel } from "@earendil-works/pi-agent-core"
import { createModels, createProvider, type Models } from "@earendil-works/pi-ai"
import { streamSimple as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages"
import { streamSimple as streamOpenAiCompletions } from "@earendil-works/pi-ai/api/openai-completions"
import { streamSimple as streamOpenAiResponses } from "@earendil-works/pi-ai/api/openai-responses"
import {
  type Api,
  type Context,
  clampThinkingLevel,
  getModel,
  getSupportedThinkingLevels,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai/compat"
import type {
  AgentModelBindings,
  CustomModelProviderApi,
  CustomModelProviderEdit,
  CustomModelProviderUpdate,
  DashboardModelAuthentication,
  DashboardModelConfiguration,
  ModelConfigurationUpdate,
  ModelConfigurationView,
  ModelPoolEntryView,
  WebAccessModelAuth,
} from "../types.ts"
import {
  gateProviderStream,
  ProviderRequestGate,
  type ProviderStream,
} from "./provider-request-gate.ts"

const MODEL_API_KEY_SECRET_PREFIX = "CTF_MODEL_API_KEY_"
const PASSTHROUGH_THINKING_MAP = Object.fromEntries(
  ["minimal", "low", "medium", "high", "xhigh", "max"].map((level) => [level, level]),
)

interface StoredModelEntry {
  id: string
  provider: string
  modelId: string
  contextWindow: number
  thinkingEnabled: boolean
  reasoningEffort: string
  passthroughThinking: boolean
}

interface StoredCustomProvider {
  id: string
  name: string
  api: CustomModelProviderApi
  baseUrl: string
  endpointUrl?: string
}

interface StoredModelConfiguration {
  version: 3
  providers: StoredCustomProvider[]
  models: StoredModelEntry[]
  solverModelId: string
  tldrModelId: string
  fatherModelId: string
  subagentModels: Record<string, string>
}

export interface FileModelConfigurationOptions {
  storagePath: string
  secretStore: SecretStore
  authentication?: DashboardModelAuthentication
  fetch?: typeof globalThis.fetch
  providerRequestGate?: ProviderRequestGate
}

export interface AgentModelConfiguration extends DashboardModelConfiguration {
  createAgentOptions(
    target?: "solver" | "tldr" | "father",
    bindings?: AgentModelBindings,
  ): AgentOptions
  /** Codex Security 通过 Responses bridge 使用模型池中的自定义 Provider。 */
  codexSecurityConfiguration(modelId: string): Promise<{
    model: string
    baseUrl: string
    apiKey: string
    providerApi: CustomModelProviderApi
  }>
  /**
   * 把模型池适配成 web-access 需要的 ModelAuthResolver 形状
   * （find / getApiKeyAndHeaders / getAvailable），供搜索 + auto-summary 使用。
   */
  resolveModelAuth(): WebAccessModelAuth
}

/** Public model parameters and role assignments are persisted separately from credentials. */
export async function createFileModelConfiguration(
  options: FileModelConfigurationOptions,
): Promise<AgentModelConfiguration> {
  const parsed = await readStoredConfiguration(options.storagePath)
  return new PersistentModelConfiguration(options, parsed)
}

class PersistentModelConfiguration implements AgentModelConfiguration {
  private readonly providerRequestGate: ProviderRequestGate

  constructor(
    private readonly options: FileModelConfigurationOptions,
    private values: StoredModelConfiguration,
  ) {
    this.providerRequestGate = options.providerRequestGate ?? new ProviderRequestGate()
  }

  snapshot(bindings?: AgentModelBindings): ModelConfigurationView {
    const selectedBindings = bindings ?? this.values
    const models = this.values.models.map((entry) => this.entryView(entry))
    const solver = models.find((entry) => entry.id === selectedBindings.solverModelId)
    return {
      models,
      customProviders: this.values.providers.map((provider) => ({
        ...provider,
        apiKeyConfigured: this.options.secretStore.has(providerSecret(provider.id)),
      })),
      solverModelId: selectedBindings.solverModelId,
      tldrModelId: selectedBindings.tldrModelId,
      fatherModelId: this.values.fatherModelId,
      subagentModels: { ...selectedBindings.subagentModels },
      supportedThinkingLevels: solver?.supportedThinkingLevels ?? [],
      configured: solver?.configured === true,
      ...(!solver?.configured
        ? {
            unavailableReason:
              solver?.unavailableReason ?? "未选择可用的 Solver 模型，调度操作已禁用",
          }
        : {}),
    }
  }

  async update(configuration: ModelConfigurationUpdate): Promise<ModelConfigurationView> {
    const next = normalizeUpdate(configuration)
    next.configuration.providers = this.values.providers
    await persistConfiguration(this.options.storagePath, next.configuration)
    for (const [provider, credential] of next.credentials) {
      await this.options.secretStore.set({
        [providerSecret(provider)]: credential,
      })
    }
    this.values = next.configuration
    return this.snapshot()
  }

  async addCustomProvider(input: CustomModelProviderUpdate): Promise<ModelConfigurationView> {
    const base = slugifyProvider(input.name)
    let id = `custom-${base || "provider"}`
    let suffix = 2
    while (this.values.providers.some((provider) => provider.id === id)) {
      id = `custom-${base || "provider"}-${suffix++}`
    }
    const provider: StoredCustomProvider = {
      id,
      name: input.name.trim(),
      api: input.api,
      baseUrl: input.baseUrl.replace(/\/+$/, ""),
      ...(input.endpointUrl ? { endpointUrl: input.endpointUrl.replace(/\/+$/, "") } : {}),
    }
    providerRequestBaseUrl(provider)
    const next = {
      ...this.values,
      providers: [...this.values.providers, provider],
    }
    await this.options.secretStore.set({ [providerSecret(id)]: input.apiKey })
    await persistConfiguration(this.options.storagePath, next)
    this.values = next
    return this.snapshot()
  }

  async updateCustomProvider(
    providerId: string,
    input: CustomModelProviderEdit,
  ): Promise<ModelConfigurationView> {
    const providerIndex = this.values.providers.findIndex((provider) => provider.id === providerId)
    if (providerIndex < 0) {
      throw new Error(`自定义供应商不存在: ${providerId}`)
    }
    const providers = [...this.values.providers]
    providers[providerIndex] = {
      id: providerId,
      name: input.name.trim(),
      api: input.api,
      baseUrl: input.baseUrl.replace(/\/+$/, ""),
      ...(input.endpointUrl ? { endpointUrl: input.endpointUrl.replace(/\/+$/, "") } : {}),
    }
    providerRequestBaseUrl(providers[providerIndex])
    const next = { ...this.values, providers }
    if (input.apiKey !== undefined) {
      await this.options.secretStore.set({
        [providerSecret(providerId)]: input.apiKey,
      })
    }
    await persistConfiguration(this.options.storagePath, next)
    this.values = next
    return this.snapshot()
  }

  async removeCustomProvider(providerId: string): Promise<ModelConfigurationView> {
    if (this.values.models.some((model) => model.provider === providerId)) {
      throw new Error("该供应商仍被模型池引用，请先移除相关模型")
    }
    const next = {
      ...this.values,
      providers: this.values.providers.filter((provider) => provider.id !== providerId),
    }
    if (next.providers.length === this.values.providers.length) {
      throw new Error(`自定义供应商不存在: ${providerId}`)
    }
    await this.options.secretStore.set({
      [providerSecret(providerId)]: undefined,
    })
    await persistConfiguration(this.options.storagePath, next)
    this.values = next
    return this.snapshot()
  }

  async discoverCustomProviderModels(providerId: string): Promise<string[]> {
    const provider = this.values.providers.find((candidate) => candidate.id === providerId)
    if (!provider) throw new Error(`自定义供应商不存在: ${providerId}`)
    const apiKey = this.options.secretStore.get(providerSecret(providerId))
    if (!apiKey) throw new Error("该供应商尚未配置 API Key")

    const endpoint = providerModelsEndpoint(provider)
    const headers = new Headers({ Accept: "application/json" })
    if (provider.api === "anthropic-messages") {
      headers.set("x-api-key", apiKey)
      headers.set("anthropic-version", "2023-06-01")
    } else {
      headers.set("Authorization", `Bearer ${apiKey}`)
    }
    const response = await (this.options.fetch ?? globalThis.fetch)(endpoint, {
      method: "GET",
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) {
      throw new Error(`模型列表请求失败: HTTP ${response.status}`)
    }
    const text = await response.text()
    if (text.length > 1_000_000) throw new Error("模型列表响应过大")
    let payload: unknown
    try {
      payload = JSON.parse(text)
    } catch {
      throw new Error("模型列表响应不是有效 JSON")
    }
    const records = modelRecords(payload)
    const ids = records
      .map((record) =>
        typeof record === "string"
          ? record
          : typeof record === "object" && record !== null
            ? (record as { id?: unknown }).id
            : undefined,
      )
      .filter(
        (id): id is string =>
          typeof id === "string" && id.length > 0 && id.length <= 256 && !hasControlCharacters(id),
      )
    return [...new Set(ids)].sort((left, right) => left.localeCompare(right)).slice(0, 1_000)
  }

  createAgentOptions(
    target: "solver" | "tldr" | "father" = "solver",
    bindings?: AgentModelBindings,
  ): AgentOptions {
    const selectedBindings = bindings ?? this.values
    const id =
      target === "father"
        ? this.values.fatherModelId || this.values.solverModelId
        : target === "tldr"
          ? selectedBindings.tldrModelId || selectedBindings.solverModelId
          : selectedBindings.solverModelId
    const selected = this.values.models.find((entry) => entry.id === id)
    if (!selected) {
      throw new Error(
        `未选择 ${target === "tldr" ? "TLDR" : target === "father" ? "Clanker Father" : "Solver"} 模型`,
      )
    }
    const unavailableReason = this.entryUnavailableReason(selected)
    if (unavailableReason) throw new Error(unavailableReason)
    const model = resolveModel(selected, this.values.providers, this.options.authentication)
    const models = this.createModelsRegistry()
    const agent: AgentOptions = {
      streamFn: ((candidate, context, streamOptions) =>
        models.streamSimple(candidate, context, streamOptions)) as AgentOptions["streamFn"],
      getApiKey: (provider) => this.options.secretStore.get(providerSecret(provider)),
      initialState: {
        model,
        thinkingLevel: configuredThinkingLevel(model, selected),
        systemPrompt: SOLVER_SYSTEM_PROMPT,
      },
    }
    return attachModelsToAgentOptions(agent, models)
  }

  async codexSecurityConfiguration(modelId: string): Promise<{
    model: string
    baseUrl: string
    apiKey: string
    providerApi: CustomModelProviderApi
  }> {
    const selected = this.values.models.find((entry) => entry.id === modelId)
    if (!selected) throw new Error("未选择白盒审计模型")
    const unavailableReason = this.entryUnavailableReason(selected)
    if (unavailableReason) throw new Error(unavailableReason)
    const provider = this.values.providers.find((item) => item.id === selected.provider)
    if (!provider) {
      throw new Error("白盒审计需要在模型池中配置自定义 Provider")
    }
    if (
      provider.api !== "openai-responses" &&
      provider.api !== "openai-completions" &&
      provider.api !== "anthropic-messages"
    ) {
      throw new Error("白盒审计不支持该 Provider 协议")
    }
    const apiKey = this.options.secretStore.get(providerSecret(selected.provider))
    if (!apiKey) {
      throw new Error("白盒审计模型缺少可注入 bridge 的 API Key")
    }
    if (hasControlCharacters(apiKey)) throw new Error("白盒审计模型 API Key 包含非法控制字符")
    const baseUrl = validateCodexBridgeUrl(provider.baseUrl)
    if (hasControlCharacters(selected.modelId)) throw new Error("白盒审计模型 ID 包含非法控制字符")
    return { model: selected.modelId, baseUrl, apiKey, providerApi: provider.api }
  }

  modelForSubagent(role: string, bindings?: AgentModelBindings): string | undefined {
    const id = (bindings ?? this.values).subagentModels[role]
    const entry = this.values.models.find((candidate) => candidate.id === id)
    return entry ? `${entry.provider}/${entry.modelId}` : undefined
  }

  private entryView(entry: StoredModelEntry): ModelPoolEntryView {
    const unavailableReason = this.entryUnavailableReason(entry)
    let model: Model<Api> | undefined
    if (!unavailableReason) {
      model = resolveModel(
        { ...entry, thinkingEnabled: true },
        this.values.providers,
        this.options.authentication,
      )
    }
    return {
      ...entry,
      supportedThinkingLevels: model
        ? getSupportedThinkingLevels(model).filter((level) => level !== "off")
        : [],
      configured: unavailableReason === undefined,
      ...(unavailableReason ? { unavailableReason } : {}),
    }
  }

  private entryUnavailableReason(entry: StoredModelEntry): string | undefined {
    if (!entry.modelId) return `模型 ${entry.id} 未配置 Model ID`
    if (
      !this.hasProviderCredential(entry) &&
      !this.options.secretStore.has(providerSecret(entry.provider))
    ) {
      return `模型 ${entry.id} 未配置凭据或 API Key`
    }
    try {
      resolveModel(entry, this.values.providers, this.options.authentication)
      return undefined
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }

  private hasProviderCredential(entry: StoredModelEntry): boolean {
    return (
      !this.values.providers.some((provider) => provider.id === entry.provider) &&
      this.options.authentication?.hasCredential(entry.provider) === true
    )
  }

  private createModelsRegistry(): Models {
    const registry = createModels()
    const available = this.values.models.flatMap((entry) => {
      if (this.entryUnavailableReason(entry)) return []
      return [
        {
          entry,
          model: resolveModel(entry, this.values.providers, this.options.authentication),
        },
      ]
    })
    const providers = new Map<string, typeof available>()
    for (const candidate of available) {
      const group = providers.get(candidate.entry.provider) ?? []
      group.push(candidate)
      providers.set(candidate.entry.provider, group)
    }
    for (const [provider, entries] of providers) {
      const native = entries.every(({ entry }) => this.hasProviderCredential(entry))
      const upstream: ProviderStream = (
        model: Model<Api>,
        context: Context,
        streamOptions?: SimpleStreamOptions,
      ) =>
        native && this.options.authentication
          ? this.options.authentication.models.streamSimple(model, context, streamOptions)
          : streamCustomModel(model, context, streamOptions)
      const stream = gateProviderStream(this.providerRequestGate, upstream)
      registry.setProvider(
        createProvider({
          id: provider,
          name: provider,
          models: entries.map(({ model }) => model),
          auth: {
            apiKey: {
              name: `${provider} JYFF Agent credential`,
              resolve: async () => ({
                // 原生 Provider 在内层 Models registry 中解析 OAuth/API Key；
                // 外层只负责聚合模型，不能用占位 key 覆盖真实凭据。
                auth: native
                  ? {}
                  : {
                      apiKey: this.options.secretStore.get(providerSecret(provider)),
                    },
                source: native ? "provider credential" : "SecretStore",
              }),
            },
          },
          api: { stream, streamSimple: stream },
        }),
      )
    }
    return registry
  }

  /**
   * 把模型池适配成 web-access 的 ModelAuthResolver。模型池的 Models registry
   * 返回完整 pi-ai Model 对象（含 provider/id/contextWindow），web-access
   * 内部按 { provider, id } 消费；这里在边界上做一次 cast 是安全的。
   */
  resolveModelAuth(): WebAccessModelAuth {
    const models = this.createModelsRegistry()
    return {
      find(provider, modelId) {
        return models.getModel(provider, modelId)
      },
      getAvailable() {
        return models.getModels()
      },
      async getApiKeyAndHeaders(model) {
        try {
          const auth = await models.getAuth(model as Model<Api>)
          const apiKey = auth?.auth.apiKey
          if (!apiKey) return { ok: false }
          const headers = auth.auth.headers
          return {
            ok: true,
            apiKey,
            ...(headers ? { headers: dropNullHeaders(headers) } : {}),
          }
        } catch {
          return { ok: false }
        }
      },
    }
  }
}

function dropNullHeaders(headers: Record<string, string | null>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value !== null) out[name] = value
  }
  return out
}

async function readStoredConfiguration(path: string): Promise<StoredModelConfiguration> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(path, "utf8"))
  } catch (error) {
    if (hasCode(error, "ENOENT")) return emptyConfiguration()
    throw new Error(`无法读取模型配置: ${path}`, { cause: error })
  }
  if (!isRecord(parsed)) throw new Error(`模型配置格式无效: ${path}`)
  if (parsed.version !== 3 || !Array.isArray(parsed.models)) {
    throw new Error("模型配置必须使用 v3 格式，请重新导入模型配置")
  }
  return parseVersionThree(parsed)
}

function parseVersionThree(parsed: Record<string, unknown>): StoredModelConfiguration {
  const models = (parsed.models as unknown[]).map((value, index) => {
    if (!isRecord(value)) throw new Error(`模型配置 models[${index}] 格式无效`)
    return storedEntry(value, index)
  })
  const ids = new Set(models.map((entry) => entry.id))
  const solverModelId = stringValue(parsed.solverModelId) ?? ""
  const tldrModelId = stringValue(parsed.tldrModelId) ?? solverModelId
  const fatherModelId = stringValue(parsed.fatherModelId) ?? solverModelId
  const subagentModels = stringRecord(parsed.subagentModels)
  validateReferences(ids, solverModelId, tldrModelId, fatherModelId, subagentModels)
  const providers = parseStoredProviders(parsed.providers)
  validateProviderGroups(models)
  return {
    version: 3,
    providers,
    models,
    solverModelId,
    tldrModelId,
    fatherModelId,
    subagentModels,
  }
}

function normalizeUpdate(configuration: ModelConfigurationUpdate): {
  configuration: StoredModelConfiguration
  credentials: Map<string, string | undefined>
} {
  const credentials = new Map<string, string | undefined>()
  const models = configuration.models.map((entry, index) => {
    return storedEntry(entry as unknown as Record<string, unknown>, index)
  })
  const ids = new Set(models.map((entry) => entry.id))
  // 首次建模型时前端 solverModelId 为空：自动落到第一个模型，避免
  // "Solver 模型不存在: undefined"。
  const solverModelId = configuration.solverModelId || models[0]?.id || ""
  validateReferences(
    ids,
    solverModelId,
    configuration.tldrModelId,
    configuration.fatherModelId ?? solverModelId,
    configuration.subagentModels,
  )
  validateProviderGroups(models)
  return {
    configuration: {
      version: 3,
      providers: [],
      models,
      solverModelId,
      tldrModelId: configuration.tldrModelId || solverModelId,
      fatherModelId: configuration.fatherModelId || solverModelId,
      subagentModels: { ...configuration.subagentModels },
    },
    credentials,
  }
}

function storedEntry(value: Record<string, unknown>, index: number): StoredModelEntry {
  const id = stringValue(value.id)
  const provider = stringValue(value.provider)
  const modelId = stringValue(value.modelId)
  if (!id || !provider || !modelId) {
    throw new Error(`模型配置 models[${index}] 缺少 id/provider/modelId`)
  }
  const contextWindow = positiveInteger(value.contextWindow) ? value.contextWindow : 64_000
  return {
    id,
    provider,
    modelId,
    contextWindow,
    thinkingEnabled: value.thinkingEnabled !== false,
    reasoningEffort: stringValue(value.reasoningEffort) ?? DEFAULT_SOLVER_THINKING_LEVEL,
    passthroughThinking: value.passthroughThinking === true,
  }
}

function validateReferences(
  ids: ReadonlySet<string>,
  solverModelId: string,
  tldrModelId: string,
  fatherModelId: string,
  subagentModels: Readonly<Record<string, string>>,
): void {
  if (ids.size === 0) {
    if (solverModelId || tldrModelId || fatherModelId || Object.keys(subagentModels).length > 0) {
      throw new Error("空模型池不能包含 Agent 模型绑定")
    }
    return
  }
  if (ids.size === 0 || !ids.has(solverModelId)) {
    throw new Error(`Solver 模型不存在: ${solverModelId}`)
  }
  if (tldrModelId && !ids.has(tldrModelId)) {
    throw new Error(`TLDR 模型不存在: ${tldrModelId}`)
  }
  if (fatherModelId && !ids.has(fatherModelId)) {
    throw new Error(`Father 模型不存在: ${fatherModelId}`)
  }
  for (const [role, id] of Object.entries(subagentModels)) {
    if (!role.trim() || !ids.has(id)) {
      throw new Error(`SubAgent ${role || "<empty>"} 的模型不存在: ${id}`)
    }
  }
}

function validateProviderGroups(models: readonly StoredModelEntry[]): void {
  const ids = new Set<string>()
  const references = new Set<string>()
  for (const entry of models) {
    if (ids.has(entry.id)) throw new Error(`模型配置 ID 重复: ${entry.id}`)
    ids.add(entry.id)
    const reference = `${entry.provider}/${entry.modelId}`
    if (references.has(reference)) throw new Error(`模型重复: ${reference}`)
    references.add(reference)
  }
}

async function persistConfiguration(
  path: string,
  configuration: StoredModelConfiguration,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, `${JSON.stringify(configuration, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  })
  await chmod(temporary, 0o600)
  await rename(temporary, path)
}

function emptyConfiguration(): StoredModelConfiguration {
  return {
    version: 3,
    providers: [],
    models: [],
    solverModelId: "",
    tldrModelId: "",
    fatherModelId: "",
    subagentModels: {},
  }
}

function providerModelsEndpoint(provider: StoredCustomProvider): string {
  const base = provider.baseUrl.replace(/\/+$/, "")
  if (/\/models$/i.test(base)) return base
  if (provider.api === "anthropic-messages" && !/\/v1$/i.test(base)) {
    return `${base}/v1/models`
  }
  return `${base}/models`
}

function providerRequestBaseUrl(provider: StoredCustomProvider): string {
  if (!provider.endpointUrl) return provider.baseUrl

  const endpoint = provider.endpointUrl.replace(/\/+$/, "")
  if (!endpoint) throw new Error("请求 Endpoint 缺少服务地址")
  // pi-ai 的 SDK 会在 baseURL 后追加协议默认路径。用 fragment 作为哨兵，
  // 让 SDK 追加的路径落入 fragment；HTTP 请求实际发送时 fragment 不会被发送，
  // 因此 URL pathname 仍保持为用户配置的任意最终 Endpoint。
  return `${endpoint}#`
}

function modelRecords(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload
  if (typeof payload !== "object" || payload === null) return []
  const candidate = payload as { data?: unknown; models?: unknown }
  if (Array.isArray(candidate.data)) return candidate.data
  return Array.isArray(candidate.models) ? candidate.models : []
}

function validateCodexBridgeUrl(value: string): string {
  if (hasControlCharacters(value)) throw new Error("白盒审计 Provider URL 包含非法控制字符")
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error("白盒审计 Provider URL 无效")
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("白盒审计 Provider URL 必须使用 HTTP 或 HTTPS")
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("白盒审计 Provider URL 不得包含凭据、查询参数或片段")
  }
  return value.replace(/\/+$/, "")
}

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0)
    return code <= 0x1f || code === 0x7f
  })
}

function providerSecret(provider: string): string {
  const digest = createHash("sha256").update(provider).digest("hex").toUpperCase()
  return `${MODEL_API_KEY_SECRET_PREFIX}${digest.slice(0, 32)}`
}

function resolveModel(
  configuration: StoredModelEntry,
  customProviders: readonly StoredCustomProvider[],
  authentication?: DashboardModelAuthentication,
): Model<Api> {
  const provider = configuration.provider
  const modelId = configuration.modelId
  const customProvider = customProviders.find((candidate) => candidate.id === provider)
  const baseUrl = customProvider ? providerRequestBaseUrl(customProvider) : ""
  const contextWindow = configuration.contextWindow
  const reasoning = configuration.thinkingEnabled

  if (baseUrl) {
    const thinkingLevelMap =
      provider === "deepseek" || baseUrl.includes("deepseek.com")
        ? deepseekThinkingLevelMap(modelId)
        : configuration.passthroughThinking
          ? PASSTHROUGH_THINKING_MAP
          : undefined
    return {
      id: modelId,
      name: modelId,
      api: customProvider?.api ?? "openai-completions",
      provider,
      baseUrl,
      reasoning,
      thinkingLevelMap,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow,
      maxTokens: contextWindow,
      compat:
        customProvider?.api === "openai-completions"
          ? {
              supportsStore: false,
              supportsDeveloperRole: false,
              supportsUsageInStreaming: false,
              supportsStrictMode: false,
              supportsLongCacheRetention: false,
              maxTokensField: "max_tokens",
            }
          : undefined,
    }
  }

  if (authentication?.hasCredential(provider)) {
    const native = authentication.models.getModel(provider, modelId)
    if (!native) throw new Error(`Pi 未内置模型: ${provider}/${modelId}`)
    return {
      ...native,
      contextWindow: Math.min(native.contextWindow, contextWindow),
    }
  }

  const builtin = getModel(provider as never, modelId as never)
  if (!builtin) throw new Error(`Pi 未内置模型: ${provider}/${modelId}`)
  if (builtin.api !== "openai-completions") {
    throw new Error(`当前运行镜像仅支持 OpenAI-compatible 模型: ${provider}/${modelId}`)
  }
  const openAiModel = builtin as Model<"openai-completions">
  return {
    ...openAiModel,
    contextWindow: Math.min(openAiModel.contextWindow, contextWindow),
    reasoning,
    compat: { ...openAiModel.compat, supportsDeveloperRole: false },
  }
}

/** Keep Pi's reasoning/provider mapping, but never send a client token budget. */
function streamWithoutOutputTokenLimit(
  model: Model<"openai-completions">,
  context: Context,
  options?: SimpleStreamOptions,
) {
  const upstreamOnPayload = options?.onPayload
  return streamOpenAiCompletions(model, context, {
    ...options,
    onPayload: async (payload, payloadModel) => {
      const transformed = await upstreamOnPayload?.(payload, payloadModel)
      return omitOutputTokenLimit(transformed ?? payload)
    },
  })
}

function streamCustomModel(model: Model<Api>, context: Context, options?: SimpleStreamOptions) {
  if (model.api === "openai-responses") {
    return streamOpenAiResponses(model as Model<"openai-responses">, context, options)
  }
  if (model.api === "anthropic-messages") {
    return streamAnthropic(model as Model<"anthropic-messages">, context, options)
  }
  return streamWithoutOutputTokenLimit(model as Model<"openai-completions">, context, options)
}

function parseStoredProviders(value: unknown): StoredCustomProvider[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((candidate) => {
    if (!isRecord(candidate)) return []
    const id = stringValue(candidate.id)
    const name = stringValue(candidate.name)
    const baseUrl = stringValue(candidate.baseUrl)?.replace(/\/+$/, "")
    const endpointUrl = stringValue(candidate.endpointUrl)?.replace(/\/+$/, "")
    const api = candidate.api
    if (
      !id ||
      !name ||
      !baseUrl ||
      !["openai-completions", "openai-responses", "anthropic-messages"].includes(String(api))
    )
      return []
    return [
      {
        id,
        name,
        baseUrl,
        api: api as CustomModelProviderApi,
        ...(endpointUrl ? { endpointUrl } : {}),
      },
    ]
  })
}

function slugifyProvider(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
}

export function omitOutputTokenLimit(payload: unknown): unknown {
  if (!isRecord(payload)) return payload
  const copy = { ...payload }
  delete copy.max_tokens
  delete copy.max_completion_tokens
  return copy
}

function deepseekThinkingLevelMap(modelId: string): Record<string, string | null> {
  const pro = modelId.includes("v4-pro")
  return {
    minimal: null,
    low: pro ? "high" : "low",
    medium: "high",
    high: "high",
    xhigh: "max",
    max: "max",
  }
}

function configuredThinkingLevel(
  model: Model<Api>,
  configuration: StoredModelEntry,
): ThinkingLevel {
  if (!configuration.thinkingEnabled) return "off"
  const requested = isThinkingLevel(configuration.reasoningEffort)
    ? configuration.reasoningEffort
    : DEFAULT_SOLVER_THINKING_LEVEL
  return clampThinkingLevel(model, requested)
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] =>
        Boolean(entry[0].trim()) && typeof entry[1] === "string" && Boolean(entry[1]),
    ),
  )
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function positiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code
}
