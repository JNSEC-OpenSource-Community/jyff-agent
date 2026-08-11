import { describe, expect, it } from "vite-plus/test"
import {
  normalizeSearchProviderSelection,
  RESOLVED_SEARCH_PROVIDERS,
  search,
} from "../src/gemini-search.ts"
import { setRuntime } from "../src/runtime.ts"

describe("search provider selection", () => {
  it("接受每一个已注册 provider，并把未知输入安全回退到 auto", () => {
    for (const provider of RESOLVED_SEARCH_PROVIDERS) {
      expect(normalizeSearchProviderSelection(provider)).toBe(provider)
    }
    expect(normalizeSearchProviderSelection("unknown-provider")).toBe("auto")
  })

  it("all 不会自动调用明确请求才可用的付费 provider", async () => {
    setRuntime({
      providers: new Set(["anysearch", "xai", "brightdata", "serpbase"]),
      resolveSecret: () => "test-key",
      providerConfig: {},
      ssrf: { allowRanges: [], trustEnvProxy: false },
      timeouts: { fetchMs: 100, searchMs: 100, cloneMs: 100 },
      limits: { maxContentSliceLength: 100, maxInlineChars: 100 },
    })

    await expect(search("CTF query", { provider: "all" })).rejects.toThrow(
      "AnySearch, xAI, Bright Data, and SerpBase are excluded",
    )
  })
})
