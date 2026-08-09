import { activityMonitor } from "./activity.ts"
import { redactCredential } from "./credential-source.ts"
import type { ExtractedContent, ExtractOptions } from "./extract.ts"
import {
  providerKeyConfigured,
  providerOption,
  resolveProviderKey,
} from "./runtime.ts"
import { type Lookup, validateRemoteUrl } from "./ssrf-protection.ts"

const DEFAULT_API_VERSION = "v2"
const EXTRACT_TIMEOUT_MS = 60_000
const DEFAULT_MAX_REDIRECTS = 5
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const SUPPORTED_API_VERSIONS = ["v1", "v2"] as const
type FirecrawlApiVersion = (typeof SUPPORTED_API_VERSIONS)[number]

export interface FirecrawlSsrfOptions {
  allowRanges: string[]
  trustEnvProxy: boolean
}

export interface FirecrawlExtractOptions
  extends Pick<ExtractOptions, "timeoutMs" | "lookup"> {
  ssrf?: FirecrawlSsrfOptions
}

interface FirecrawlScrapeData {
  title?: unknown
  markdown?: unknown
  metadata?: { title?: unknown }
}

function normalizeBaseUrl(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (!trimmed) return null
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error(
      `Invalid Firecrawl base URL in the WebUI plugins settings: expected an HTTP or HTTPS URL`,
    )
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `Invalid Firecrawl base URL in the WebUI plugins settings: expected an HTTP or HTTPS URL`,
    )
  }
  if (parsed.username || parsed.password) {
    throw new Error(
      `Invalid Firecrawl base URL in the WebUI plugins settings: URL credentials are not allowed`,
    )
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "")
  parsed.search = ""
  parsed.hash = ""
  return parsed.toString().replace(/\/+$/, "")
}

function getBaseUrl(): string | null {
  return normalizeBaseUrl(providerOption("firecrawl", "baseUrl"))
}

function requireBaseUrl(): string {
  const baseUrl = getBaseUrl()
  if (!baseUrl) {
    throw new Error(
      "Firecrawl base URL not configured.\n" +
        "  Set firecrawlBaseUrl in the WebUI plugins settings.",
    )
  }
  return baseUrl
}

function getApiVersion(): FirecrawlApiVersion {
  const raw = providerOption("firecrawl", "apiVersion")
  if (raw === undefined || raw === null) return DEFAULT_API_VERSION
  if (typeof raw !== "string") {
    throw new Error(
      `firecrawlApiVersion in the WebUI plugins settings must be a string ("v1" or "v2")`,
    )
  }
  const normalized = raw.trim().toLowerCase()
  if (!normalized) return DEFAULT_API_VERSION
  if (!SUPPORTED_API_VERSIONS.includes(normalized as FirecrawlApiVersion)) {
    throw new Error(
      `Unsupported Firecrawl API version "${raw}". Supported versions: ${SUPPORTED_API_VERSIONS.join(", ")}`,
    )
  }
  return normalized as FirecrawlApiVersion
}

function allowFreshScrape(): boolean {
  const configured = providerOption("firecrawl", "freshScrape")
  if (configured === undefined || configured === null) return false
  const normalized = configured.trim().toLowerCase()
  return normalized === "true" || normalized === "1"
}

function getApiKey(_signal?: AbortSignal): string | undefined {
  return resolveProviderKey("firecrawl")
}

function requestSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([timeout, signal]) : timeout
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function isAbortError(err: unknown): boolean {
  return errorMessage(err).toLowerCase().includes("abort")
}

function ssrfOptions(options?: FirecrawlExtractOptions): {
  lookup?: Lookup
  allowRanges: string[]
  trustEnvProxy: boolean
} {
  return {
    allowRanges: options?.ssrf?.allowRanges ?? [],
    trustEnvProxy: options?.ssrf?.trustEnvProxy ?? false,
    ...(options?.lookup ? { lookup: options.lookup } : {}),
  }
}

function withoutSensitiveHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const next = { ...headers }
  delete next.Authorization
  delete next.authorization
  delete next.Cookie
  delete next.cookie
  delete next["X-API-Key"]
  delete next["x-api-key"]
  return next
}

