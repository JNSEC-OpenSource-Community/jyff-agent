import { activityMonitor } from "./activity.ts"
import { isAnySearchAvailable, searchWithAnySearch } from "./anysearch.ts"
import { isBraveAvailable, searchWithBrave } from "./brave.ts"
import { isBrightDataAvailable, searchWithBrightData } from "./brightdata.ts"
import { CredentialResolutionError } from "./credential-source.ts"
import { isExaAvailable, searchWithExa } from "./exa.ts"
import {
  fetchGeminiApi,
  getApiKey,
  getVersionedApiBase,
  isGatewayConfigured,
  isGeminiApiAvailable,
  redactGeminiApiResponse,
} from "./gemini-api.ts"
import { isJinaSearchAvailable, searchWithJina } from "./jina-search.ts"
import { isKagiAvailable, searchWithKagi } from "./kagi.ts"
import { isOllamaAvailable, searchWithOllama } from "./ollama.ts"
import { isOpenAISearchAvailable, searchWithOpenAI } from "./openai-search.ts"
import { isParallelAvailable, searchWithParallel } from "./parallel.ts"
import {
  isPerplexityAvailable,
  type SearchOptions,
  type SearchResponse,
  type SearchResult,
  searchWithPerplexity,
} from "./perplexity.ts"
import { isQueritAvailable, searchWithQuerit } from "./querit.ts"
import { getRuntime, type ModelAuthResolver } from "./runtime.ts"
import { isSearch1APIAvailable, searchWithSearch1API } from "./search1api.ts"
import {
  isSearchinfinityAvailable,
  searchWithSearchinfinity,
} from "./searchinfinity.ts"
import { isSearXNGAvailable, searchWithSearXNG } from "./searxng.ts"
import { isSerpBaseAvailable, searchWithSerpBase } from "./serpbase.ts"
import { isSerpdiveAvailable, searchWithSerpdive } from "./serpdive.ts"
import { isTavilyAvailable, searchWithTavily } from "./tavily.ts"
import { isTinyFishAvailable, searchWithTinyFish } from "./tinyfish.ts"
import { isXaiSearchAvailable, searchWithXai } from "./xai-search.ts"

export const RESOLVED_SEARCH_PROVIDERS = [
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
  "ollama",
  "anysearch",
  "xai",
  "brightdata",
  "serpbase",
] as const
export const SEARCH_PROVIDERS = [
  "auto",
  "all",
  ...RESOLVED_SEARCH_PROVIDERS,
] as const

export type ResolvedSearchProvider = (typeof RESOLVED_SEARCH_PROVIDERS)[number]
export type SearchProvider = (typeof SEARCH_PROVIDERS)[number]
export type SearchProviderSelection = SearchProvider | ResolvedSearchProvider[]
export type SearchProviderErrorKind =
  | "transient"
  | "quota"
  | "network"
  | "credential"
  | "config"
  | "auth"
  | "invalid-request"
  | "invalid-response"
  | "aborted"
  | "unknown"

export interface SearchRoutingConfig {
  providers: ResolvedSearchProvider[]
  fallbackOn: Array<
    Extract<SearchProviderErrorKind, "transient" | "quota" | "network">
  >
}

export class SearchProviderError extends Error {
  readonly provider: ResolvedSearchProvider
  readonly kind: SearchProviderErrorKind
  readonly status?: number
  readonly causeError: unknown

  constructor(
    provider: ResolvedSearchProvider,
    kind: SearchProviderErrorKind,
    message: string,
    status: number | undefined,
    cause: unknown,
  ) {
    super(`${provider} search failed (${kind}): ${message}`)
    this.name = "SearchProviderError"
    this.provider = provider
    this.kind = kind
    this.status = status
    this.causeError = cause
  }
}

export interface ProviderSearchResponse extends SearchResponse {
  provider: ResolvedSearchProvider
}

export interface ProviderSearchFailure {
  provider: ResolvedSearchProvider
  error: string
}

export interface AttributedSearchResponse extends SearchResponse {
  provider: ResolvedSearchProvider | "all"
  providerResponses?: ProviderSearchResponse[]
  providerErrors?: ProviderSearchFailure[]
}

