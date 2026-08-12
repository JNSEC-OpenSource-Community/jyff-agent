// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react"
import { createElement } from "react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, describe, expect, it, vi } from "vite-plus/test"
import { TokenUsagePage } from "../src/pages/TokenUsagePage.tsx"

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("TokenUsagePage", () => {
  it("按模型显示输入、输出与缓存命中的共享刻度柱形条", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => jsonResponse(usageSnapshot(12_000))),
    )
    renderPage()

    const title = await screen.findByRole("heading", { name: "Token 消耗" })
    expect(title.closest(".token-usage-page")).toBeTruthy()
    expect(screen.getByText("openai-codex/gpt-5.6-sol")).toBeTruthy()
    expect(screen.getByRole("progressbar", { name: "输入 12,000 tokens" })).toBeTruthy()
    expect(screen.getByRole("progressbar", { name: "输出 3,000 tokens" })).toBeTruthy()
    expect(screen.getByRole("progressbar", { name: "缓存命中 8,000 tokens" })).toBeTruthy()
    expect(screen.getByText("40.0%")).toBeTruthy()
    expect(screen.getByText(/命中率 40\.0%/)).toBeTruthy()
  })

  it("每次进入页面都使用 no-store 重新请求最新比赛用量", async () => {
    let inputTokens = 1_000
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.cache).toBe("no-store")
      return jsonResponse(usageSnapshot(inputTokens))
    })
    vi.stubGlobal("fetch", fetchMock)

    const first = renderPage()
    expect(await screen.findByRole("progressbar", { name: "输入 1,000 tokens" })).toBeTruthy()
    first.unmount()

    inputTokens = 2_000
    renderPage()
    expect(await screen.findByRole("progressbar", { name: "输入 2,000 tokens" })).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("中文历史模型名称继承 Token 面板黑体而不使用等宽字体", async () => {
    const snapshot = usageSnapshot(1_000)
    snapshot.models.push({
      provider: "legacy",
      model: "历史 SubAgent（模型未知）",
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 50,
      cacheWriteTokens: 0,
      totalTokens: 170,
      cacheHitRate: 1 / 3,
      attributed: false,
    })
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => jsonResponse(snapshot)),
    )

    renderPage()
    const historyName = await screen.findByText("历史 SubAgent（模型未知）")
    expect(historyName.classList.contains("font-mono")).toBe(false)
    expect(historyName.closest(".token-usage-page")).toBeTruthy()
  })
})

function renderPage() {
  return render(
    createElement(
      MemoryRouter,
      { initialEntries: ["/projects/demo/token-usage"] },
      createElement(
        Routes,
        null,
        createElement(Route, {
          path: "/projects/:projectId/token-usage",
          element: createElement(TokenUsagePage),
        }),
      ),
    ),
  )
}

function usageSnapshot(inputTokens: number) {
  const outputTokens = 3_000
  const cacheReadTokens = 8_000
  const totalTokens = inputTokens + outputTokens + cacheReadTokens
  return {
    generatedAt: "2026-08-12T08:00:00.000Z",
    models: [
      {
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens: 0,
        totalTokens,
        cacheHitRate: cacheReadTokens / (inputTokens + cacheReadTokens),
        attributed: true,
      },
    ],
    totals: {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens: 0,
      totalTokens,
      cacheHitRate: cacheReadTokens / (inputTokens + cacheReadTokens),
    },
    unattributedTokens: 0,
  }
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    headers: { "content-type": "application/json" },
  })
}
