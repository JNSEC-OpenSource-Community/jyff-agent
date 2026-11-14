// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { createElement } from "react"
import { afterEach, describe, expect, it, vi } from "vite-plus/test"
import { AgentSidebar } from "../src/pages/challenge/AgentSidebar.tsx"
import type { ChallengeDetails } from "../src/types.ts"

const endpoint =
  "https://instance.example.test/very/long/environment/path/that/must/not/overflow/the/sidebar"

afterEach(cleanup)

describe("AgentSidebar", () => {
  it("offers a way to load omitted workers", () => {
    const loadMore = vi.fn()
    const challengeDetails = {
      ...details,
      runs: [{ ...details.runs[0]!, subagentOmittedCount: 3, subagentNextCursor: "cursor" }],
    } as ChallengeDetails
    render(
      createElement(AgentSidebar, {
        details: challengeDetails,
        selectedRunId: "run-1",
        selectedSubagentId: null,
        onSelectSubagent: vi.fn(),
        onLoadMoreSubagents: loadMore,
      }),
    )
    fireEvent.click(screen.getByRole("button", { name: "加载更多（3）" }))
    expect(loadMore).toHaveBeenCalledOnce()
  })

  it("根据选中 Agent 按需展示用量详情", () => {
    const { rerender } = renderSidebar("worker-1")

    expect(screen.getAllByText("Explorer Worker")).toHaveLength(2)
    expect(screen.queryByText("75%")).toBeNull()
    fireEvent.click(screen.getByText("用量详情"))
    expect(screen.getByText("75%")).toBeTruthy()
    expect(screen.getByText("100 tokens")).toBeTruthy()
    expect(screen.getByText("300 tokens")).toBeTruthy()
    expect(screen.getByText("20 tokens")).toBeTruthy()

    rerender(sidebar(null))
    expect(screen.getAllByText("Solver")).toHaveLength(2)
    expect(screen.getByText("50%")).toBeTruthy()
    expect(screen.getAllByText("200 tokens")).toHaveLength(2)
  })

  it("截断展示并复制完整环境 URL", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    })
    renderSidebar(null)

    expect(screen.getByText("运行中")).toBeTruthy()
    const url = screen.getByTitle(endpoint)
    expect(url.className).toContain("truncate")
    expect(url.className).toContain("min-w-0")
    fireEvent.click(screen.getByRole("button", { name: "复制环境 URL" }))

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(endpoint))
    expect(screen.getByRole("button", { name: "环境 URL 已复制" })).toBeTruthy()
    expect(url.parentElement?.parentElement?.className).toContain("minmax(0,1fr)")
  })

  it("区分平台未提供与明确不需要环境", () => {
    const unknownEnvironment = {
      ...details,
      challenge: { ...details.challenge, needsEnv: undefined },
      environment: null,
    } as ChallengeDetails
    const { rerender } = render(sidebar(null, unknownEnvironment))

    expect(screen.getByText("平台未提供")).toBeTruthy()

    rerender(
      sidebar(null, {
        ...unknownEnvironment,
        challenge: { ...unknownEnvironment.challenge, needsEnv: false },
      }),
    )
    expect(screen.getByText("不需要")).toBeTruthy()
  })
})

function renderSidebar(selectedSubagentId: string | null) {
  return render(sidebar(selectedSubagentId))
}

function sidebar(selectedSubagentId: string | null, challengeDetails: ChallengeDetails = details) {
  return createElement(AgentSidebar, {
    details: challengeDetails,
    selectedRunId: "run-1",
    selectedSubagentId,
    onSelectSubagent: vi.fn(),
  })
}

const details = {
  challenge: {
    id: "pwn-1",
    attempts: 1,
    sessionInterruptions: 0,
    platformSolved: false,
    needsEnv: true,
  },
  environment: {
    id: "env-1",
    challengeId: "pwn-1",
    status: "running",
    endpoint,
  },
  runs: [
    {
      id: "run-1",
      attempt: 1,
      status: "running",
      cache: {
        inputTokens: 200,
        cacheReadTokens: 200,
        cacheWriteTokens: 50,
        cacheRate: 0.5,
      },
      subagents: [
        {
          id: "worker-1",
          displayName: "Explorer Worker",
          role: "explorer",
          status: "running",
          turns: 2,
          totalTokens: 500,
          inputTokens: 100,
          cacheReadTokens: 300,
          cacheWriteTokens: 20,
        },
      ],
    },
  ],
} as unknown as ChallengeDetails