const DEFAULT_SEARCH_MODEL = "gemini-3.6-flash"
// Explicit-only providers (AnySearch, xAI, Bright Data, SerpBase) are deliberately absent:
// `all` must never fan out to a paid/surprising provider without the user asking for it.
const ALL_SEARCH_PROVIDERS: ResolvedSearchProvider[] = [
  "searxng",
  "openai",
  "exa",
  "brave",
  "parallel",
  "tinyfish",
  "search1api",
  "searchinfinity",
  "querit",
  "tavily",
  "jina",
  "serpdive",
  "kagi",
  "ollama",
  "perplexity",
  "gemini",
]

type SearchConfig = {
  searchProvider: SearchProviderSelection
  searchProviderConfigured: boolean
  searchRouting?: SearchRoutingConfig
  searchModel?: string
}

/** 运行时 provider 显式 allowlist 门控。不在 allowlist 内的 provider 一律不可用。 */
export function isProviderEnabled(provider: ResolvedSearchProvider): boolean {
  return getRuntime().providers.has(provider)
}

/** 本 fork 无 web-search.json：provider 默认 "auto"、无显式 routing，全部来自 runtime。 */
function getSearchConfig(): SearchConfig {
  return { searchProvider: "auto", searchProviderConfigured: false }
}

export function getConfiguredSearchRouting(): SearchRoutingConfig | undefined {
  const config = getSearchConfig()
  return config.searchProviderConfigured ? undefined : config.searchRouting
}

