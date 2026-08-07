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
import {
  createModels,
  createProvider,
  type Models,
} from "@earendil-works/pi-ai"
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions"
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
  DashboardModelAuthentication,
  DashboardModelConfiguration,
  ModelConfigurationUpdate,
  ModelConfigurationView,
  ModelPoolEntryUpdate,
  ModelPoolEntryView,
} from "./types.ts"

const LEGACY_MODEL_API_KEY_SECRET = "CTF_MODEL_API_KEY"
const MODEL_API_KEY_SECRET_PREFIX = "CTF_MODEL_API_KEY_"
const PASSTHROUGH_THINKING_MAP = Object.fromEntries(
  ["minimal", "low", "medium", "high", "xhigh", "max"].map((level) => [
    level,
    level,
  ]),
)

interface StoredModelEntry {
  id: string
  provider: string
  modelId: string
  baseUrl: string
  contextWindow: number
  thinkingEnabled: boolean
  reasoningEffort: string
  passthroughThinking: boolean
}

interface StoredModelConfiguration {
  version: 2
  models: StoredModelEntry[]
  solverModelId: string
  tldrModelId: string
  subagentModels: Record<string, string>
}

export interface FileModelConfigurationOptions {
  storagePath: string
  secretStore: SecretStore
  authentication?: DashboardModelAuthentication
}

export interface AgentModelConfiguration extends DashboardModelConfiguration {
  createAgentOptions(target?: "solver" | "tldr"): AgentOptions
}

/** Public model parameters and role assignments are persisted separately from credentials. */
export async function createFileModelConfiguration(
  options: FileModelConfigurationOptions,
): Promise<AgentModelConfiguration> {
  const parsed = await readStoredConfiguration(options.storagePath)
  const legacySecret =
    parsed.legacyApiKey ?? options.secretStore.get(LEGACY_MODEL_API_KEY_SECRET)
  const firstProvider = parsed.configuration.models[0]?.provider
  if (
    legacySecret &&
    firstProvider &&
    !options.secretStore.has(providerSecret(firstProvider))
  ) {
    await options.secretStore.set({
      [providerSecret(firstProvider)]: legacySecret,
    })
  }
  if (parsed.legacyApiKey !== undefined || parsed.needsRewrite) {
    await persistConfiguration(options.storagePath, parsed.configuration)
  }
  return new PersistentModelConfiguration(options, parsed.configuration)
}

class PersistentModelConfiguration implements AgentModelConfiguration {
  constructor(
    private readonly options: FileModelConfigurationOptions,
    private values: StoredModelConfiguration,
  ) {}

  snapshot(): ModelConfigurationView {
    const models = this.values.models.map((entry) => this.entryView(entry))
    const solver = models.find(
      (entry) => entry.id === this.values.solverModelId,
    )
    return {
      models,
      solverModelId: this.values.solverModelId,
      tldrModelId: this.values.tldrModelId,
      subagentModels: { ...this.values.subagentModels },
      supportedThinkingLevels: solver?.supportedThinkingLevels ?? [],
      configured: solver?.configured === true,
      ...(!solver?.configured
        ? {
            unavailableReason:
              solver?.unavailableReason ??
              "未选择可用的 Solver 模型，调度操作已禁用",
          }
        : {}),
    }
  }

  async update(
    configuration: ModelConfigurationUpdate,
  ): Promise<ModelConfigurationView> {
    const next = normalizeUpdate(configuration)
    await persistConfiguration(this.options.storagePath, next.configuration)
    for (const [provider, credential] of next.credentials) {
      await this.options.secretStore.set({
        [providerSecret(provider)]: credential,
      })
    }
    this.values = next.configuration
    return this.snapshot()
  }