async function fetchFirecrawlApi(
  url: string,
  init: {
    method: string
    headers: Record<string, string>
    body: string
    signal: AbortSignal
  },
  options: FirecrawlExtractOptions | undefined,
): Promise<Response> {
  let current = await validateRemoteUrl(url, ssrfOptions(options))
  let headers = init.headers
  for (let redirects = 0; redirects <= DEFAULT_MAX_REDIRECTS; redirects++) {
    const response = await fetch(current, {
      ...init,
      headers,
      redirect: "manual",
    })
    if (!REDIRECT_STATUSES.has(response.status)) return response

    const location = response.headers.get("location")
    if (!location) return response
    if (redirects === DEFAULT_MAX_REDIRECTS)
      throw new Error(`Too many redirects fetching ${current.toString()}`)

    const next = await validateRemoteUrl(
      new URL(location, current),
      ssrfOptions(options),
    )
    if (next.origin !== current.origin)
      headers = withoutSensitiveHeaders(headers)
    current = next
  }
  throw new Error(`Too many redirects fetching ${current.toString()}`)
}

function scrapeBody(url: string): Record<string, unknown> {
  return {
    url,
    formats: ["markdown"],
    onlyMainContent: true,
    ...(allowFreshScrape() ? {} : { lockdown: true }),
  }
}

async function firecrawlFetch(
  endpoint: string,
  body: Record<string, unknown>,
  signal: AbortSignal | undefined,
  options: FirecrawlExtractOptions | undefined,
): Promise<Record<string, unknown>> {
  const baseUrl = requireBaseUrl()
  const version = getApiVersion()
  const apiKey = getApiKey(signal)
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  const requestUrl = `${baseUrl}/${version}/${endpoint}`
  const activityId = activityMonitor.logStart({
    type: "fetch",
    url: requestUrl,
  })
  try {
    const response = await fetchFirecrawlApi(
      requestUrl,
      {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: requestSignal(options?.timeoutMs ?? EXTRACT_TIMEOUT_MS, signal),
      },
      options,
    )
    if (!response.ok) {
      const text = await response.text().catch(() => "")
      throw new Error(
        `Firecrawl scrape error ${response.status}: ${redactCredential(text.slice(0, 300), apiKey)}`,
      )
    }
    let data: unknown
    try {
      data = await response.json()
    } catch (err) {
      throw new Error(
        `Firecrawl scrape returned invalid JSON: ${errorMessage(err)}`,
      )
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error("Firecrawl scrape returned an unexpected response shape")
    }
    const envelope = data as Record<string, unknown>
    if (envelope.success === false) {
      const reason =
        typeof envelope.error === "string" && envelope.error.trim()
          ? envelope.error
          : "unknown error"
      throw new Error(
        `Firecrawl scrape unsuccessful: ${redactCredential(reason, apiKey)}`,
      )
    }
    if (envelope.success !== true) {
      throw new Error("Firecrawl scrape returned an unexpected response shape")
    }
    activityMonitor.logComplete(activityId, response.status)
    return envelope
  } catch (err) {
    if (isAbortError(err)) activityMonitor.logComplete(activityId, 0)
    else activityMonitor.logError(activityId, errorMessage(err))
    throw err
  }
}

export function isFirecrawlAvailable(): boolean {
  return getBaseUrl() !== null && providerKeyConfigured("firecrawl")
}

export async function extractWithFirecrawl(
  url: string,
  signal?: AbortSignal,
  options?: FirecrawlExtractOptions,
): Promise<ExtractedContent | null> {
  requireBaseUrl()
  await validateRemoteUrl(url, ssrfOptions(options))
  const envelope = await firecrawlFetch(
    "scrape",
    scrapeBody(url),
    signal,
    options,
  )
  const data = envelope.data
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Firecrawl scrape returned an unexpected data shape")
  }
  const scrape = data as FirecrawlScrapeData
  if (typeof scrape.markdown !== "string") {
    throw new Error("Firecrawl scrape returned markdown in an unexpected shape")
  }
  const content = scrape.markdown.trim()
  if (!content) return null
  const metadataTitle = scrape.metadata?.title
  const title =
    typeof metadataTitle === "string" && metadataTitle.trim()
      ? metadataTitle.trim()
      : typeof scrape.title === "string"
        ? scrape.title.trim()
        : ""
  return { url, title, content, error: null }
}
