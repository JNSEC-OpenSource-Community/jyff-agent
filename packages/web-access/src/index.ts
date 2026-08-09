import { join } from "node:path"
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core"
import {
  type ImageContent,
  StringEnum,
  type TextContent,
} from "@earendil-works/pi-ai/compat"
import { Type } from "typebox"
import { type FindMode, findContent } from "./content-find.ts"
import { type ExtractedContent, fetchAllContent } from "./extract.ts"
import { normalizeFetchContentParams } from "./fetch-params.ts"
import {
  type ResolvedSearchProvider,
  type SearchProvider,
  type SearchProviderSelection,
  search,
} from "./gemini-search.ts"
import { clearCloneCache } from "./github-extract.ts"
import { searchWithNekozuki } from "./nekozuki.ts"
import { answerFromPage } from "./page-query.ts"
import type { SearchOptions, SearchResult } from "./perplexity.ts"
import {
  getRuntime,
  type Lookup,
  type ModelAuthResolver,
  setRuntime,
  type WebAccessRuntime,
  withRuntime,
} from "./runtime.ts"
import {
  buildResearchArtifact,
  getResearchArtifact,
  type ResearchArtifact,
  storeResearchArtifact,
  withClaimAssessment,
} from "./source-check.ts"
import {
  clearResults,
  generateId,
  getResult,
  type QueryResultData,
  type StoredSearchData,
  storeResult,
} from "./storage.ts"
import { generateSummaryDraft, type SummaryMeta } from "./summary-review.ts"

// ---- 公共类型 ----

export type SecretResolver = (provider: string) => string | undefined

export type { ModelAuthResolver }

export const RESOLVED_SEARCH_PROVIDERS: readonly ResolvedSearchProvider[] = [
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
]
export const SEARCH_PROVIDERS: readonly SearchProvider[] = [
  "auto",
  "all",
  ...RESOLVED_SEARCH_PROVIDERS,
]

export type { ResolvedSearchProvider, SearchProvider, SearchProviderSelection }

export interface WebAccessConfig {
  /** 显式 allowlist；不在集合内的 provider 不可用。空集合 = 全部禁用。 */
  providers: string[]
  /** 搜索 workflow：none（默认，无摘要）或 auto-summary（模型生成摘要）。summary-review 视为 none。 */
  workflow?: "none" | "auto-summary"
  /** 命中宿主 SecretStore。 */
  resolveSecret: SecretResolver
  /** provider 的非密钥配置（zone/baseUrl/model 等）。 */
  providerConfig?: Record<string, Record<string, string>>
  /** openai/xai 搜索 + auto-summary 的模型解析器；缺省则这些路径禁用。 */
  modelAuth?: ModelAuthResolver
  /** auto-summary 用模型；workflow==="auto-summary" 时必需。 */
  summaryModel?: { provider: string; id: string }
  /** 宿主 challenge workspace（bind-mount 到容器 /workspace）。缺省则 clone/PDF 禁用。 */
  workspaceHostPath?: string
  ssrf?: { allowRanges?: string[]; trustEnvProxy?: boolean }
  fetchContent?: { allowDomains?: string[]; denyDomains?: string[] }
  /** 自定义 DNS 解析器，用于 SSRF 校验；主要作为测试接缝。 */
  lookup?: Lookup
  timeouts?: { fetchMs?: number; searchMs?: number; cloneMs?: number }
  limits?: { maxContentSliceLength?: number; maxInlineChars?: number }
  /** run 结束时 abort → 清理 fetch / clone 缓存。 */
  sessionSignal?: AbortSignal
}

const DEFAULT_TOOL_NAMES = {
  webSearch: "web_search",
  sourceCheck: "source_check",
  fetchContent: "fetch_content",
  getSearchContent: "get_search_content",
  tricksSearch: "tricks_search",
}

const MAX_INLINE_CONTENT = 30_000
const DEFAULT_CONTENT_SLICE_LENGTH = MAX_INLINE_CONTENT
const MAX_CONTENT_SLICE_LENGTH = MAX_INLINE_CONTENT
const MAX_FETCH_URLS = 20

const storedContentSources = `${DEFAULT_TOOL_NAMES.webSearch}, ${DEFAULT_TOOL_NAMES.sourceCheck}, or ${DEFAULT_TOOL_NAMES.fetchContent}`
const searchQueryDescription = `Get content for this query (${DEFAULT_TOOL_NAMES.webSearch})`

function errorResult(
  message: string,
  details: Record<string, unknown> = {},
): AgentToolResult<Record<string, unknown>> {
  return {
    content: [{ type: "text", text: `Error: ${message}` }],
    details: { error: message, ...details },
  }
}

// ---- runtime 装配 ----

function buildRuntime(config: WebAccessConfig): WebAccessRuntime {
  const workspaceHostPath = config.workspaceHostPath?.trim() || undefined
  return {
    providers: new Set(config.providers),
    resolveSecret: config.resolveSecret,
    providerConfig: config.providerConfig ?? {},
    modelAuth: config.modelAuth,
    summaryModel: config.summaryModel,
    workflow: config.workflow ?? "none",
    ssrf: {
      allowRanges: config.ssrf?.allowRanges ?? [],
      trustEnvProxy: config.ssrf?.trustEnvProxy ?? false,
    },
    fetchContent:
      config.fetchContent?.allowDomains || config.fetchContent?.denyDomains
        ? {
            allowDomains: config.fetchContent.allowDomains,
            denyDomains: config.fetchContent.denyDomains,
          }
        : undefined,
    lookup: config.lookup,
    workspaceHostPath,
    githubClonePath: workspaceHostPath
      ? join(workspaceHostPath, ".web-access", "github")
      : undefined,
    pdfDir: workspaceHostPath
      ? join(workspaceHostPath, ".web-access", "pdf")
      : undefined,
    timeouts: {
      fetchMs: config.timeouts?.fetchMs ?? 30_000,
      searchMs: config.timeouts?.searchMs ?? 30_000,
      cloneMs: config.timeouts?.cloneMs ?? 30_000,
    },
    limits: {
      maxContentSliceLength:
        config.limits?.maxContentSliceLength ?? MAX_CONTENT_SLICE_LENGTH,
      maxInlineChars: config.limits?.maxInlineChars ?? MAX_INLINE_CONTENT,
    },
    sessionSignal: config.sessionSignal,
  }
}

