import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { type SecretStore, webAccessSecretName } from "@ctf-agent/core"

/**
 * web-access 支持的 provider 显式 allowlist 白名单。镜像
 * @ctf-agent/web-access 的 RESOLVED_SEARCH_PROVIDERS，校验配置。
 */
const WEB_ACCESS_PROVIDERS = [
  "openai",
  "brave",
  "parallel",
  "tinyfish",
  "search1api",
  "searchinfinity",
  "querit",
  "tavily",
  "jina",
  "searxng",
  "perplexity",
  "gemini",
  "exa",
  "serpdive",
  "kagi",
  "nekozuki",
  "ollama",
  "anysearch",
  "xai",
  "brightdata",
  "serpbase",
] as const

type WebAccessWorkflow = "none" | "auto-summary"

interface StoredWebAccessConfiguration {
  version: 1
  enabled: boolean
  providers: string[]
  workflow: WebAccessWorkflow
  summaryModel?: { provider: string; id: string }
  ssrf: { allowRanges: string[]; trustEnvProxy: boolean }
  providerConfig?: Record<string, Record<string, string>>
  timeouts?: { fetchMs?: number; searchMs?: number; cloneMs?: number }
}

export interface WebAccessProviderView {
  id: string
  /** 是否在 allowlist 中（WebUI 复选框选中状态）。 */
  enabled: boolean
  /** 该 provider 的密钥是否已配置；绝不返回密钥值。 */
  configured: boolean
}

export interface WebAccessConfigurationView {
  enabled: boolean
  providers: WebAccessProviderView[]
  workflow: WebAccessWorkflow
  summaryModel?: { provider: string; id: string }
  ssrf: { allowRanges: string[]; trustEnvProxy: boolean }
  providerConfig?: Record<string, Record<string, string>>
}

export interface WebAccessConfiguration {
  snapshot(): Promise<WebAccessConfigurationView>
  update(input: {
    enabled?: boolean
    providers?: string[]
    workflow?: WebAccessWorkflow
    summaryModel?: { provider: string; id: string }
    ssrf?: Partial<StoredWebAccessConfiguration["ssrf"]>
    timeouts?: StoredWebAccessConfiguration["timeouts"]
    providerConfig?: Record<string, Record<string, string>>
  }): Promise<WebAccessConfigurationView>
  /** 写/删某 provider 的密钥（空值删除）。密钥只进 SecretStore，snapshot 不返回值。 */
  setProviderKey(provider: string, apiKey: string | undefined): Promise<void>
  /** 返回 Project 注入工具时使用的完整配置（含 providerConfig / timeouts）。 */
  projectSnapshot(): Promise<{
    enabled: boolean
    providers: string[]
    workflow: WebAccessWorkflow
    summaryModel?: { provider: string; id: string }
    ssrf: StoredWebAccessConfiguration["ssrf"]
    timeouts: { fetchMs: number; searchMs: number; cloneMs: number }
    providerConfig?: Record<string, Record<string, string>>
  }>
}

function emptyConfiguration(): StoredWebAccessConfiguration {
  return {
    version: 1,
    enabled: false,
    providers: [],
    workflow: "none",
    ssrf: { allowRanges: [], trustEnvProxy: false },
  }
}

function isStoredConfiguration(
  value: unknown,
): value is StoredWebAccessConfiguration {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const config = value as Record<string, unknown>
  if (config.version !== 1) return false
  if (typeof config.enabled !== "boolean") return false
  if (!Array.isArray(config.providers)) return false
  if (config.workflow !== "none" && config.workflow !== "auto-summary") {
    return false
  }
  const ssrf = config.ssrf as { allowRanges?: unknown; trustEnvProxy?: unknown }
  if (!ssrf || typeof ssrf !== "object") return false
  return true
}

function normalizeProviders(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const providers: string[] = []
  for (const entry of value) {
    if (typeof entry !== "string") continue
    const provider = entry.trim().toLowerCase()
    if (
      !WEB_ACCESS_PROVIDERS.includes(
        provider as (typeof WEB_ACCESS_PROVIDERS)[number],
      )
    ) {
      throw new Error(`未知 web-access provider: ${entry}`)
    }
    if (seen.has(provider)) continue
    seen.add(provider)
    providers.push(provider)
  }
  return providers
}

function normalizeWorkflow(value: unknown): WebAccessWorkflow {
  return value === "auto-summary" ? "auto-summary" : "none"
}

function normalizeSummaryModel(
  value: unknown,
): { provider: string; id: string } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined
  const model = value as { provider?: unknown; id?: unknown }
  if (typeof model.provider !== "string" || typeof model.id !== "string") {
    return undefined
  }
  const provider = model.provider.trim()
  const id = model.id.trim()
  if (!provider || !id) return undefined
  return { provider, id }
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === "string")
}

