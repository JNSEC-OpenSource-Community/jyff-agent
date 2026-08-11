import { activityMonitor } from "./activity.ts"
import { redactCredential } from "./credential-source.ts"
import type { ExtractedContent } from "./extract.ts"
import type { SearchOptions, SearchResponse } from "./perplexity.ts"
import { providerKeyConfigured, resolveProviderKey } from "./runtime.ts"

const TAVILY_API_URL = "https://api.tavily.com/search"
const SEARCH_TIMEOUT_MS = 60_000

interface TavilyResult {
  title?: string
  url?: string
  content?: string
  raw_content?: string | null
}

interface TavilyResponse {
  answer?: string
  results?: TavilyResult[]
}

interface TavilySearchOptions extends SearchOptions {
  includeContent?: boolean
}

function getApiKey(_signal?: AbortSignal): string | undefined {
  return resolveProviderKey("tavily")
}

function requireApiKey(_signal?: AbortSignal): string {
  const apiKey = getApiKey(_signal)
  if (!apiKey) {
    throw new Error("Tavily Search API key not configured. Set it via the WebUI plugins settings.")
  }
  return apiKey
}

function normalizeCount(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 5
  return Math.max(1, Math.min(Math.floor(value), 20))
}

function normalizeDomain(value: string): string | null {
  let input = value.trim().toLowerCase()
  if (!input) return null
  if (input.startsWith("-")) input = input.slice(1).trim()
  if (!input) return null
  try {
    const parsed = input.includes("://") ? new URL(input) : new URL(`https://${input}`)
    input = parsed.hostname
  } catch {
    input = input.split("/")[0]?.split(":")[0] ?? ""
  }
  input = input.replace(/^\.+|\.+$/g, "")
  return /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(input) ? input : null
}

function mapDomainFilter(domainFilter: string[] | undefined): {
  include_domains?: string[]
  exclude_domains?: string[]
} {
  if (!domainFilter?.length) return {}
  const include_domains: string[] = []
  const exclude_domains: string[] = []
  for (const raw of domainFilter) {
    const domain = normalizeDomain(raw)
    if (!domain) continue
    const target = raw.trim().startsWith("-") ? exclude_domains : include_domains
    if (!target.includes(domain)) target.push(domain)
  }
  return {
    ...(include_domains.length > 0 ? { include_domains } : {}),
    ...(exclude_domains.length > 0 ? { exclude_domains } : {}),
  }
}

function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(SEARCH_TIMEOUT_MS)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function mapResults(
  results: TavilyResult[] | undefined,
  numResults: number,
): SearchResponse["results"] {
  if (!Array.isArray(results)) return []
  const mapped: SearchResponse["results"] = []
  for (const item of results) {
    if (!item?.url) continue
    mapped.push({
      title: item.title || `Source ${mapped.length + 1}`,
      url: item.url,
      snippet: typeof item.content === "string" ? item.content.replace(/\s+/g, " ").trim() : "",
    })
    if (mapped.length >= numResults) break
  }
  return mapped
}

function mapInlineContent(results: TavilyResult[] | undefined): ExtractedContent[] {
  if (!Array.isArray(results)) return []
  return results.flatMap((item) => {
    if (!item?.url || typeof item.raw_content !== "string" || item.raw_content.trim().length === 0)
      return []
    return [
      {
        url: item.url,
        title: item.title || "",
        content: item.raw_content,
        error: null,
      },
    ]
  })
}

export function isTavilyAvailable(): boolean {
  return providerKeyConfigured("tavily")
}

export async function searchWithTavily(
  query: string,
  options: TavilySearchOptions = {},
): Promise<SearchResponse> {
  const apiKey = requireApiKey(options.signal)
  const numResults = normalizeCount(options.numResults)
  const body: Record<string, unknown> = {
    query,
    search_depth: "basic",
    max_results: numResults,
    include_answer: "basic",
    include_raw_content: options.includeContent ? "markdown" : false,
    ...(options.recencyFilter ? { time_range: options.recencyFilter } : {}),
    ...mapDomainFilter(options.domainFilter),
  }

  const activityId = activityMonitor.logStart({ type: "api", query })
  let response: Response
  try {
    response = await fetch(TAVILY_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: requestSignal(options.signal),
    })
  } catch (err) {
    const message = errorMessage(err)
    const redactedMessage = redactCredential(message, apiKey)
    if (redactedMessage.toLowerCase().includes("abort")) activityMonitor.logComplete(activityId, 0)
    else activityMonitor.logError(activityId, redactedMessage)
    if (redactedMessage === message) throw err
    const redactedError = new Error(redactedMessage)
    if (err instanceof Error) redactedError.name = err.name
    throw redactedError
  }

  if (!response.ok) {
    activityMonitor.logComplete(activityId, response.status)
    const errorText = redactCredential(await response.text(), apiKey)
    throw new Error(`Tavily API error ${response.status}: ${errorText.slice(0, 300)}`)
  }

  let data: TavilyResponse
  try {
    data = (await response.json()) as TavilyResponse
  } catch (err) {
    activityMonitor.logComplete(activityId, response.status)
    throw new Error(`Tavily API returned invalid JSON: ${errorMessage(err)}`)
  }

  activityMonitor.logComplete(activityId, response.status)
  const result: SearchResponse = {
    answer: typeof data.answer === "string" ? data.answer : "",
    results: mapResults(data.results, numResults),
  }
  if (options.includeContent) {
    const inlineContent = mapInlineContent(data.results)
    if (inlineContent.length > 0) result.inlineContent = inlineContent
  }
  return result
}