// ---- 搜索辅助 ----

const pendingFetches = new Map<string, AbortController>()

function abortPendingFetches(): void {
  for (const controller of pendingFetches.values()) {
    controller.abort()
  }
  pendingFetches.clear()
}

function normalizeQueryList(queryList: unknown[]): string[] {
  const normalized: string[] = []
  for (const query of queryList) {
    if (typeof query !== "string") continue
    const trimmed = query.trim()
    if (trimmed.length > 0) normalized.push(trimmed)
  }
  return normalized
}

function normalizeRecencyFilter(
  value: unknown,
): SearchOptions["recencyFilter"] | undefined {
  return value === "day" ||
    value === "week" ||
    value === "month" ||
    value === "year"
    ? value
    : undefined
}

function resolveRequestedProvider(requested: unknown): SearchProviderSelection {
  const normalized = normalizeProviderInput(requested)
  if (normalized && normalized !== "auto") return normalized
  return "auto"
}

function normalizeProviderInput(
  value: unknown,
): SearchProviderSelection | undefined {
  if (value === undefined) return undefined
  if (Array.isArray(value)) {
    const list = value.filter(
      (entry): entry is string => typeof entry === "string",
    )
    return list.length > 0 ? (list as ResolvedSearchProvider[]) : undefined
  }
  if (typeof value === "string") {
    const trimmed = value.trim().toLowerCase()
    if (SEARCH_PROVIDERS.includes(trimmed as SearchProvider))
      return trimmed as SearchProvider
  }
  return undefined
}

function resolveWorkflow(input: unknown): "none" | "auto-summary" {
  const normalized = typeof input === "string" ? input.trim().toLowerCase() : ""
  return normalized === "auto-summary" ? "auto-summary" : "none"
}

function searchProviderSchema(description: string) {
  return Type.Union(
    [
      StringEnum([...SEARCH_PROVIDERS]),
      Type.Array(StringEnum([...RESOLVED_SEARCH_PROVIDERS]), { minItems: 1 }),
    ],
    { description },
  )
}

// ---- 输出格式化 ----

function formatSearchSummary(results: SearchResult[], answer: string): string {
  if (results.length === 0) {
    return answer
      ? `${answer}\n\n---\n\n**Sources:**\nNo sources returned.`
      : "No results found."
  }
  let output = answer ? `${answer}\n\n---\n\n**Sources:**\n` : ""
  output += results
    .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}`)
    .join("\n\n")
  return output
}

function formatFullResults(queryData: QueryResultData): string {
  let output = `## Results for: "${queryData.query}"\n\n`
  if (queryData.answer) {
    output += `${queryData.answer}\n\n---\n\n`
  }
  for (const r of queryData.results) {
    output += `### ${r.title}\n${r.url}\n\n`
  }
  return output
}

function formatSourceCheckResult(
  artifact: ResearchArtifact,
  getSearchContentTool = DEFAULT_TOOL_NAMES.getSearchContent,
): string {
  const assessment = artifact.claims?.[0]
  const lines = [`# Source check: ${artifact.query}`, ""]
  if (assessment) {
    lines.push(
      `**Status:** ${assessment.status} (confidence ${assessment.confidence.toFixed(2)})`,
    )
    lines.push(`**Rationale:** ${assessment.rationale}`)
    if (assessment.supporting_passages.length > 0)
      lines.push(
        `**Supporting passages:** ${assessment.supporting_passages.join(", ")}`,
      )
    if (assessment.contradicting_passages.length > 0)
      lines.push(
        `**Contradicting passages:** ${assessment.contradicting_passages.join(", ")}`,
      )
    lines.push("")
  }
  if (artifact.sources.length > 0) {
    lines.push("## Sources")
    for (const source of artifact.sources)
      lines.push(
        `${source.rank}. [${source.quality}] ${source.title}\n   ${source.url}`,
      )
    lines.push("")
  }
  if (artifact.errors?.length)
    lines.push(
      `Search errors: ${artifact.errors.map((entry) => `${entry.query}: ${entry.error}`).join("; ")}`,
    )
  lines.push(
    `Artifact responseId: ${artifact.id} (retrievable via ${getSearchContentTool}).`,
  )
  return lines.join("\n")
}

function stripThumbnails(results: ExtractedContent[]): ExtractedContent[] {
  return results.map(({ thumbnail, frames, ...rest }) => rest)
}

function initialContentSlice(content: string): {
  text: string
  endOffset: number
  totalBytes: number
  totalLines: number
  shownBytes: number
  shownLines: number
} {
  let endOffset = Math.min(content.length, MAX_INLINE_CONTENT)
  if (endOffset < content.length) {
    const lineBreak = content.lastIndexOf("\n", endOffset)
    if (lineBreak >= Math.floor(MAX_INLINE_CONTENT * 0.8))
      endOffset = lineBreak + 1
  }
  const text = content.slice(0, endOffset)
  return {
    text,
    endOffset,
    totalBytes: Buffer.byteLength(content),
    totalLines: content.length === 0 ? 0 : content.split("\n").length,
    shownBytes: Buffer.byteLength(text),
    shownLines: text.length === 0 ? 0 : text.split("\n").length,
  }
}

