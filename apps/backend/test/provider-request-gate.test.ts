import {
  type Api,
  type AssistantMessage,
  type Context,
  createAssistantMessageEventStream,
  type Model,
} from "@earendil-works/pi-ai"
import { afterEach, describe, expect, it, vi } from "vite-plus/test"
import { gateProviderStream, ProviderRequestGate } from "../src/domain/provider-request-gate.ts"

const context = { systemPrompt: "test", messages: [], tools: [] } satisfies Context

afterEach(() => {
  vi.useRealTimers()
})

describe("ProviderRequestGate", () => {
  it("错开同一 Provider 的请求，同时允许不同 Provider 独立启动", async () => {
    vi.useFakeTimers()
    const starts: string[] = []
    const source = (candidate: Model<Api>) => {
      starts.push(`${candidate.provider}:${Date.now()}`)
      return completedStream(message(candidate))
    }
    const stream = gateProviderStream(
      new ProviderRequestGate({ minimumIntervalMs: 1_000, transientCooldownMs: 10_000 }),
      source,
    )
    const first = stream(model("provider-a", "first"), context)
    const second = stream(model("provider-a", "second"), context)
    const independent = stream(model("provider-b", "other"), context)

    await vi.advanceTimersByTimeAsync(0)
    await Promise.all([first.result(), independent.result()])
    expect(starts.map((entry) => entry.split(":")[0])).toEqual(["provider-a", "provider-b"])

    await vi.advanceTimersByTimeAsync(999)
    expect(starts).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    await second.result()
    expect(starts).toHaveLength(3)
  })

  it("一次 Provider 503 会让后续同 Provider 请求共享冷却", async () => {
    vi.useFakeTimers()
    let providerACalls = 0
    const source = (candidate: Model<Api>) => {
      if (candidate.provider === "provider-a") providerACalls++
      return completedStream(
        message(
          candidate,
          candidate.provider === "provider-a" && providerACalls === 1
            ? { stopReason: "error", errorMessage: "503 status code (no body)" }
            : {},
        ),
      )
    }
    const stream = gateProviderStream(
      new ProviderRequestGate({ minimumIntervalMs: 0, transientCooldownMs: 10_000 }),
      source,
    )

    await vi.advanceTimersByTimeAsync(0)
    await stream(model("provider-a", "first"), context).result()
    const cooling = stream(model("provider-a", "second"), context)
    const independent = stream(model("provider-b", "other"), context)

    await vi.advanceTimersByTimeAsync(9_999)
    await independent.result()
    expect(providerACalls).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    await cooling.result()
    expect(providerACalls).toBe(2)
  })

  it("取消等待中的请求不会调用 Provider", async () => {
    vi.useFakeTimers()
    const source = vi.fn((candidate: Model<Api>) => completedStream(message(candidate)))
    const stream = gateProviderStream(
      new ProviderRequestGate({ minimumIntervalMs: 1_000, transientCooldownMs: 10_000 }),
      source,
    )
    await vi.advanceTimersByTimeAsync(0)
    await stream(model("provider-a", "first"), context).result()
    const controller = new AbortController()
    const waiting = stream(model("provider-a", "cancelled"), context, {
      signal: controller.signal,
    })

    controller.abort()
    await vi.advanceTimersByTimeAsync(0)

    await expect(waiting.result()).resolves.toMatchObject({ stopReason: "aborted" })
    expect(source).toHaveBeenCalledOnce()
  })
})

function model(provider: string, id: string): Model<Api> {
  return {
    api: "openai-completions",
    provider,
    id,
    name: id,
    baseUrl: "https://models.example.test/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 64_000,
    maxTokens: 8_192,
  }
}

function message(
  candidate: Model<Api>,
  overrides: Partial<Pick<AssistantMessage, "stopReason" | "errorMessage">> = {},
): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: candidate.api,
    provider: candidate.provider,
    model: candidate.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: overrides.stopReason ?? "stop",
    ...(overrides.errorMessage ? { errorMessage: overrides.errorMessage } : {}),
    timestamp: Date.now(),
  }
}

function completedStream(result: AssistantMessage) {
  const stream = createAssistantMessageEventStream()
  stream.end(result)
  return stream
}