function normalizeResolvedProviderList(
  value: unknown,
  label: string,
): ResolvedSearchProvider[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty array`)
  }
  const providers: ResolvedSearchProvider[] = []
  for (const provider of value) {
    const normalized =
      typeof provider === "string" ? provider.trim().toLowerCase() : ""
    if (
      !RESOLVED_SEARCH_PROVIDERS.includes(normalized as ResolvedSearchProvider)
    ) {
      throw new Error(
        `${label} contains an invalid provider: ${String(provider)}`,
      )
    }
    if (providers.includes(normalized as ResolvedSearchProvider)) {
      throw new Error(`${label} must not contain duplicates: ${normalized}`)
    }
    providers.push(normalized as ResolvedSearchProvider)
  }
  return providers
}

export function normalizeSearchProviderSelection(
  value: unknown,
  label = "provider",
): SearchProviderSelection {
  if (Array.isArray(value)) return normalizeResolvedProviderList(value, label)
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : ""
  return SEARCH_PROVIDERS.includes(normalized as SearchProvider)
    ? (normalized as SearchProvider)
    : "auto"
}

export interface FullSearchOptions extends SearchOptions {
  provider?: SearchProviderSelection
  includeContent?: boolean
  modelAuth?: ModelAuthResolver
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function isAbortError(err: unknown): boolean {
  return errorMessage(err).toLowerCase().includes("abort")
}

function shouldTryOpenAIInAuto(options: SearchOptions): boolean {
  if (options.recencyFilter) return false
  if (
    typeof options.numResults === "number" &&
    Number.isFinite(options.numResults) &&
    Math.floor(options.numResults) !== 5
  ) {
    return false
  }
  return true
}

async function searchWithGemini(
  query: string,
  options: SearchOptions,
  strictErrors: boolean,
): Promise<SearchResponse | null> {
  const errors: string[] = []

  try {
    const apiResult = await searchWithGeminiApi(query, options)
    if (apiResult) return apiResult
  } catch (err) {
    if (err instanceof CredentialResolutionError || isAbortError(err)) throw err
    errors.push(`Gemini API: ${errorMessage(err)}`)
  }

  if (strictErrors && errors.length > 0) {
    throw new Error(`Gemini search failed:\n  - ${errors.join("\n  - ")}`)
  }

  return null
}

function providerErrorStatus(message: string): number | undefined {
  const match = message.match(/\b(?:error|status|http)\s+(\d{3})\b/i)
  if (!match) return undefined
  return Number(match[1])
}

function classifyProviderError(
  provider: ResolvedSearchProvider,
  err: unknown,
): SearchProviderError {
  if (err instanceof SearchProviderError) return err
  const message = errorMessage(err)
  const lower = message.toLowerCase()
  const status = providerErrorStatus(message)
  let kind: SearchProviderErrorKind = "unknown"
  if (
    err instanceof CredentialResolutionError ||
    /(?:api )?key (?:not found|missing)|credential resolution/.test(lower)
  ) {
    kind = "credential"
  } else if (isAbortError(err)) {
    kind = "aborted"
  } else if (
    provider === "xai" &&
    status === 403 &&
    /spending[- ]limit|(?:no|out of) credits?|insufficient quota|quota (?:exceeded|exhausted)|credits? (?:exhausted|depleted|used up)/.test(
      lower,
    )
  ) {
    kind = "quota"
  } else if (status === 401 || status === 403) {
    kind = "auth"
  } else if (status === 400 || status === 422) {
    kind = "invalid-request"
  } else if (status === 402 || status === 429) {
    kind = "quota"
  } else if (
    status !== undefined &&
    (status === 408 || status === 425 || status >= 500)
  ) {
    kind = "transient"
  } else if (/rate limit|quota|too many requests/.test(lower)) {
    kind = "quota"
  } else if (/unauthorized|forbidden|permission denied/.test(lower)) {
    kind = "auth"
  } else if (/bad request|invalid request/.test(lower)) {
    kind = "invalid-request"
  } else if (
    /invalid json|no parseable response|returned invalid response|returned empty response/.test(
      lower,
    )
  ) {
    kind = "invalid-response"
  } else if (/temporar|service unavailable|server error/.test(lower)) {
    kind = "transient"
  } else if (
    err instanceof TypeError ||
    /fetch failed|network|econnreset|econnrefused|enotfound|etimedout|timed out|socket/.test(
      lower,
    )
  ) {
    kind = "network"
  } else if (
    /invalid or missing|invalid config|failed to parse|must be an? |configuration/.test(
      lower,
    )
  ) {
    kind = "config"
  }
  return new SearchProviderError(provider, kind, message, status, err)
}

async function searchWithResolvedProvider(
  provider: ResolvedSearchProvider,
  query: string,
  options: FullSearchOptions,
): Promise<AttributedSearchResponse> {
  if (provider === "openai") {
    const result = await searchWithOpenAI(query, options, options.modelAuth)
    return { ...result, provider }
  }
  if (provider === "brave")
    return { ...(await searchWithBrave(query, options)), provider }
  if (provider === "parallel")
    return { ...(await searchWithParallel(query, options)), provider }
  if (provider === "tinyfish")
    return { ...(await searchWithTinyFish(query, options)), provider }
  if (provider === "search1api")
    return { ...(await searchWithSearch1API(query, options)), provider }
  if (provider === "searchinfinity")
    return { ...(await searchWithSearchinfinity(query, options)), provider }
  if (provider === "querit")
    return { ...(await searchWithQuerit(query, options)), provider }
  if (provider === "tavily")
    return { ...(await searchWithTavily(query, options)), provider }
  if (provider === "jina")
    return { ...(await searchWithJina(query, options)), provider }
  if (provider === "serpdive")
    return { ...(await searchWithSerpdive(query, options)), provider }
  if (provider === "kagi")
    return { ...(await searchWithKagi(query, options)), provider }
  if (provider === "ollama")
    return { ...(await searchWithOllama(query, options)), provider }
  if (provider === "anysearch")
    return { ...(await searchWithAnySearch(query, options)), provider }
  if (provider === "xai")
    return {
      ...(await searchWithXai(query, options, options.modelAuth)),
      provider,
    }
  if (provider === "brightdata")
    return { ...(await searchWithBrightData(query, options)), provider }
  if (provider === "serpbase")
    return { ...(await searchWithSerpBase(query, options)), provider }
  if (provider === "perplexity")
    return { ...(await searchWithPerplexity(query, options)), provider }
  if (provider === "searxng")
    return { ...(await searchWithSearXNG(query, options)), provider }
  if (provider === "gemini") {
    const result = await searchWithGemini(query, options, true)
    if (result) return { ...result, provider }
    throw new Error(
      "Gemini search unavailable. Configure the gemini API key via the WebUI plugins settings.",
    )
  }
  const result = await searchWithExa(query, options)
  if (result) return { ...result, provider }
  throw new Error("Exa search returned no results.")
}

async function isResolvedProviderAvailable(
  provider: ResolvedSearchProvider,
  options: FullSearchOptions,
): Promise<boolean> {
  if (!isProviderEnabled(provider)) return false
  if (provider === "openai") return isOpenAISearchAvailable(options.modelAuth)
  if (provider === "brave") return isBraveAvailable()
  if (provider === "parallel") return isParallelAvailable()
  if (provider === "tinyfish") return isTinyFishAvailable()
  if (provider === "search1api") return isSearch1APIAvailable()
  if (provider === "searchinfinity") return isSearchinfinityAvailable()
  if (provider === "querit") return isQueritAvailable()
  if (provider === "tavily") return isTavilyAvailable()
  if (provider === "jina") return isJinaSearchAvailable()
  if (provider === "serpdive") return isSerpdiveAvailable()
  if (provider === "kagi") return isKagiAvailable()
  if (provider === "ollama") return isOllamaAvailable()
  if (provider === "anysearch") return isAnySearchAvailable()
  if (provider === "xai") return isXaiSearchAvailable(options.modelAuth)
  if (provider === "brightdata") return isBrightDataAvailable()
  if (provider === "serpbase") return isSerpBaseAvailable()
  if (provider === "perplexity") return isPerplexityAvailable()
  if (provider === "searxng") return isSearXNGAvailable()
  if (provider === "gemini") return isGeminiApiAvailable()
  return isExaAvailable()
}

function providerLabel(provider: ResolvedSearchProvider): string {
  if (provider === "openai") return "OpenAI"
  if (provider === "tinyfish") return "TinyFish"
  if (provider === "search1api") return "Search1API"
  if (provider === "searchinfinity") return "Searchinfinity"
  if (provider === "querit") return "Querit"
  if (provider === "serpdive") return "SERPdive"
  if (provider === "searxng") return "SearXNG"
  if (provider === "kagi") return "Kagi"
  if (provider === "ollama") return "Ollama"
  if (provider === "xai") return "xAI"
  if (provider === "brightdata") return "Bright Data"
  if (provider === "serpbase") return "SerpBase"
  return provider.charAt(0).toUpperCase() + provider.slice(1)
}

async function searchWithAllProvider(
  provider: ResolvedSearchProvider,
  query: string,
  options: FullSearchOptions,
): Promise<AttributedSearchResponse> {
  if (provider !== "gemini")
    return searchWithResolvedProvider(provider, query, options)
  const result = await searchWithGeminiApi(query, options)
  if (result) return { ...result, provider }
  throw new Error("Gemini API search returned no results.")
}

async function searchWithProviders(
  query: string,
  options: FullSearchOptions,
  selectedProviders?: ResolvedSearchProvider[],
): Promise<AttributedSearchResponse> {
  const providers = selectedProviders
    ? selectedProviders.filter(isProviderEnabled)
    : (
        await Promise.all(
          ALL_SEARCH_PROVIDERS.filter(isProviderEnabled).map(
            async (provider) => ({
              provider,
              available:
                provider === "gemini"
                  ? isGeminiApiAvailable()
                  : await isResolvedProviderAvailable(provider, options),
            }),
          ),
        )
      )
        .filter((entry) => entry.available)
        .map((entry) => entry.provider)
  if (providers.length === 0) {
    throw new Error(
      'No configured search provider available for provider "all". AnySearch, xAI, Bright Data, and SerpBase are excluded.',
    )
  }

  const settled = await Promise.allSettled(
    providers.map((provider) =>
      selectedProviders
        ? searchWithResolvedProvider(provider, query, options)
        : searchWithAllProvider(provider, query, options),
    ),
  )
  if (options.signal?.aborted) throw new Error("Aborted")

  const successes: AttributedSearchResponse[] = []
  const failures: Array<{ provider: ResolvedSearchProvider; error: string }> =
    []
  for (const [index, outcome] of settled.entries()) {
    const provider = providers[index]
    if (!provider) continue
    if (outcome.status === "fulfilled") {
      successes.push(outcome.value)
    } else {
      failures.push({ provider, error: errorMessage(outcome.reason) })
    }
  }
  if (successes.length === 0) {
    const label = selectedProviders ? "Selected-provider" : "All-provider"
    throw new Error(
      `${label} search failed:\n  - ${failures.map(({ provider, error }) => `${providerLabel(provider)}: ${error}`).join("\n  - ")}`,
    )
  }

  const results: SearchResult[] = []
  const seenResultUrls = new Set<string>()
  const inlineContent: NonNullable<SearchResponse["inlineContent"]> = []
  const seenInlineUrls = new Set<string>()
  for (const response of successes) {
    for (const result of response.results) {
      if (seenResultUrls.has(result.url)) continue
      seenResultUrls.add(result.url)
      results.push(result)
    }
    for (const content of response.inlineContent ?? []) {
      if (seenInlineUrls.has(content.url)) continue
      seenInlineUrls.add(content.url)
      inlineContent.push(content)
    }
  }

  const answerSections = successes.map(
    (response) =>
      `## ${providerLabel(response.provider as ResolvedSearchProvider)}\n\n${response.answer || "(No answer text returned.)"}`,
  )
  if (failures.length > 0) {
    answerSections.push(
      `## Provider errors\n\n${failures.map(({ provider, error }) => `- **${providerLabel(provider)}:** ${error}`).join("\n")}`,
    )
  }

  return {
    provider: "all",
    answer: answerSections.join("\n\n"),
    results,
    providerResponses: successes as ProviderSearchResponse[],
    ...(failures.length > 0 ? { providerErrors: failures } : {}),
    ...(inlineContent.length > 0 ? { inlineContent } : {}),
  }
}