function normalizeFindQueries(value: string | string[]): string[] {
  const queries = (Array.isArray(value) ? value : [value])
    .map((query) => query.trim())
    .filter(Boolean)
  if (queries.length === 0)
    throw new Error("findText must contain at least one non-empty string")
  return queries
}

function isAbortError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return message.toLowerCase().includes("abort")
}

function startBackgroundFetch(urls: string[]): string | null {
  if (urls.length === 0) return null
  const fetchId = generateId()
  const controller = new AbortController()
  pendingFetches.set(fetchId, controller)
  fetchAllContent(urls, controller.signal)
    .then((fetched) => {
      if (!pendingFetches.has(fetchId)) return
      const data: StoredSearchData = {
        id: fetchId,
        type: "fetch",
        timestamp: Date.now(),
        urls: stripThumbnails(fetched),
      }
      storeResult(fetchId, data)
    })
    .catch(() => {
      // 后台抓取失败不打断主流程；结果不会被 store。
    })
    .finally(() => {
      pendingFetches.delete(fetchId)
    })
  return fetchId
}

function storeAndPublishSearch(results: QueryResultData[]): string {
  const id = generateId()
  const data: StoredSearchData = {
    id,
    type: "search",
    timestamp: Date.now(),
    queries: results,
  }
  storeResult(id, data)
  return id
}

// ---- 工具：web_search ----

const webSearchParams = Type.Object({
  query: Type.Optional(
    Type.String({
      description:
        "Single search query. For research tasks, prefer 'queries' with multiple varied angles instead.",
    }),
  ),
  queries: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Multiple queries searched in sequence, each returning its own synthesized answer.",
    }),
  ),
  numResults: Type.Optional(
    Type.Number({ description: "Results per query (default: 5, max: 20)" }),
  ),
  includeContent: Type.Optional(
    Type.Boolean({ description: "Fetch full page content in the background" }),
  ),
  recencyFilter: Type.Optional(
    StringEnum(["day", "week", "month", "year"], {
      description: "Filter by recency",
    }),
  ),
  domainFilter: Type.Optional(
    Type.Array(Type.String(), {
      description: "Limit to domains (prefix with - to exclude)",
    }),
  ),
  provider: Type.Optional(
    searchProviderSchema(
      "Search provider or non-empty list of providers to search simultaneously; omit to use the configured default",
    ),
  ),
  workflow: Type.Optional(
    StringEnum(["none", "auto-summary"], {
      description:
        "Search workflow: none (default) or auto-summary (model-generated summary)",
    }),
  ),
})

function createWebSearchTool(): AgentTool<typeof webSearchParams> {
  return {
    name: DEFAULT_TOOL_NAMES.webSearch,
    label: "Web Search",
    description: `Search the web for online information and current results. Returns an AI-synthesized answer with source citations. For CTF technique questions, use the dedicated tricks_search tool instead. Omit provider for general web search. Prefer queries (plural) with 2-4 varied angles over a single query for broader coverage. IMPORTANT: Do NOT search for, fetch, or look up writeups or solutions for the current challenge, nor any challenge-specific information (e.g. the challenge's flag, intended solve, or exact challenge title/name). Only search for general techniques, concepts, and background knowledge.`,
    parameters: webSearchParams,
    executionMode: "sequential",
    async execute(
      _toolCallId,
      params,
      signal,
      onUpdate,
    ): Promise<AgentToolResult<Record<string, unknown>>> {
      const rt = getRuntime()
      const rawQueryList: unknown[] = Array.isArray(params.queries)
        ? params.queries
        : params.query !== undefined
          ? [params.query]
          : []
      const queryList = normalizeQueryList(rawQueryList)
      const workflow = resolveWorkflow(params.workflow ?? rt.workflow)
      const recencyFilter = normalizeRecencyFilter(params.recencyFilter)
      const domainFilter = Array.isArray(params.domainFilter)
        ? params.domainFilter.filter(
            (domain): domain is string => typeof domain === "string",
          )
        : undefined
      const provider = resolveRequestedProvider(params.provider)

      if (queryList.length === 0) {
        return errorResult(
          "No query provided. Use 'query' or 'queries' parameter.",
          { code: "no_query" },
        )
      }

      const results: QueryResultData[] = []
      const allUrls: string[] = []
      const allInlineContent: ExtractedContent[] = []
      const fallbackErrors: string[] = []

      for (const [i, query] of queryList.entries()) {
        if (signal?.aborted) break
        onUpdate?.({
          content: [
            {
              type: "text",
              text: `Searching ${i + 1}/${queryList.length}: "${query}"...`,
            },
          ],
          details: {
            phase: "search",
            progress: i / queryList.length,
            currentQuery: query,
          },
        })
        try {
          const response = await search(query, {
            provider,
            numResults:
              typeof params.numResults === "number"
                ? params.numResults
                : undefined,
            recencyFilter,
            domainFilter,
            signal,
            modelAuth: rt.modelAuth,
          })
          if (signal?.aborted) break
          results.push({
            query,
            answer: response.answer,
            results: response.results,
            error: null,
            provider: response.provider,
          })
          for (const r of response.results) {
            if (!allUrls.includes(r.url)) allUrls.push(r.url)
          }
          if (response.inlineContent)
            allInlineContent.push(...response.inlineContent)
        } catch (err) {
          if (signal?.aborted || isAbortError(err)) break
          fallbackErrors.push(
            `"${query}": ${err instanceof Error ? err.message : String(err)}`,
          )
          results.push({
            query,
            answer: "",
            results: [],
            error: err instanceof Error ? err.message : String(err),
            provider: undefined,
          })
        }
      }

      if (signal?.aborted) {
        return errorResult("Aborted", {
          code: "aborted",
          queryCount: queryList.length,
        })
      }

      let approvedSummary: string | undefined
      let summaryMeta: SummaryMeta | undefined
      if (workflow === "auto-summary") {
        if (!rt.modelAuth) {
          return errorResult(
            "Auto-summary requires a configured summary model.",
            { code: "auto_summary_unavailable" },
          )
        }
        onUpdate?.({
          content: [{ type: "text", text: "Generating summary..." }],
          details: { phase: "generating-summary", progress: 1 },
        })
        const generated = await generateSummaryDraft(
          results,
          { modelAuth: rt.modelAuth, summaryModel: rt.summaryModel },
          signal,
        )
        approvedSummary = generated.summary
        summaryMeta = generated.meta
      }

      const sc = results.filter((r) => !r.error).length
      const tr = results.reduce((sum, r) => sum + r.results.length, 0)
      let output = ""
      if (
        typeof approvedSummary === "string" &&
        approvedSummary.trim().length > 0
      ) {
        output = approvedSummary.trim()
      } else {
        for (const { query, answer, results: queryResults, error } of results) {
          if (queryList.length > 1) output += `## Query: "${query}"\n\n`
          if (error) output += `Error: ${error}\n\n`
          else output += `${formatSearchSummary(queryResults, answer)}\n\n`
        }
      }

      const responseId = storeAndPublishSearch(results)
      let fetchId: string | null = null
      if (params.includeContent) {
        fetchId = startBackgroundFetch(allUrls)
        if (fetchId && !approvedSummary) {
          output += `---\nContent fetching in background [${fetchId}]. Use ${DEFAULT_TOOL_NAMES.getSearchContent}({ responseId: "${fetchId}", urlIndex: 0 }) when ready.`
        }
      }

      return {
        content: [{ type: "text", text: output.trim() }],
        details: {
          queries: queryList,
          queryCount: queryList.length,
          successfulQueries: sc,
          totalResults: tr,
          includeContent: params.includeContent ?? false,
          fetchId,
          fetchUrls: fetchId ? allUrls : undefined,
          searchId: responseId,
          ...(workflow === "auto-summary" && approvedSummary
            ? {
                summary: {
                  text: approvedSummary.trim(),
                  workflow,
                  model: summaryMeta?.model ?? null,
                  durationMs: summaryMeta?.durationMs ?? 0,
                  tokenEstimate: summaryMeta?.tokenEstimate ?? 0,
                  fallbackUsed: summaryMeta?.fallbackUsed === true,
                  fallbackReason: summaryMeta?.fallbackReason,
                },
              }
            : {}),
        },
      }
    },
  }
}