function normalizeSsrf(value: unknown): StoredWebAccessConfiguration["ssrf"] {
  const ssrf =
    value && typeof value === "object" ? (value as Record<string, unknown>) : {}
  return {
    allowRanges: normalizeStringArray(ssrf.allowRanges),
    trustEnvProxy: ssrf.trustEnvProxy === true,
  }
}

export async function createFileWebAccessConfiguration(options: {
  storagePath: string
  secretStore: SecretStore
}): Promise<WebAccessConfiguration> {
  let configuration: StoredWebAccessConfiguration
  try {
    const parsed: unknown = JSON.parse(
      await readFile(options.storagePath, "utf8"),
    )
    configuration = isStoredConfiguration(parsed)
      ? {
          ...parsed,
          providers: normalizeProviders(parsed.providers),
          workflow: normalizeWorkflow(parsed.workflow),
          summaryModel: normalizeSummaryModel(parsed.summaryModel),
          ssrf: normalizeSsrf(parsed.ssrf),
        }
      : emptyConfiguration()
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      configuration = emptyConfiguration()
    } else {
      throw new Error(`无法读取 web-access 配置: ${options.storagePath}`, {
        cause: error,
      })
    }
  }

  async function persist(value: StoredWebAccessConfiguration): Promise<void> {
    await mkdir(dirname(options.storagePath), { recursive: true, mode: 0o700 })
    const temporary = `${options.storagePath}.${process.pid}.${Date.now()}.tmp`
    try {
      await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      })
      await rename(temporary, options.storagePath)
      await chmod(options.storagePath, 0o600)
    } finally {
      await rm(temporary, { force: true })
    }
  }

  function toView(
    value: StoredWebAccessConfiguration,
  ): WebAccessConfigurationView {
    return {
      enabled: value.enabled,
      providers: WEB_ACCESS_PROVIDERS.map((provider) => ({
        id: provider,
        enabled: value.providers.includes(provider),
        configured: options.secretStore.has(webAccessSecretName(provider)),
      })),
      workflow: value.workflow,
      ...(value.summaryModel ? { summaryModel: value.summaryModel } : {}),
      ssrf: value.ssrf,
      ...(value.providerConfig ? { providerConfig: value.providerConfig } : {}),
    }
  }

  return {
    async snapshot() {
      return toView(configuration)
    },

    async update(input) {
      const next: StoredWebAccessConfiguration = {
        version: 1,
        enabled:
          input.enabled === undefined
            ? configuration.enabled
            : Boolean(input.enabled),
        providers:
          input.providers === undefined
            ? configuration.providers
            : normalizeProviders(input.providers),
        workflow:
          input.workflow === undefined
            ? configuration.workflow
            : normalizeWorkflow(input.workflow),
        summaryModel:
          input.summaryModel === undefined
            ? configuration.summaryModel
            : normalizeSummaryModel(input.summaryModel),
        ssrf:
          input.ssrf === undefined
            ? configuration.ssrf
            : {
                allowRanges:
                  input.ssrf.allowRanges === undefined
                    ? configuration.ssrf.allowRanges
                    : normalizeStringArray(input.ssrf.allowRanges),
                trustEnvProxy:
                  input.ssrf.trustEnvProxy === undefined
                    ? configuration.ssrf.trustEnvProxy
                    : input.ssrf.trustEnvProxy === true,
              },
        ...(input.timeouts ? { timeouts: input.timeouts } : {}),
        ...(input.providerConfig
          ? { providerConfig: input.providerConfig }
          : {}),
      }
      configuration = next
      await persist(next)
      return toView(next)
    },

    async setProviderKey(provider, apiKey) {
      const normalized = provider.trim().toLowerCase()
      if (
        !WEB_ACCESS_PROVIDERS.includes(
          normalized as (typeof WEB_ACCESS_PROVIDERS)[number],
        )
      ) {
        throw new Error(`未知 web-access provider: ${provider}`)
      }
      await options.secretStore.set({
        [webAccessSecretName(normalized)]: apiKey,
      })
    },

    async projectSnapshot() {
      return {
        enabled: configuration.enabled,
        providers: configuration.providers,
        workflow: configuration.workflow,
        ...(configuration.summaryModel
          ? { summaryModel: configuration.summaryModel }
          : {}),
        ssrf: configuration.ssrf,
        timeouts: {
          fetchMs: configuration.timeouts?.fetchMs ?? 30_000,
          searchMs: configuration.timeouts?.searchMs ?? 30_000,
          cloneMs: configuration.timeouts?.cloneMs ?? 30_000,
        },
        ...(configuration.providerConfig
          ? { providerConfig: configuration.providerConfig }
          : {}),
      }
    },
  }
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  )
}
