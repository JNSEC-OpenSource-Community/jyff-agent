import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createWebAccessTools, type WebAccessConfig } from "../src/index.ts"
import { getResult } from "../src/storage.ts"

/** 构造 web-access 工具库，默认只启用 brave（密钥经 resolveSecret 注入）。 */
function tools(overrides: Partial<WebAccessConfig> = {}) {
  return createWebAccessTools({
    providers: ["brave"],
    workflow: "none",
    resolveSecret: (provider) =>
      provider === "brave" ? "test-brave-key" : undefined,
    ...overrides,
  })
}

/** 返回一个伪造的 Brave API 响应。 */
function braveResponse(results: unknown[]) {
  return new Response(JSON.stringify({ web: { results } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

function findTool(name: string) {
  const found = tools().find((tool) => tool.name === name)
  if (!found) throw new Error(`tool ${name} not found`)
  return found
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("createWebAccessTools", () => {
  it("只保留五个候选工具", () => {
    const names = tools().map((tool) => tool.name)
    expect(names).toEqual([
      "web_search",
      "source_check",
      "fetch_content",
      "get_search_content",
      "tricks_search",
    ])
  })

  it("web_search 使用 allowlist 内的 provider（brave），不读 process.env", async () => {
    // 即使设置了 env 也不应被使用（密钥只走 resolveSecret）。
    process.env.BRAVE_API_KEY = "env-leak-key"
    vi.mocked(fetch).mockResolvedValue(
      braveResponse([
        {
          title: "Example",
          url: "https://example.com",
          description: "An example site",
        },
      ]),
    )
    const tool = findTool("web_search")
    const result = await tool.execute(
      "call-1",
      { query: "hello world" },
      undefined,
    )
    expect(result.content[0]).toMatchObject({ type: "text" })
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain("example.com")
    // 请求头必须携带 resolveSecret 提供的密钥，而非 env。
    const [, init] = vi.mocked(fetch).mock.calls[0] as [
      unknown,
      { headers?: Record<string, string> },
    ]
    expect(init.headers?.["X-Subscription-Token"]).toBe("test-brave-key")
    expect(init.headers?.["X-Subscription-Token"]).not.toBe("env-leak-key")
    delete process.env.BRAVE_API_KEY
  })

  it("provider 不在 allowlist 内时不可用（auto 回退返回错误而非使用该 provider）", async () => {
    // allowlist 只有 tavily（无密钥），brave 有密钥但不在 allowlist。
    const config: WebAccessConfig = {
      providers: ["tavily"],
      workflow: "none",
      resolveSecret: (provider) =>
        provider === "brave" ? "test-brave-key" : undefined,
    }
    const app = createWebAccessTools(config)
    const tool = app.find((t) => t.name === "web_search")
    if (!tool) throw new Error("web_search not found")
    const result = await tool.execute("call-1", { query: "x" }, undefined)
    const details = result.details as {
      successfulQueries?: number
      totalResults?: number
    }
    // brave 不在 allowlist，tavily 无密钥 → 无可用 provider。
    expect(details.successfulQueries).toBe(0)
    expect(details.totalResults).toBe(0)
    const text = (result.content[0] as { text: string }).text
    expect(text).toMatch(/No search provider available/i)
  })

  it("web_search 响应 signal.aborted 时取消（不再继续搜索）", async () => {
    const controller = new AbortController()
    const tool = findTool("web_search")
    // 首次 fetch 立即 abort。
    vi.mocked(fetch).mockImplementation((_input, _init) => {
      controller.abort()
      return Promise.reject(
        Object.assign(new Error("Aborted"), { name: "AbortError" }),
      )
    })
    const result = await tool.execute(
      "call-1",
      { query: "x" },
      controller.signal,
    )
    // 中止后返回错误结果而不是成功响应。
    const details = result.details as { code?: string }
    expect(details.code).toBe("aborted")
  })

  it("web_search 存储结果可由 get_search_content 按 responseId 读取", async () => {
    vi.mocked(fetch).mockResolvedValue(
      braveResponse([
        { title: "T", url: "https://t.example", description: "d" },
      ]),
    )
    const webSearch = findTool("web_search")
    const result = await webSearch.execute("call-1", { query: "q" }, undefined)
    const responseId = (result.details as { searchId?: string }).searchId
    expect(responseId).toBeTruthy()
    if (!responseId) throw new Error("expected searchId")
    expect(getResult(responseId)).toBeTruthy()

    const getContent = findTool("get_search_content")
    const slice = await getContent.execute("call-2", {
      responseId,
      query: "q",
    })
    expect((slice.content[0] as { text: string }).text).toContain("t.example")
  })
})