// ---- 工具：source_check ----

const sourceCheckParams = Type.Object({
  claim: Type.String({
    description: "The assertion to check against web sources.",
  }),
  queries: Type.Optional(
    Type.Array(Type.String(), {
      description: "Search queries (default: the claim).",
    }),
  ),
  numResults: Type.Optional(
    Type.Number({ description: "Results per query (default: 5, max: 20)." }),
  ),
  fetchContent: Type.Optional(
    Type.Boolean({
      description: "Fetch up to 5 result pages for exact passage extraction.",
    }),
  ),
  recencyFilter: Type.Optional(
    StringEnum(["day", "week", "month", "year"], {
      description: "Filter by recency.",
    }),
  ),
  domainFilter: Type.Optional(
    Type.Array(Type.String(), {
      description: "Limit to domains; prefix with - to exclude.",
    }),
  ),
  provider: Type.Optional(
    searchProviderSchema(
      "Search provider or non-empty list of providers to search simultaneously",
    ),
  ),
})

function createSourceCheckTool(): AgentTool<typeof sourceCheckParams> {
  return {
    name: DEFAULT_TOOL_NAMES.sourceCheck,
    label: "Source Check",
    description:
      "Check a claim against web sources and return a bounded machine-readable research artifact with exact passage citations.",
    parameters: sourceCheckParams,
    executionMode: "sequential",
    async execute(
      _toolCallId,
      params,
      signal,
    ): Promise<AgentToolResult<Record<string, unknown>>> {
      const rt = getRuntime()
      const claim = typeof params.claim === "string" ? params.claim.trim() : ""
      if (!claim)
        return errorResult("'claim' is required.", { code: "missing_claim" })

      const requestedQueries = Array.isArray(params.queries)
        ? params.queries
            .filter((query): query is string => typeof query === "string")
            .map((query) => query.trim())
            .filter(Boolean)
        : []
      const queries = (
        requestedQueries.length > 0 ? requestedQueries : [claim]
      ).slice(0, 8)
      const numResults =
        typeof params.numResults === "number" &&
        Number.isFinite(params.numResults)
          ? Math.min(20, Math.max(1, Math.floor(params.numResults)))
          : 5
      const domainFilter = Array.isArray(params.domainFilter)
        ? params.domainFilter.filter(
            (domain): domain is string => typeof domain === "string",
          )
        : undefined
      const recencyFilter = normalizeRecencyFilter(params.recencyFilter)
      const resultsByUrl = new Map<string, SearchResult>()
      const summaries: string[] = []
      const errors: Array<{ query: string; error: string }> = []
      let provider: string | undefined

      for (const query of queries) {
        if (signal?.aborted) break
        try {
          const response = await search(query, {
            provider: resolveRequestedProvider(params.provider),
            numResults,
            recencyFilter,
            domainFilter,
            signal,
            modelAuth: rt.modelAuth,
          })
          if (signal?.aborted) break
          provider ??= response.provider
          if (response.answer) summaries.push(`${query}: ${response.answer}`)
          for (const result of response.results) {
            if (!resultsByUrl.has(result.url))
              resultsByUrl.set(result.url, result)
          }
        } catch (err) {
          if (signal?.aborted || isAbortError(err)) break
          errors.push({
            query,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }

      const results = [...resultsByUrl.values()]
        .slice(0, 20)
        .map((entry, index) => ({ ...entry, rank: index + 1 }))
      let fetched: ExtractedContent[] = []
      if (params.fetchContent && results.length > 0) {
        const urls = results.slice(0, 5).map((entry) => entry.url)
        try {
          fetched = await fetchAllContent(urls, signal, {
            ...(rt.lookup ? { lookup: rt.lookup } : {}),
          })
        } catch (err) {
          if (signal?.aborted || isAbortError(err)) throw err
          fetched = urls.map((url) => ({
            url,
            title: "",
            content: "",
            error: err instanceof Error ? err.message : String(err),
          }))
        }
      }
      const artifact = withClaimAssessment(
        buildResearchArtifact({
          query: claim,
          provider,
          summary: summaries.length > 0 ? summaries.join("\n\n") : undefined,
          results,
          fetched,
          recency: recencyFilter,
          domainFilter,
        }),
        [claim],
      )
      if (errors.length > 0) artifact.errors = errors
      storeResearchArtifact(artifact)

      return {
        content: [{ type: "text", text: formatSourceCheckResult(artifact) }],
        details: {
          responseId: artifact.id,
          artifact,
          sourceCount: artifact.sources.length,
          passageCount: artifact.passages.length,
        },
      }
    },
  }
}

// ---- 工具：fetch_content ----

const fetchContentParams = Type.Object({
  url: Type.Optional(Type.String({ description: "Single URL to fetch" })),
  urls: Type.Optional(
    Type.Array(Type.String(), { description: "Multiple URLs (parallel)" }),
  ),
  forceClone: Type.Optional(
    Type.Boolean({
      description:
        "Force cloning large GitHub repositories that exceed the size threshold",
    }),
  ),
  prompt: Type.Optional(
    Type.String({
      description:
        "Question or instruction for video analysis, or the page-local question required by mode answer.",
    }),
  ),
  mode: Type.Optional(
    StringEnum(["readable", "raw", "answer"], {
      description:
        "Fetch mode: readable (default extraction), raw (exact textual HTTP body), or answer (answer prompt using only fetched content).",
    }),
  ),
  answerModel: Type.Optional(
    Type.String({
      description: "Optional provider/model-id override for mode answer.",
    }),
  ),
  timestamp: Type.Optional(
    Type.String({
      description: "Extract video frame(s) at a timestamp or time range.",
    }),
  ),
  frames: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 12,
      description: "Number of frames to extract.",
    }),
  ),
  model: Type.Optional(
    Type.String({
      description: "Override the Gemini model for video/YouTube analysis.",
    }),
  ),
})