async function searchWithConfiguredRouting(
  query: string,
  options: FullSearchOptions,
  routing: SearchRoutingConfig,
): Promise<AttributedSearchResponse> {
  const diagnostics: string[] = []
  for (const provider of routing.providers) {
    if (!(await isResolvedProviderAvailable(provider, options))) {
      diagnostics.push(`${provider}: unavailable`)
      continue
    }
    try {
      return await searchWithResolvedProvider(provider, query, options)
    } catch (err) {
      const classified = classifyProviderError(provider, err)
      diagnostics.push(`${provider} [${classified.kind}]: ${errorMessage(err)}`)
      if (
        !routing.fallbackOn.includes(
          classified.kind as SearchRoutingConfig["fallbackOn"][number],
        )
      ) {
        throw classified
      }
    }
  }
  throw new Error(
    `Configured search routing exhausted:\n  - ${diagnostics.join("\n  - ")}`,
  )
}

export async function search(
  query: string,
  options: FullSearchOptions = {},
): Promise<AttributedSearchResponse> {
  const config = getSearchConfig()
  const provider =
    options.provider === undefined || options.provider === "auto"
      ? config.searchProvider
      : options.provider
  if (Array.isArray(provider)) {
    return searchWithProviders(
      query,
      options,
      normalizeResolvedProviderList(provider, "provider"),
    )
  }
  if (provider === "all") return searchWithProviders(query, options)
  if (provider !== "auto")
    return searchWithResolvedProvider(provider, query, options)
  if (!config.searchProviderConfigured && config.searchRouting) {
    return searchWithConfiguredRouting(query, options, config.searchRouting)
  }

  const fallbackErrors: string[] = []

  if (isSearXNGAvailable() && isProviderEnabled("searxng")) {
    try {
      const result = await searchWithSearXNG(query, options)
      return { ...result, provider: "searxng" }
    } catch (err) {
      if (isAbortError(err)) throw err
      fallbackErrors.push(`SearXNG: ${errorMessage(err)}`)
    }
  }

  if (shouldTryOpenAIInAuto(options) && isProviderEnabled("openai")) {
    try {
      if (await isOpenAISearchAvailable(options.modelAuth)) {
        const result = await searchWithOpenAI(query, options, options.modelAuth)
        return { ...result, provider: "openai" }
      }
    } catch (err) {
      if (isAbortError(err)) throw err
      fallbackErrors.push(`OpenAI: ${errorMessage(err)}`)
    }
  }

  if (isExaAvailable() && isProviderEnabled("exa")) {
    try {
      const result = await searchWithExa(query, options)
      if (result) return { ...result, provider: "exa" }
    } catch (err) {
      if (err instanceof CredentialResolutionError || isAbortError(err))
        throw err
      fallbackErrors.push(`Exa: ${errorMessage(err)}`)
    }
  }

  if (isBraveAvailable() && isProviderEnabled("brave")) {
    try {
      const result = await searchWithBrave(query, options)
      return { ...result, provider: "brave" }
    } catch (err) {
      if (isAbortError(err)) throw err
      fallbackErrors.push(`Brave: ${errorMessage(err)}`)
    }
  }

  if (isParallelAvailable() && isProviderEnabled("parallel")) {
    try {
      const result = await searchWithParallel(query, options)
      return { ...result, provider: "parallel" }
    } catch (err) {
      if (isAbortError(err)) throw err
      fallbackErrors.push(`Parallel: ${errorMessage(err)}`)
    }
  }

  if (isTinyFishAvailable() && isProviderEnabled("tinyfish")) {
    try {
      const result = await searchWithTinyFish(query, options)
      return { ...result, provider: "tinyfish" }
    } catch (err) {
      if (isAbortError(err)) throw err
      fallbackErrors.push(`TinyFish: ${errorMessage(err)}`)
    }
  }

  if (isSearch1APIAvailable() && isProviderEnabled("search1api")) {
    try {
      const result = await searchWithSearch1API(query, options)
      return { ...result, provider: "search1api" }
    } catch (err) {
      if (isAbortError(err)) throw err
      fallbackErrors.push(`Search1API: ${errorMessage(err)}`)
    }
  }

  if (isSearchinfinityAvailable() && isProviderEnabled("searchinfinity")) {
    try {
      const result = await searchWithSearchinfinity(query, options)
      return { ...result, provider: "searchinfinity" }
    } catch (err) {
      if (isAbortError(err)) throw err
      fallbackErrors.push(`Searchinfinity: ${errorMessage(err)}`)
    }
  }

  if (isQueritAvailable() && isProviderEnabled("querit")) {
    try {
      const result = await searchWithQuerit(query, options)
      return { ...result, provider: "querit" }
    } catch (err) {
      if (isAbortError(err)) throw err
      fallbackErrors.push(`Querit: ${errorMessage(err)}`)
    }
  }

  if (isTavilyAvailable() && isProviderEnabled("tavily")) {
    try {
      const result = await searchWithTavily(query, options)
      return { ...result, provider: "tavily" }
    } catch (err) {
      if (isAbortError(err)) throw err
      fallbackErrors.push(`Tavily: ${errorMessage(err)}`)
    }
  }

  if (isJinaSearchAvailable() && isProviderEnabled("jina")) {
    try {
      const result = await searchWithJina(query, options)
      return { ...result, provider: "jina" }
    } catch (err) {
      if (isAbortError(err)) throw err
      fallbackErrors.push(`Jina: ${errorMessage(err)}`)
    }
  }

  if (isSerpdiveAvailable() && isProviderEnabled("serpdive")) {
    try {
      const result = await searchWithSerpdive(query, options)
      return { ...result, provider: "serpdive" }
    } catch (err) {
      if (isAbortError(err)) throw err
      fallbackErrors.push(`SERPdive: ${errorMessage(err)}`)
    }
  }

  if (isKagiAvailable() && isProviderEnabled("kagi")) {
    try {
      const result = await searchWithKagi(query, options)
      return { ...result, provider: "kagi" }
    } catch (err) {
      if (isAbortError(err)) throw err
      fallbackErrors.push(`Kagi: ${errorMessage(err)}`)
    }
  }

  if (isOllamaAvailable() && isProviderEnabled("ollama")) {
    try {
      const result = await searchWithOllama(query, options)
      return { ...result, provider: "ollama" }
    } catch (err) {
      if (isAbortError(err)) throw err
      fallbackErrors.push(`Ollama: ${errorMessage(err)}`)
    }
  }

  if (isPerplexityAvailable() && isProviderEnabled("perplexity")) {
    try {
      const result = await searchWithPerplexity(query, options)
      return { ...result, provider: "perplexity" }
    } catch (err) {
      if (isAbortError(err)) throw err
      fallbackErrors.push(`Perplexity: ${errorMessage(err)}`)
    }
  }

  if (isProviderEnabled("gemini")) {
    try {
      const geminiResult = await searchWithGemini(query, options, false)
      if (geminiResult) return { ...geminiResult, provider: "gemini" }
    } catch (err) {
      if (isAbortError(err)) throw err
      fallbackErrors.push(`Gemini: ${errorMessage(err)}`)
    }
  }

  if (fallbackErrors.length > 0) {
    throw new Error(
      `Auto provider search failed:\n  - ${fallbackErrors.join("\n  - ")}`,
    )
  }

  throw new Error(
    'No search provider available. Configure provider keys via the WebUI plugins settings, or pass an explicit provider ("anysearch" for anonymous search, "xai" for Grok, "brightdata" with a SERP zone, "serpbase" with an API key).',
  )
}

