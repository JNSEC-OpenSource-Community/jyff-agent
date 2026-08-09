import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createWebAccessTools, type WebAccessConfig } from "../src/index.ts"

function tools(overrides: Partial<WebAccessConfig> = {}) {
  return createWebAccessTools({
    providers: ["nekozuki"],
    workflow: "none",
    resolveSecret: () => undefined,
    providerConfig: {
      nekozuki: { baseUrl: "http://localhost:8000" },
    },
    ...overrides,
  })
}

function nekozukiTool() {
  const tool = tools().find((t) => t.name === "web_search")
  if (!tool) throw new Error("web_search not found")
  return tool
}

function ragResponse(results: unknown[]) {
  return new Response(JSON.stringify({ results, query: "q", time_ms: 3 }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("nekozuki RAG provider", () => {
  it("web_search 使用 nekozuki baseUrl 发起 RAG 查询", async () => {
    vi.mocked(fetch).mockResolvedValue(
      ragResponse([
        {
          technique_name: "sql_injection",
          section_title: "Blind SQL Injection via Timing",
          content: "Use SLEEP() to time responses.",
          rerank_score: 0.9,
          rank: 1,
        },
      ]),
    )
    const tool = nekozukiTool()
    const result = await tool.execute(
      "call-1",
      { query: "blind sql injection" },
      undefined,
    )
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain("sql_injection")
    expect(text).toContain("SLEEP")
    // 请求必须指向 nekozuki 的 /api/rag/query。
    const [url, init] = vi.mocked(fetch).mock.calls[0] as [
      string,
      RequestInit,
    ]
    expect(url).toContain("localhost:8000/api/rag/query")
    expect(init.method).toBe("POST")
    expect(JSON.parse(String(init.body))).toEqual({
      query: "blind sql injection",
      top_k: 5,
    })
  })

  it("未配置 baseUrl 时使用默认 localhost:8000", async () => {
    vi.mocked(fetch).mockResolvedValue(ragResponse([]))
    const config: WebAccessConfig = {
      providers: ["nekozuki"],
      workflow: "none",
      resolveSecret: () => undefined,
    }
    const app = createWebAccessTools(config)
    const tool = app.find((t) => t.name === "web_search")!
    await tool.execute("call-1", { query: "x" }, undefined)
    const [url] = vi.mocked(fetch).mock.calls[0] as [string]
    expect(url).toContain("localhost:8000/api/rag/query")
  })

  it("请求失败时返回错误结果", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response("index not built", { status: 503 }),
    )
    const tool = nekozukiTool()
    const result = await tool.execute("call-1", { query: "x" }, undefined)
    const details = result.details as { successfulQueries?: number }
    expect(details.successfulQueries).toBe(0)
    const text = (result.content[0] as { text: string }).text
    expect(text).toMatch(/nekozuki/i)
  })
})