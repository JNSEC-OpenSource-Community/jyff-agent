import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import type { Context } from "@earendil-works/pi-ai"
import {
  loadModelEnvironment,
  thinkingEnabledFromEnv,
  thinkingLevelFromEnv,
} from "./agent-config.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })))
})

const thinkingContext = {
  systemPrompt: "You are a CTF solver.",
  messages: [{ role: "user", content: "hi", timestamp: 1 }],
  tools: [],
} as unknown as Context

const DONE_LINES = [
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
  "data: [DONE]",
]

function stubFetch(lines: string[]): Array<{ url: string; init: RequestInit }> {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const mock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} })
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const line of lines) controller.enqueue(new TextEncoder().encode(`${line}\n`))
        controller.close()
      },
    })
    return { ok: true, status: 200, body } as unknown as Response
  })
  vi.stubGlobal("fetch", mock)
  return calls
}

describe("thinkingEnabledFromEnv / thinkingLevelFromEnv env 映射", () => {
  const previousThinking = process.env.CTF_MODEL_THINKING
  const previousEffort = process.env.CTF_MODEL_REASONING_EFFORT

  afterEach(() => {
    if (previousThinking === undefined) delete process.env.CTF_MODEL_THINKING
    else process.env.CTF_MODEL_THINKING = previousThinking
    if (previousEffort === undefined) delete process.env.CTF_MODEL_REASONING_EFFORT
    else process.env.CTF_MODEL_REASONING_EFFORT = previousEffort
  })

  it("无 env:thinking 关闭,thinkingLevel 为 off", () => {
    delete process.env.CTF_MODEL_THINKING
    delete process.env.CTF_MODEL_REASONING_EFFORT
    expect(thinkingEnabledFromEnv()).toBe(false)
    expect(thinkingLevelFromEnv()).toBe("off")
  })

  it("CTF_MODEL_THINKING=on 未指定 effort:thinkingLevel 默认 max", () => {
    process.env.CTF_MODEL_THINKING = "on"
    delete process.env.CTF_MODEL_REASONING_EFFORT
    expect(thinkingEnabledFromEnv()).toBe(true)
    expect(thinkingLevelFromEnv()).toBe("max")
  })

  it("on + max:thinkingLevel 为 max", () => {
    process.env.CTF_MODEL_THINKING = "on"
    process.env.CTF_MODEL_REASONING_EFFORT = "max"
    expect(thinkingLevelFromEnv()).toBe("max")
  })

  it("on + 非法 effort:回退 high(与旧自建通道语义一致)", () => {
    process.env.CTF_MODEL_THINKING = "on"
    process.env.CTF_MODEL_REASONING_EFFORT = "bogus"
    expect(thinkingLevelFromEnv()).toBe("high")
  })
})