function createFetchContentTool(): AgentTool<typeof fetchContentParams> {
  return {
    name: DEFAULT_TOOL_NAMES.fetchContent,
    label: "Fetch Content",
    description: `Fetch URL(s) and extract readable content as markdown. Use mode "raw" for exact textual HTTP response bodies or mode "answer" with prompt to answer using only fetched content. Direct image URLs return resized image content. Supports YouTube transcripts, GitHub repositories, PDFs, and local videos. Full original content is stored for retrieval with ${DEFAULT_TOOL_NAMES.getSearchContent}.`,
    parameters: fetchContentParams,
    executionMode: "sequential",
    async execute(
      _toolCallId,
      params,
      signal,
      onUpdate,
    ): Promise<AgentToolResult<Record<string, unknown>>> {
      const rt = getRuntime()
      let normalized: ReturnType<typeof normalizeFetchContentParams>
      try {
        normalized = normalizeFetchContentParams(params)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return errorResult(message, { code: "invalid_params" })
      }
      const { urlList, options } = normalized
      const mode = options.mode ?? "readable"
      if (mode === "answer" && !options.prompt) {
        return errorResult("mode answer requires prompt.", {
          code: "answer_requires_prompt",
        })
      }
      if (
        mode === "raw" &&
        (options.forceClone === true ||
          options.timestamp ||
          options.frames ||
          options.prompt ||
          options.model ||
          options.answerModel)
      ) {
        return errorResult(
          "mode raw cannot be combined with forceClone, prompt, timestamp, frames, model, or answerModel.",
          { code: "incompatible_raw_options" },
        )
      }
      if (mode !== "answer" && options.answerModel) {
        return errorResult("answerModel requires mode answer.", {
          code: "answer_model_requires_answer",
        })
      }
      if (mode === "answer" && options.model) {
        return errorResult("use answerModel, not model, with mode answer.", {
          code: "model_incompatible_with_answer",
        })
      }
      if (urlList.length === 0) {
        return errorResult("No URL provided.", { code: "no_url" })
      }
      if (urlList.length > MAX_FETCH_URLS) {
        return errorResult(
          `Too many URLs: ${urlList.length} (max ${MAX_FETCH_URLS}).`,
          { code: "too_many_urls" },
        )
      }

      onUpdate?.({
        content: [
          { type: "text", text: `Fetching ${urlList.length} URL(s)...` },
        ],
        details: { phase: "fetch", progress: 0 },
      })

      const fetchOptions: typeof options =
        mode === "answer"
          ? (() => {
              const { prompt: _prompt, ...rest } = options
              return rest
            })()
          : options
      const fetchResults = await fetchAllContent(urlList, signal, {
        ...fetchOptions,
        ...(rt.lookup ? { lookup: rt.lookup } : {}),
      })
      const presentedResults =
        mode === "answer"
          ? await Promise.all(
              fetchResults.map(async (fetchResult) => {
                if (fetchResult.error) return fetchResult
                if (
                  fetchResult.thumbnail ||
                  fetchResult.mimeType?.startsWith("image/")
                ) {
                  return {
                    ...fetchResult,
                    error: "Page answer requires textual fetched content",
                  }
                }
                if (!rt.modelAuth) {
                  return {
                    ...fetchResult,
                    error: "Page answer requires a configured model.",
                  }
                }
                try {
                  const answer = await answerFromPage(
                    {
                      question: options.prompt!,
                      pageText: fetchResult.content,
                      sourceUrl: fetchResult.url,
                      ...(options.answerModel
                        ? { model: options.answerModel }
                        : {}),
                    },
                    { modelAuth: rt.modelAuth },
                    signal,
                  )
                  return { ...fetchResult, content: answer.text }
                } catch (err) {
                  return {
                    ...fetchResult,
                    error: `Page answer failed: ${err instanceof Error ? err.message : String(err)}`,
                  }
                }
              }),
            )
          : fetchResults
      const successful = presentedResults.filter((entry) => !entry.error).length
      const totalChars = presentedResults.reduce(
        (sum, entry) => sum + entry.content.length,
        0,
      )

      // ALWAYS store results (even for single URL)
      const responseId = generateId()
      const data: StoredSearchData = {
        id: responseId,
        type: "fetch",
        timestamp: Date.now(),
        urls: stripThumbnails(fetchResults),
      }
      storeResult(responseId, data)

      // Single URL: return content directly (possibly truncated) with responseId
      if (urlList.length === 1) {
        const fetchResult = presentedResults[0]!
        if (fetchResult.error) {
          return errorResult(fetchResult.error, {
            urls: urlList,
            urlCount: 1,
            successful: 0,
            responseId,
          })
        }

        const fullLength = fetchResult.content.length
        const slice = initialContentSlice(fetchResult.content)
        const truncated = slice.endOffset < fullLength
        let output = slice.text

        if (truncated) {
          output +=
            `\n\n---\nShowing ${slice.endOffset} of ${fullLength} chars. ` +
            `Use ${DEFAULT_TOOL_NAMES.getSearchContent}({ responseId: "${responseId}", urlIndex: 0, offset: ${slice.endOffset} }) for the next slice.`
        }

        const content: Array<TextContent | ImageContent> = []
        if (fetchResult.frames?.length) {
          for (const frame of fetchResult.frames) {
            content.push({
              type: "image",
              data: frame.data,
              mimeType: frame.mimeType,
            })
            content.push({ type: "text", text: `Frame at ${frame.timestamp}` })
          }
        } else if (fetchResult.thumbnail) {
          content.push({
            type: "image",
            data: fetchResult.thumbnail.data,
            mimeType: fetchResult.thumbnail.mimeType,
          })
        }
        content.push({ type: "text", text: output })

        const imageCount =
          (fetchResult.frames?.length ?? 0) + (fetchResult.thumbnail ? 1 : 0)
        return {
          content,
          details: {
            urls: urlList,
            urlCount: 1,
            successful: 1,
            totalChars: fullLength,
            title: fetchResult.title,
            responseId,
            truncated,
            hasImage: imageCount > 0,
            imageCount,
            prompt: params.prompt,
            timestamp: params.timestamp,
            frames: params.frames,
            duration: fetchResult.duration,
            mode,
            mimeType: fetchResult.mimeType,
            status: fetchResult.status,
            totalBytes: slice.totalBytes,
            totalLines: slice.totalLines,
          },
        }
      }

      // Multi-URL: summary + responseId
      let output = "## Fetched URLs\n\n"
      for (const { url, title, content, error } of presentedResults) {
        if (error) {
          output += `- ${url}: Error - ${error}\n`
        } else {
          output += `- ${title || url} (${content.length} chars)\n`
        }
      }
      output += `\n---\nUse ${DEFAULT_TOOL_NAMES.getSearchContent}({ responseId: "${responseId}", urlIndex: 0 }) to retrieve bounded content slices.`

      return {
        content: [{ type: "text", text: output }],
        details: {
          urls: urlList,
          urlCount: urlList.length,
          successful,
          totalChars,
          responseId,
        },
      }
    },
  }
}

