// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useChallengeDetails } from "../src/hooks/useChallengeDetails.ts"
import type { ChallengeDetails } from "../src/types.ts"

function details(overrides: Partial<ChallengeDetails> = {}): ChallengeDetails {
  return {
    generatedAt: "2024-06-01T00:00:00Z",
    challenge: {
      id: "pwn-1",
      title: "栈溢出",
      category: "pwn",
      score: 500,
      status: "pending",
      platformSolved: false,
      attempts: 0,
      latestRunId: null,
      latestRunStatus: null,
      lastActivityAt: null,
      progress: "未调度",
      queuePosition: null,
      dispatchSource: null,
      schedulerAttempts: 0,
      sessionInterruptions: 0,
      evidence: 0,
      openOpportunities: 0,
      concludedOpportunities: 0,
    },
    runs: [],
    blackboard: { evidence: [], opportunities: [] },
    environment: null,
    writeup: {
      validation: { valid: false, path: "", errors: [], size: 0 },
      content: null,
    },
    tldr: null,
    ...overrides,
  }
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  })
}

class FakeEventSource {
  static instances: FakeEventSource[] = []
  listeners = new Map<string, Array<(event: MessageEvent<string>) => void>>()
  url: string
  constructor(url: string) {
    this.url = url
    FakeEventSource.instances.push(this)
  }
  addEventListener(
    type: string,
    listener: (event: MessageEvent<string>) => void,
  ): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }
  emit(type: string, data: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data } as MessageEvent<string>)
    }
  }
  close(): void {
    FakeEventSource.instances = FakeEventSource.instances.filter(
      (i) => i !== this,
    )
  }
}

describe("useChallengeDetails", () => {
  const fetchMock = vi.fn<typeof fetch>()
  let originalEventSource: typeof EventSource

  beforeEach(() => {
    fetchMock.mockReset()
    globalThis.fetch = fetchMock as unknown as typeof fetch
    originalEventSource = globalThis.EventSource
    FakeEventSource.instances = []
    ;(globalThis as { EventSource: unknown }).EventSource =
      FakeEventSource as unknown as typeof EventSource
  })

  afterEach(() => {
    globalThis.EventSource = originalEventSource
    vi.restoreAllMocks()
  })

  it("加载详情并选中第一个 run", async () => {
    const data = details({
      runs: [
        {
          id: "run-1",
          attempt: 1,
          status: "running",
          createdAt: "2024-06-01T00:00:00Z",
          events: [],
          subagents: [],
          cache: {
            inputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            cacheRate: null,
          },
          hasConversation: true,
        } as unknown as ChallengeDetails["runs"][number],
      ],
    })
    fetchMock.mockResolvedValueOnce(jsonResponse(data))

    const { result } = renderHook(() => useChallengeDetails("p-1", "pwn-1"))
    await waitFor(() => expect(result.current.details).not.toBeNull())
    expect(result.current.selectedRun?.id).toBe("run-1")
    expect(result.current.target).toEqual({ type: "solver" })
  })

  it("SSE snapshot 事件触发重新加载", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(details()))
    const { result } = renderHook(() => useChallengeDetails("p-1", "pwn-1"))
    await waitFor(() => expect(result.current.details).not.toBeNull())

    const callsBefore = fetchMock.mock.calls.length
    const source = FakeEventSource.instances[0]
    expect(source).toBeDefined()
    if (source)
      actEmit(source, "snapshot", JSON.stringify({ generatedAt: "x" }))
    await waitFor(() =>
      expect(fetchMock.mock.calls.length).toBeGreaterThan(callsBefore),
    )
    expect(result.current.details).not.toBeNull()
  })

  it("加载失败记录错误", async () => {
    fetchMock.mockRejectedValueOnce(new Error("请求失败"))
    const { result } = renderHook(() => useChallengeDetails("p-1", "pwn-1"))
    await waitFor(() => expect(result.current.error).toBe("请求失败"))
  })

  it("dispatch 动作走 /dispatch 并携带 force（blocked 状态）", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(
          details({ challenge: { ...details().challenge, status: "blocked" } }),
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          details({ challenge: { ...details().challenge, status: "running" } }),
        ),
      )
    const { result } = renderHook(() => useChallengeDetails("p-1", "pwn-1"))
    await waitFor(() => expect(result.current.details).not.toBeNull())

    await result.current.challengeAction("dispatch")
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/projects/p-1/challenges/pwn-1/dispatch",
        expect.objectContaining({ body: JSON.stringify({ force: true }) }),
      ),
    )
  })
})

function actEmit(source: FakeEventSource, type: string, data: string): void {
  // 同步派发 SSE 事件（避免引入 act 依赖）
  source.emit(type, data)
}