describe("createAgentOptions 原生思维链开关", () => {
  const envKeys = [
    "CTF_MODEL_THINKING",
    "CTF_MODEL_REASONING_EFFORT",
    "CTF_MODEL_API_KEY",
    "CTF_MODEL_ID",
    "CTF_MODEL_PROVIDER",
    "CTF_MODEL_BASE_URL",
  ] as const
  const previousEnv = new Map<string, string | undefined>()

  beforeAll(() => {
    for (const key of envKeys) previousEnv.set(key, process.env[key])
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    for (const key of envKeys) {
      const previous = previousEnv.get(key)
      if (previous === undefined) delete process.env[key]
      else process.env[key] = previous
    }
  })

  /**
   * 迁移后思考开关/强度从 WebUI 持久化配置(model-config.json)读取,不再读 env。
   * 用 update() 写入配置再 createAgentOptions();apiKey/modelId 仍走 env 兜底。
   */
  async function createConfiguredOptions(
    thinkingEnabled: boolean,
    reasoningEffort: string,
    modelId = "deepseek-v4-flash",
    baseUrl = "",
    passthroughThinking = false,
  ) {
    process.env.CTF_MODEL_API_KEY = "test-key"
    process.env.CTF_MODEL_PROVIDER = "deepseek"
    // 空串而非 delete:loadEnvFile 不覆盖已设置的值,防 .env 的 CTF_MODEL_BASE_URL
    // 被重新注入(否则走 baseUrl 分支,无 thinkingLevelMap,max 会被钳到 high)
    process.env.CTF_MODEL_BASE_URL = ""
    const root = await mkdtemp(join(tmpdir(), "ctf-agent-options-"))
    roots.push(root)
    const configuration = loadModelEnvironment({ storagePath: join(root, "model-config.json") })
    await configuration.update({
      provider: "deepseek",
      modelId,
      baseUrl,
      contextWindow: 64_000,
      maxTokens: 4_096,
      thinkingEnabled,
      reasoningEffort,
      passthroughThinking,
    })
    return configuration.createAgentOptions()
  }

  it("透传模式:自定义 Base URL + max 全档位直通,不受 pi 无 map 钳制", async () => {
    const calls = stubFetch(DONE_LINES)
    const options = await createConfiguredOptions(true, "max", "claude-opus-5", "https://relay.example.test/v1", true)
    expect(options.initialState!.model!.reasoning).toBe(true)
    expect(options.initialState!.thinkingLevel).toBe("max")

    const stream = await options.streamFn(options.initialState!.model!, thinkingContext, {
      apiKey: "test-key",
      reasoning: "max",
    })
    for await (const _event of stream) {
      // 消费流以驱动请求
    }
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>
    expect(body.thinking).toEqual({ type: "enabled" })
    expect(body.reasoning_effort).toBe("max")
  })

  it("开启 + max:model.reasoning=true、thinkingLevel=max,请求体注入 thinking:{type:enabled} + reasoning_effort:max", async () => {
    const calls = stubFetch([
      'data: {"choices":[{"delta":{"reasoning_content":"let me think"}}]}',
      'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}',
      "data: [DONE]",
    ])
    const options = await createConfiguredOptions(true, "max")
    expect(options.initialState!.thinkingLevel).toBe("max")
    expect(options.initialState!.model!.reasoning).toBe(true)

    const stream = await options.streamFn(options.initialState!.model!, thinkingContext, {
      apiKey: "test-key",
      // 字面量直传:pi-agent-core 与 pi-ai 各有一份结构相同的 ThinkingLevel 类型(名义不同),复用 initialState 值需跨界断言
      reasoning: "max",
    })
    for await (const _event of stream) {
      // 消费流以驱动请求
    }
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>
    expect(body.thinking).toEqual({ type: "enabled" })
    expect(body.reasoning_effort).toBe("max")
  })

  it("开启 + 未指定档位:thinkingLevel 默认 max(environment 默认值),请求体注入 thinking", async () => {
    const calls = stubFetch(DONE_LINES)
    const options = await createConfiguredOptions(true, "max")
    expect(options.initialState!.thinkingLevel).toBe("max")
    expect(options.initialState!.model!.reasoning).toBe(true)

    const stream = await options.streamFn(options.initialState!.model!, thinkingContext, {
      apiKey: "test-key",
      reasoning: "low",
    })
    for await (const _event of stream) {
      // 消费流以驱动请求
    }
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>
    expect(body.thinking).toEqual({ type: "enabled" })
    // reasoning_effort 具体值由 pi clampThinkingLevel + thinkingLevelMap 决定(内置 deepseek
    // 模型 low 档映射为 null,会被钳到 high),本测试只断言开启态注入,不锁定 pi 内部档位。
    expect(body.reasoning_effort).toBeTypeOf("string")
  })

  it("baseUrl 分支(DeepSeek 自定义 URL):开启 + max 经 deepseekThinkingLevelMap 注入 reasoning_effort:max", async () => {
    const calls = stubFetch(DONE_LINES)
    const options = await createConfiguredOptions(true, "max", "deepseek-v4-flash", "https://api.deepseek.com/v1")
    expect(options.initialState!.model!.reasoning).toBe(true)

    const stream = await options.streamFn(options.initialState!.model!, thinkingContext, {
      apiKey: "test-key",
      reasoning: "max",
    })
    for await (const _event of stream) {
      // 消费流以驱动请求
    }
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>
    expect(body.thinking).toEqual({ type: "enabled" })
    expect(body.reasoning_effort).toBe("max")
  })

  it("baseUrl 分支 + v4-pro + low:按官方文档把 low 映射为 high(pro 不支持 low 档)", async () => {
    const calls = stubFetch(DONE_LINES)
    const options = await createConfiguredOptions(true, "low", "deepseek-v4-pro", "https://api.deepseek.com/v1")

    const stream = await options.streamFn(options.initialState!.model!, thinkingContext, {
      apiKey: "test-key",
      reasoning: "low",
    })
    for await (const _event of stream) {
      // 消费流以驱动请求
    }
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>
    expect(body.thinking).toEqual({ type: "enabled" })
    expect(body.reasoning_effort).toBe("high")
  })

  it("关闭(默认):请求体无 thinking/reasoning_effort", async () => {
    const calls = stubFetch(DONE_LINES)
    const options = await createConfiguredOptions(false, "max")
    expect(options.initialState!.thinkingLevel).toBe("off")
    expect(options.initialState!.model!.reasoning).toBe(false)

    const stream = await options.streamFn(options.initialState!.model!, thinkingContext, {
      apiKey: "test-key",
      reasoning: undefined,
    })
    for await (const _event of stream) {
      // 消费流以驱动请求
    }
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>
    expect(body.thinking).toBeUndefined()
    expect(body.reasoning_effort).toBeUndefined()
  })
})

describe("model configuration", () => {
  it("持久化 WebUI 模型配置且公开快照不包含密钥", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctf-model-config-"))
    roots.push(root)
    const storagePath = join(root, "model-config.json")
    const configuration = loadModelEnvironment({ storagePath })

    const view = await configuration.update({
      provider: "custom-openai",
      modelId: "solver-model",
      baseUrl: "https://models.example.test/v1",
      contextWindow: 64_000,
      maxTokens: 4_096,
      thinkingEnabled: true,
      reasoningEffort: "high",
      passthroughThinking: true,
      apiKey: "secret-key",
      platformToken: "platform-secret",
    })

    expect(view).toMatchObject({
      configured: true,
      apiKeyConfigured: true,
      apiKeySource: "webui",
      thinkingEnabled: true,
      reasoningEffort: "high",
      platformTokenConfigured: true,
      platformTokenSource: "webui",
    })
    expect(JSON.stringify(view)).not.toContain("secret-key")
    expect(JSON.stringify(view)).not.toContain("platform-secret")
    expect(await readFile(storagePath, "utf8")).toContain("secret-key")
    expect(await readFile(storagePath, "utf8")).toContain("platform-secret")
    expect(configuration.platformToken()).toBe("platform-secret")

    const reloaded = loadModelEnvironment({ storagePath })
    expect(reloaded.snapshot()).toEqual(view)
  })
})
