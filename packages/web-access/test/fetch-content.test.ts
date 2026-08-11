import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test"
import { createWebAccessTools, type WebAccessConfig } from "../src/index.ts"

function tools(overrides: Partial<WebAccessConfig> = {}) {
  return createWebAccessTools({
    providers: ["brave"],
    resolveSecret: (provider) => (provider === "brave" ? "test-brave-key" : undefined),
    ...overrides,
  })
}

function fetchTool(config: Partial<WebAccessConfig> = {}) {
  const tool = tools(config).find((t) => t.name === "fetch_content")
  if (!tool) throw new Error("fetch_content not found")
  return tool
}

/** 把所有 hostname 解析到公网 IP，避免测试环境 DNS 指向私网。 */
function publicLookup() {
  return async (_hostname: string) => [{ address: "93.184.216.34", family: 4 }]
}

/** 足够长的 HTML，使 readability 抽取通过（MIN_USEFUL_CONTENT=500）。 */
function htmlPage(title: string) {
  const body = `<h1>${title}</h1>` + `<p>${"content ".repeat(120)}</p>`
  return `<html><head><title>${title}</title></head><body>${body}</body></html>`
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("fetch_content SSRF 防护", () => {
  it("阻止私网地址 169.254.169.254", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("<html>leaked</html>", { status: 200 }))
    const tool = fetchTool()
    const result = await tool.execute(
      "call-1",
      { url: "http://169.254.169.254/latest/meta-data/" },
      undefined,
    )
    const details = result.details as { error?: string; successful?: number }
    expect(details.successful).toBe(0)
    expect(details.error).toMatch(/blocked|internal/i)
    // 不应真正发起对私网地址的请求。
    expect(fetch).not.toHaveBeenCalledWith(expect.stringContaining("169.254.169.254"))
  })

  it("allowRanges 放行的 CIDR 可以被访问", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(htmlPage("meta-data"), {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    )
    const tool = fetchTool({
      lookup: publicLookup(),
      ssrf: { allowRanges: ["169.254.169.254/32"], trustEnvProxy: false },
    })
    const result = await tool.execute(
      "call-1",
      { url: "http://169.254.169.254/latest/meta-data/" },
      undefined,
    )
    const details = result.details as { error?: string; successful?: number }
    expect(details.error).toBeFalsy()
    expect(details.successful).toBe(1)
  })

  it("响应 signal.aborted 时返回 aborted 结果", async () => {
    const controller = new AbortController()
    const tool = fetchTool()
    vi.mocked(fetch).mockImplementation(() => {
      controller.abort()
      return Promise.reject(Object.assign(new Error("Aborted"), { name: "AbortError" }))
    })
    const result = await tool.execute("call-1", { url: "https://example.com/" }, controller.signal)
    const details = result.details as { error?: string }
    expect(details.error).toBeTruthy()
  })
})

describe("fetch_content 本地路径能力", () => {
  it("workspaceHostPath 缺省时 GitHub clone 禁用", async () => {
    const tool = fetchTool({ lookup: publicLookup() }) // 无 workspaceHostPath
    const result = await tool.execute("call-1", { url: "https://github.com/owner/repo" }, undefined)
    const details = result.details as { error?: string; successful?: number }
    expect(details.successful).toBe(0)
    expect(details.error).toMatch(/clone disabled/i)
  })

  it("workspaceHostPath 缺省时 PDF 禁用", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response("%PDF-1.4 fake pdf bytes", {
        status: 200,
        headers: { "content-type": "application/pdf" },
      }),
    )
    const tool = fetchTool({ lookup: publicLookup() })
    const result = await tool.execute(
      "call-1",
      { url: "https://example.com/report.pdf" },
      undefined,
    )
    const details = result.details as { error?: string; successful?: number }
    expect(details.successful).toBe(0)
    expect(details.error).toMatch(/pdf extraction disabled/i)
  })

  it("提供 workspaceHostPath 时普通 HTTP 抓取正常", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(htmlPage("Hello"), {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    )
    const tool = fetchTool({
      lookup: publicLookup(),
      workspaceHostPath: "/tmp/sandbox-workspace",
    })
    const result = await tool.execute("call-1", { url: "https://example.com/" }, undefined)
    const details = result.details as {
      error?: string
      successful?: number
      responseId?: string
    }
    expect(details.error).toBeFalsy()
    expect(details.successful).toBe(1)
    expect(details.responseId).toBeTruthy()
  })
})