async function searchWithGeminiApi(
  query: string,
  options: SearchOptions = {},
): Promise<SearchResponse | null> {
  const requestSignal = AbortSignal.any([
    AbortSignal.timeout(60000),
    ...(options.signal ? [options.signal] : []),
  ])
  const apiKey = await getApiKey(requestSignal)
  if (!apiKey && !isGatewayConfigured()) return null

  const activityId = activityMonitor.logStart({ type: "api", query })

  try {
    const model = DEFAULT_SEARCH_MODEL
    const body = {
      contents: [{ role: "user", parts: [{ text: query }] }],
      tools: [{ google_search: {} }],
    }

    const res = await fetchGeminiApi(
      `${getVersionedApiBase()}/models/${model}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: requestSignal,
      },
      apiKey,
    )

    if (!res.ok) {
      const errorText = redactGeminiApiResponse(res, await res.text(), apiKey)
      throw new Error(
        `Gemini API error ${res.status}: ${errorText.slice(0, 300)}`,
      )
    }

    const data = (await res.json()) as GeminiSearchResponse
    activityMonitor.logComplete(activityId, res.status)

    const answer =
      data.candidates?.[0]?.content?.parts
        ?.map((p) => p.text)
        .filter(Boolean)
        .join("\n") ?? ""

    const metadata = data.candidates?.[0]?.groundingMetadata
    const results = await resolveGroundingChunks(
      metadata?.groundingChunks,
      options.signal,
    )

    if (!answer && results.length === 0) return null
    return { answer, results }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.toLowerCase().includes("abort")) {
      activityMonitor.logComplete(activityId, 0)
    } else {
      activityMonitor.logError(activityId, message)
    }
    throw err
  }
}

async function resolveGroundingChunks(
  chunks: GroundingChunk[] | undefined,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  if (!chunks?.length) return []

  const results: SearchResult[] = []
  for (const chunk of chunks) {
    if (!chunk.web) continue
    const title = chunk.web.title || ""
    let url = chunk.web.uri || ""

    if (
      url.includes("vertexaisearch.cloud.google.com/grounding-api-redirect")
    ) {
      const resolved = await resolveRedirect(url, signal)
      if (resolved) url = resolved
    }

    if (url) results.push({ title, url, snippet: "" })
  }
  return results
}

async function resolveRedirect(
  proxyUrl: string,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const res = await fetch(proxyUrl, {
      method: "HEAD",
      redirect: "manual",
      signal: AbortSignal.any([
        AbortSignal.timeout(5000),
        ...(signal ? [signal] : []),
      ]),
    })
    return res.headers.get("location") || null
  } catch {
    return null
  }
}

interface GeminiSearchResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> }
    groundingMetadata?: {
      webSearchQueries?: string[]
      groundingChunks?: GroundingChunk[]
      groundingSupports?: Array<{
        segment?: { startIndex?: number; endIndex?: number; text?: string }
        groundingChunkIndices?: number[]
      }>
    }
  }>
}

interface GroundingChunk {
  web?: { uri?: string; title?: string }
}
