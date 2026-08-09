import { activityMonitor } from "./activity.ts"
import type {
  SearchOptions,
  SearchResponse,
  SearchResult,
} from "./perplexity.ts"
import { providerOption } from "./runtime.ts"

const DEFAULT_NEKOZUKI_URL = "http://localhost:8000"
const SEARCH_TIMEOUT_MS = 30_000

function getBaseUrl(): string {
  return providerOption("nekozuki", "baseUrl") || DEFAULT_NEKOZUKI_URL
}

function normalizeCount(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 5
  return Math.max(1, Math.min(Math.floor(value), 20))
}

export function isNekozukiAvailable(): boolean {
  return !!getBaseUrl()
}

export async function searchWithNekozuki(
  query: string,
  options: SearchOptions = {},
): Promise<SearchResponse> {
  const baseUrl = getBaseUrl()
  const numResults = normalizeCount(options.numResults)
  const activityId = activityMonitor.logStart({ type: "api", query })

  try {
    const response = await fetch(
      `${baseUrl.replace(/\/+$/, "")}/api/rag/query`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, top_k: numResults }),
        signal: options.signal
          ? AbortSignal.any([
              AbortSignal.timeout(SEARCH_TIMEOUT_MS),
              options.signal,
            ])
          : AbortSignal.timeout(SEARCH_TIMEOUT_MS),
      },
    )

    if (!response.ok) {
      activityMonitor.logError(activityId, `HTTP ${response.status}`)
      const errorText = await response.text()
      throw new Error(
        `nekozuki RAG error ${response.status}: ${errorText.slice(0, 300)}`,
      )
    }

    const data = (await response.json()) as {
      results?: Array<{
        technique_name?: string
        section_title?: string
        content?: string
        rerank_score?: number
        rank?: number
      }>
      query?: string
    }
    activityMonitor.logComplete(activityId, response.status)

    const results: SearchResult[] = []
    for (const item of data.results ?? []) {
      const title = item.technique_name || ""
      const sectionTitle = item.section_title || ""
      results.push({
        title: sectionTitle ? `${title} — ${sectionTitle}` : title,
        url: `nekozuki://${title}`,
        snippet: item.content?.slice(0, 500) || "",
      })
      if (results.length >= numResults) break
    }

    const answer = results
      .map((r) => `${r.snippet}\nSource: ${r.title} (${r.url})`)
      .join("\n\n")

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