  createAgentOptions(target: "solver" | "tldr" = "solver"): AgentOptions {
    const id =
      target === "tldr"
        ? this.values.tldrModelId || this.values.solverModelId
        : this.values.solverModelId
    const selected = this.values.models.find((entry) => entry.id === id)
    if (!selected) {
      throw new Error(`未选择 ${target === "tldr" ? "TLDR" : "Solver"} 模型`)
    }
    const unavailableReason = this.entryUnavailableReason(selected)
    if (unavailableReason) throw new Error(unavailableReason)
    const model = resolveModel(selected, this.options.authentication)
    const models = this.createModelsRegistry()
    const agent: AgentOptions = {
      streamFn: ((candidate, context, streamOptions) =>
        models.streamSimple(
          candidate,
          context,
          streamOptions,
        )) as AgentOptions["streamFn"],
      getApiKey: (provider) =>
        this.options.secretStore.get(providerSecret(provider)),
      initialState: {
        model,
        thinkingLevel: configuredThinkingLevel(model, selected),
        systemPrompt: SOLVER_SYSTEM_PROMPT,
      },
    }
    return attachModelsToAgentOptions(agent, models)
  }

  modelForSubagent(role: string): string | undefined {
    const id = this.values.subagentModels[role]
    const entry = this.values.models.find((candidate) => candidate.id === id)
    return entry ? `${entry.provider}/${entry.modelId}` : undefined
  }