// ---- 工具：get_search_content ----

const getSearchContentParams = Type.Object({
  responseId: Type.String({
    description: `The responseId from ${storedContentSources}`,
  }),
  query: Type.Optional(Type.String({ description: searchQueryDescription })),
  queryIndex: Type.Optional(
    Type.Number({ description: "Get content for query at index" }),
  ),
  url: Type.Optional(Type.String({ description: "Get content for this URL" })),
  urlIndex: Type.Optional(
    Type.Number({ description: "Get content for URL at index" }),
  ),
  offset: Type.Optional(
    Type.Number({
      description:
        "Character offset for fetched URL content slices (default 0)",
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      description: `Maximum characters to return for fetched URL content slices (default/max ${MAX_CONTENT_SLICE_LENGTH})`,
    }),
  ),
  findText: Type.Optional(
    Type.Union(
      [
        Type.String({ minLength: 1, maxLength: 500 }),
        Type.Array(Type.String({ minLength: 1, maxLength: 500 }), {
          minItems: 1,
          maxItems: 10,
        }),
      ],
      { description: "Text or texts to find in the selected stored content." },
    ),
  ),
  findMode: Type.Optional(
    StringEnum(["exact", "case-insensitive", "fuzzy"], {
      description: "Matching mode for findText (default: case-insensitive).",
    }),
  ),
})

function createGetSearchContentTool(): AgentTool<
  typeof getSearchContentParams