  private entryView(entry: StoredModelEntry): ModelPoolEntryView {
    const providerCredentialConfigured = this.hasProviderCredential(entry)
    const secretConfigured = this.options.secretStore.has(
      providerSecret(entry.provider),
    )
    const unavailableReason = this.entryUnavailableReason(entry)
    let model: Model<Api> | undefined
    if (!unavailableReason) {
      model = resolveModel(
        { ...entry, thinkingEnabled: true },
        this.options.authentication,
      )
    }
    return {
      ...entry,
      apiKeyConfigured: providerCredentialConfigured || secretConfigured,
      apiKeySource: providerCredentialConfigured
        ? "provider-credential"
        : secretConfigured
          ? "secret-store"
          : "none",
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
      resolveModel(entry, this.options.authentication)
      return undefined
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }

  private hasProviderCredential(entry: StoredModelEntry): boolean {
    return (
      !entry.baseUrl &&
      this.options.authentication?.hasCredential(entry.provider) === true
    )
  }

  private createModelsRegistry(): Models {
    const registry = createModels()
    const available = this.values.models.flatMap((entry) => {
      if (this.entryUnavailableReason(entry)) return []
      return [
        { entry, model: resolveModel(entry, this.options.authentication) },
      ]
    })
    const providers = new Map<string, typeof available>()
    for (const candidate of available) {
      const group = providers.get(candidate.entry.provider) ?? []
      group.push(candidate)
      providers.set(candidate.entry.provider, group)
    }
    for (const [provider, entries] of providers) {
      const native = entries.every(({ entry }) =>
        this.hasProviderCredential(entry),
      )
      const stream = (
        model: Model<Api>,
        context: Context,
        streamOptions?: SimpleStreamOptions,
      ) =>
        native && this.options.authentication
          ? this.options.authentication.models.streamSimple(
              model,
              context,
              streamOptions,
            )
          : streamWithoutOutputTokenLimit(
              model as Model<"openai-completions">,
              context,
              streamOptions,
            )
      registry.setProvider(
        createProvider({
          id: provider,
          name: provider,
          models: entries.map(({ model }) => model),
          auth: {
            apiKey: {
              name: `${provider} CTF Agent credential`,
              resolve: async () => ({
                // 原生 Provider 在内层 Models registry 中解析 OAuth/API Key；
                // 外层只负责聚合模型，不能用占位 key 覆盖真实凭据。
                auth: native
                  ? {}
                  : {
                      apiKey: this.options.secretStore.get(
                        providerSecret(provider),
                      ),
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
}

async function readStoredConfiguration(path: string): Promise<{
  configuration: StoredModelConfiguration
  legacyApiKey?: string
  needsRewrite?: boolean
}> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(path, "utf8"))
  } catch (error) {
    if (hasCode(error, "ENOENT")) return { configuration: emptyConfiguration() }
    throw new Error(`无法读取模型配置: ${path}`, { cause: error })
  }
  if (!isRecord(parsed)) throw new Error(`模型配置格式无效: ${path}`)
  if (parsed.version === 2 && Array.isArray(parsed.models)) {
    return { configuration: parseVersionTwo(parsed) }
  }

  const modelId = stringValue(parsed.modelId)
  const provider = stringValue(parsed.provider) ?? "openrouter"
  const models: StoredModelEntry[] = modelId
    ? [
        {
          id: "default",
          provider,
          modelId,
          baseUrl: stringValue(parsed.baseUrl) ?? "",
          contextWindow: positiveInteger(parsed.contextWindow)
            ? parsed.contextWindow
            : 64_000,
          thinkingEnabled:
            typeof parsed.thinkingEnabled === "boolean"
              ? parsed.thinkingEnabled
              : true,
          reasoningEffort:
            stringValue(parsed.reasoningEffort) ??
            DEFAULT_SOLVER_THINKING_LEVEL,
          passthroughThinking: parsed.passthroughThinking === true,
        },
      ]
    : []
  return {
    configuration: {
      version: 2,
      models,
      solverModelId: models[0]?.id ?? "",
      tldrModelId: models[0]?.id ?? "",
      subagentModels: {},
    },
    ...(typeof parsed.apiKey === "string"
      ? { legacyApiKey: parsed.apiKey }
      : {}),
    needsRewrite: true,
  }
}

function parseVersionTwo(
  parsed: Record<string, unknown>,
): StoredModelConfiguration {
  const models = (parsed.models as unknown[]).map((value, index) => {
    if (!isRecord(value)) throw new Error(`模型配置 models[${index}] 格式无效`)
    return storedEntry(value, index)
  })
  const ids = new Set(models.map((entry) => entry.id))
  const solverModelId = stringValue(parsed.solverModelId) ?? ""
  const tldrModelId = stringValue(parsed.tldrModelId) ?? solverModelId
  const subagentModels = stringRecord(parsed.subagentModels)
  validateReferences(ids, solverModelId, tldrModelId, subagentModels)
  validateProviderGroups(models)
  return {
    version: 2,
    models,
    solverModelId,
    tldrModelId,
    subagentModels,
  }
}

function normalizeUpdate(configuration: ModelConfigurationUpdate): {
  configuration: StoredModelConfiguration
  credentials: Map<string, string | undefined>
} {
  const credentials = new Map<string, string | undefined>()
  const models = configuration.models.map((entry, index) => {
    captureCredential(credentials, entry)
    return storedEntry(entry as unknown as Record<string, unknown>, index)
  })
  const ids = new Set(models.map((entry) => entry.id))
  validateReferences(
    ids,
    configuration.solverModelId,
    configuration.tldrModelId,
    configuration.subagentModels,
  )
  validateProviderGroups(models)
  return {
    configuration: {
      version: 2,
      models,
      solverModelId: configuration.solverModelId,
      tldrModelId: configuration.tldrModelId || configuration.solverModelId,
      subagentModels: { ...configuration.subagentModels },
    },
    credentials,
  }
}

function storedEntry(
  value: Record<string, unknown>,
  index: number,
): StoredModelEntry {
  const id = stringValue(value.id)
  const provider = stringValue(value.provider)
  const modelId = stringValue(value.modelId)
  if (!id || !provider || !modelId) {
    throw new Error(`模型配置 models[${index}] 缺少 id/provider/modelId`)
  }
  const contextWindow = positiveInteger(value.contextWindow)
    ? value.contextWindow
    : 64_000
  return {
    id,
    provider,
    modelId,
    baseUrl: stringValue(value.baseUrl)?.replace(/\/+$/, "") ?? "",
    contextWindow,
    thinkingEnabled: value.thinkingEnabled !== false,
    reasoningEffort:
      stringValue(value.reasoningEffort) ?? DEFAULT_SOLVER_THINKING_LEVEL,
    passthroughThinking: value.passthroughThinking === true,
  }
}

function validateReferences(
  ids: ReadonlySet<string>,
  solverModelId: string,
  tldrModelId: string,
  subagentModels: Readonly<Record<string, string>>,
): void {
  if (ids.size === 0) {
    if (
      solverModelId ||
      tldrModelId ||
      Object.keys(subagentModels).length > 0
    ) {
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
  for (const [role, id] of Object.entries(subagentModels)) {
    if (!role.trim() || !ids.has(id)) {
      throw new Error(`SubAgent ${role || "<empty>"} 的模型不存在: ${id}`)
    }
  }
}

function validateProviderGroups(models: readonly StoredModelEntry[]): void {
  const ids = new Set<string>()
  const references = new Set<string>()
  const baseUrls = new Map<string, string>()
  for (const entry of models) {
    if (ids.has(entry.id)) throw new Error(`模型配置 ID 重复: ${entry.id}`)
    ids.add(entry.id)
    const reference = `${entry.provider}/${entry.modelId}`
    if (references.has(reference)) throw new Error(`模型重复: ${reference}`)
    references.add(reference)
    const previous = baseUrls.get(entry.provider)
    if (previous !== undefined && previous !== entry.baseUrl) {
      throw new Error(`同一 Provider 的 Base URL 必须一致: ${entry.provider}`)
    }
    baseUrls.set(entry.provider, entry.baseUrl)
  }
}

function captureCredential(
  credentials: Map<string, string | undefined>,
  entry: ModelPoolEntryUpdate,
): void {
  if (entry.apiKey !== undefined && entry.clearApiKey) {
    throw new Error(`模型 ${entry.id} 不能同时设置和清除 API Key`)
  }
  if (entry.apiKey === undefined && !entry.clearApiKey) return
  const next = entry.clearApiKey ? undefined : entry.apiKey
  if (
    credentials.has(entry.provider) &&
    credentials.get(entry.provider) !== next
  ) {
    throw new Error(`同一 Provider 不能提交不同的 API Key: ${entry.provider}`)
  }
  credentials.set(entry.provider, next)
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
    version: 2,
    models: [],
    solverModelId: "",
    tldrModelId: "",
    subagentModels: {},
  }
}

function providerSecret(provider: string): string {
  const digest = createHash("sha256")
    .update(provider)
    .digest("hex")
    .toUpperCase()
  return `${MODEL_API_KEY_SECRET_PREFIX}${digest.slice(0, 32)}`
}

function resolveModel(
  configuration: StoredModelEntry,
  authentication?: DashboardModelAuthentication,
): Model<Api> {
  const provider = configuration.provider
  const modelId = configuration.modelId
  const baseUrl = configuration.baseUrl.replace(/\/+$/, "")
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
      api: "openai-completions",
      provider,
      baseUrl,
      reasoning,
      thinkingLevelMap,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow,
      maxTokens: contextWindow,
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsUsageInStreaming: false,
        supportsStrictMode: false,
        supportsLongCacheRetention: false,
        maxTokensField: "max_tokens",
      },
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
    throw new Error(
      `当前运行镜像仅支持 OpenAI-compatible 模型: ${provider}/${modelId}`,
    )
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
  return streamSimple(model, context, {
    ...options,
    onPayload: async (payload, payloadModel) => {
      const transformed = await upstreamOnPayload?.(payload, payloadModel)
      return omitOutputTokenLimit(transformed ?? payload)
    },
  })
}

export function omitOutputTokenLimit(payload: unknown): unknown {
  if (!isRecord(payload)) return payload
  const copy = { ...payload }
  delete copy.max_tokens
  delete copy.max_completion_tokens
  return copy
}

function deepseekThinkingLevelMap(
  modelId: string,
): Record<string, string | null> {
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
        Boolean(entry[0].trim()) &&
        typeof entry[1] === "string" &&
        Boolean(entry[1]),
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