> {
  return {
    name: DEFAULT_TOOL_NAMES.getSearchContent,
    label: "Get Search Content",
    description: `Retrieve bounded content slices or find matching passages in a previous ${storedContentSources} call.`,
    parameters: getSearchContentParams,
    executionMode: "sequential",
    async execute(
      _toolCallId,
      params,
    ): Promise<AgentToolResult<Record<string, unknown>>> {
      if (
        params.findText !== undefined &&
        (params.offset !== undefined || params.limit !== undefined)
      ) {
        return errorResult("findText cannot be combined with offset or limit", {
          code: "incompatible_find_options",
        })
      }
      if (params.findMode !== undefined && params.findText === undefined) {
        return errorResult("findMode requires findText", {
          code: "find_mode_requires_find_text",
        })
      }
      const data = getResult(params.responseId)
      if (!data) {
        return errorResult(`No stored results for "${params.responseId}"`, {
          code: "not_found",
          responseId: params.responseId,
        })
      }

      if (data.type === "research") {
        const artifact = getResearchArtifact(params.responseId)
        if (!artifact) {
          return errorResult(`artifact ${params.responseId} not found`, {
            code: "artifact_not_found",
            responseId: params.responseId,
          })
        }
        const serialized = JSON.stringify(artifact, null, 2)
        const offset = params.offset ?? 0
        const limit = params.limit ?? MAX_CONTENT_SLICE_LENGTH
        if (!Number.isInteger(offset) || offset < 0) {
          return errorResult("offset must be a non-negative integer", {
            code: "invalid_offset",
            offset,
          })
        }
        if (
          !Number.isInteger(limit) ||
          limit <= 0 ||
          limit > MAX_CONTENT_SLICE_LENGTH
        ) {
          return errorResult(
            `limit must be an integer from 1 to ${MAX_CONTENT_SLICE_LENGTH}`,
            {
              code: "invalid_limit",
              limit,
              maxLimit: MAX_CONTENT_SLICE_LENGTH,
            },
          )
        }
        if (offset > serialized.length) {
          return errorResult(
            `offset ${offset} is out of range (0-${serialized.length})`,
            {
              code: "offset_out_of_range",
              offset,
              contentLength: serialized.length,
            },
          )
        }
        const endOffset = Math.min(offset + limit, serialized.length)
        const artifactSlice = serialized.slice(offset, endOffset)
        const hasMore = endOffset < serialized.length
        return {
          content: [{ type: "text", text: artifactSlice }],
          details: {
            responseId: artifact.id,
            type: "research",
            contentLength: serialized.length,
            offset,
            limit,
            returnedChars: artifactSlice.length,
            nextOffset: hasMore ? endOffset : null,
            truncated: hasMore,
          },
        }
      }

      if (data.type === "search" && data.queries) {
        let queryData: QueryResultData | undefined

        if (params.query !== undefined) {
          queryData = data.queries.find((q) => q.query === params.query)
          if (!queryData) {
            const available = data.queries.map((q) => `"${q.query}"`).join(", ")
            return errorResult(
              `Query "${params.query}" not found. Available: ${available}`,
              { code: "query_not_found" },
            )
          }
        } else if (params.queryIndex !== undefined) {
          queryData = data.queries[params.queryIndex]
          if (!queryData) {
            return errorResult(
              `Index ${params.queryIndex} out of range (0-${data.queries.length - 1})`,
              { code: "index_out_of_range" },
            )
          }
        } else {
          const available = data.queries
            .map((q, i) => `${i}: "${q.query}"`)
            .join(", ")
          return errorResult(
            `Specify query or queryIndex. Available: ${available}`,
            { code: "no_query_specified" },
          )
        }

        if (queryData.error) {
          return errorResult(
            `Error for "${queryData.query}": ${queryData.error}`,
            { code: "query_error", query: queryData.query },
          )
        }

        const fullResults = formatFullResults(queryData)
        if (params.findText !== undefined) {
          try {
            const found = findContent(
              fullResults,
              normalizeFindQueries(params.findText),
              (params.findMode ?? "case-insensitive") as FindMode,
            )
            const { text, ...findDetails } = found
            return {
              content: [{ type: "text", text }],
              details: {
                query: queryData.query,
                resultCount: queryData.results.length,
                findMode: params.findMode ?? "case-insensitive",
                ...findDetails,
              },
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            return errorResult(message, {
              code: "find_error",
              query: queryData.query,
            })
          }
        }

        return {
          content: [{ type: "text", text: fullResults }],
          details: {
            query: queryData.query,
            resultCount: queryData.results.length,
          },
        }
      }

      if (data.type === "fetch" && data.urls) {
        let urlData: ExtractedContent | undefined
        let selectedUrlIndex = -1

        if (params.url !== undefined) {
          selectedUrlIndex = data.urls.findIndex((u) => u.url === params.url)
          urlData = data.urls[selectedUrlIndex]
          if (!urlData) {
            const available = data.urls.map((u) => u.url).join("\n  ")
            return errorResult(`URL not found. Available:\n  ${available}`, {
              code: "url_not_found",
            })
          }
        } else if (params.urlIndex !== undefined) {
          selectedUrlIndex = params.urlIndex
          urlData = data.urls[selectedUrlIndex]
          if (!urlData) {
            return errorResult(
              `Index ${params.urlIndex} out of range (0-${data.urls.length - 1})`,
              { code: "index_out_of_range" },
            )
          }
        } else {
          const available = data.urls
            .map((u, i) => `${i}: ${u.url}`)
            .join("\n  ")
          return errorResult(
            `Specify url or urlIndex. Available:\n  ${available}`,
            { code: "no_url_specified" },
          )
        }

        if (urlData.error) {
          return errorResult(`Error for ${urlData.url}: ${urlData.error}`, {
            code: "url_error",
            url: urlData.url,
          })
        }

        if (params.findText !== undefined) {
          try {
            const found = findContent(
              urlData.content,
              normalizeFindQueries(params.findText),
              (params.findMode ?? "case-insensitive") as FindMode,
            )
            const { text, ...findDetails } = found
            return {
              content: [
                {
                  type: "text",
                  text: `# ${urlData.title || urlData.url}\n\n${text}`,
                },
              ],
              details: {
                url: urlData.url,
                title: urlData.title,
                contentLength: urlData.content.length,
                findMode: params.findMode ?? "case-insensitive",
                ...findDetails,
              },
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            return errorResult(message, {
              code: "find_error",
              url: urlData.url,
            })
          }
        }

        const offset = params.offset ?? 0
        const limit = params.limit ?? DEFAULT_CONTENT_SLICE_LENGTH
        if (!Number.isInteger(offset) || offset < 0) {
          return errorResult("offset must be a non-negative integer", {
            code: "invalid_offset",
            offset,
          })
        }
        if (
          !Number.isInteger(limit) ||
          limit <= 0 ||
          limit > MAX_CONTENT_SLICE_LENGTH
        ) {
          return errorResult(
            `limit must be an integer from 1 to ${MAX_CONTENT_SLICE_LENGTH}`,
            {
              code: "invalid_limit",
              limit,
              maxLimit: MAX_CONTENT_SLICE_LENGTH,
            },
          )
        }
        if (offset > urlData.content.length) {
          return errorResult(
            `offset ${offset} is out of range (0-${urlData.content.length})`,
            {
              code: "offset_out_of_range",
              offset,
              contentLength: urlData.content.length,
            },
          )
        }

        const endOffset = Math.min(offset + limit, urlData.content.length)
        const contentSlice = urlData.content.slice(offset, endOffset)
        const hasMore = endOffset < urlData.content.length
        let text = `# ${urlData.title || urlData.url}\n\n${contentSlice}`
        if (hasMore || offset > 0) {
          text += `\n\n---\nShowing chars ${offset}-${endOffset} of ${urlData.content.length}.`
          if (hasMore) {
            text += ` Use ${DEFAULT_TOOL_NAMES.getSearchContent}({ responseId: "${params.responseId}", urlIndex: ${selectedUrlIndex}, offset: ${endOffset}, limit: ${limit} }) for the next slice.`
          }
        }

        return {
          content: [{ type: "text", text }],
          details: {
            url: urlData.url,
            title: urlData.title,
            contentLength: urlData.content.length,
            offset,
            limit,
            returnedChars: contentSlice.length,
            nextOffset: hasMore ? endOffset : null,
            truncated: hasMore,
          },
        }
      }

      return errorResult("Invalid stored data format", { code: "invalid_data" })
    },
  }
}

// ---- 入口 ----

/**
 * 创建 web-access 纯 Agent 工具库（web_search / source_check / fetch_content / get_search_content）。
 *
 * 工具在宿主进程内用 Node fetch 执行，受 SSRF 守卫约束；GitHub clone / PDF 等本地路径
 * 能力仅在提供 sandbox 可见的 `workspaceHostPath` 时可用，否则返回明确的禁用错误。
 */
/** 把工具 execute 绑定到指定 runtime 上下文，保证多 Project/run 并发时隔离。 */
function bindRuntime<T extends AgentTool>(
  runtime: WebAccessRuntime,
  tool: T,
): T {
  const execute = tool.execute
  return {
    ...tool,
    execute: ((toolCallId, params, signal, onUpdate) =>
      withRuntime(runtime, () =>
        execute(toolCallId, params, signal, onUpdate),
      )) as T["execute"],
  }
}

// ---- 工具：tricks_search ----

const tricksSearchParams = Type.Object({
  query: Type.String({
    description:
      "Natural language query for CTF tricks/techniques. Be specific about the vulnerability class, exploit technique, or attack vector you need information on.",
  }),
  numResults: Type.Optional(
    Type.Number({
      description: "Number of results (default: 5, max: 20)",
    }),
  ),
})

function createTricksSearchTool(): AgentTool<typeof tricksSearchParams> {
  return {
    name: DEFAULT_TOOL_NAMES.tricksSearch,
    label: "CTF Tricks Search",
    description:
      "Search CTF tricks and techniques from the distilled nekozuki knowledge base (39k writeups). Use this when you are stuck on a challenge and need technique ideas, or to look up specific CTF techniques (exploits, vulnerabilities, payload patterns, attack vectors). Returns technique descriptions with source citations. Be specific in your query about the vulnerability class or technique you need. Does NOT search the web — only searches the local CTF knowledge base.",
    parameters: tricksSearchParams,
    executionMode: "sequential",
    async execute(
      _toolCallId,
      params,
      signal,
    ): Promise<AgentToolResult<Record<string, unknown>>> {
      const query = typeof params.query === "string" ? params.query.trim() : ""
      if (!query) {
        return errorResult("No query provided.", { code: "no_query" })
      }
      const rt = getRuntime()
      if (!rt.providers.has("nekozuki")) {
        return errorResult(
          "Nekozuki CTF knowledge base is not enabled. Add it to the provider allowlist in the WebUI plugins settings, and configure the server base URL.",
          { code: "nekozuki_disabled" },
        )
      }
      const numResults =
        typeof params.numResults === "number" &&
        Number.isFinite(params.numResults)
          ? Math.min(20, Math.max(1, Math.floor(params.numResults)))
          : 5

      try {
        const response = await searchWithNekozuki(query, {
          numResults,
          signal,
        })
        const output = response.results
          .map(
            (r, i) =>
              `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet?.slice(0, 300)}`,
          )
          .join("\n\n")
        return {
          content: [{ type: "text", text: output || "No results found." }],
          details: {
            query,
            resultCount: response.results.length,
            answer: response.answer,
          },
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return errorResult(message, { code: "search_failed", query })
      }
    },
  }
}

export function createWebAccessTools(config: WebAccessConfig): AgentTool[] {
  const runtime = buildRuntime(config)
  setRuntime(runtime)

  // run 结束（sessionSignal abort）时清理进程内缓存与进行中的抓取。
  config.sessionSignal?.addEventListener(
    "abort",
    () => {
      clearResults()
      clearCloneCache()
      abortPendingFetches()
    },
    { once: true },
  )

  return [
    bindRuntime(runtime, createWebSearchTool()),
    bindRuntime(runtime, createSourceCheckTool()),
    bindRuntime(runtime, createFetchContentTool()),
    bindRuntime(runtime, createGetSearchContentTool()),
    bindRuntime(runtime, createTricksSearchTool()),
  ]
}
