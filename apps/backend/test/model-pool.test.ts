import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FileSecretStore, modelsFromAgentOptions } from "@ctf-agent/core"
import { SOLVER_SYSTEM_PROMPT } from "@ctf-agent/prompts"
import { afterEach, describe, expect, it, vi } from "vite-plus/test"
import { createFileModelAuthentication } from "../src/domain/model-auth.ts"
import { createFileModelConfiguration, omitOutputTokenLimit } from "../src/domain/model-pool.ts"
import { ProviderRequestGate } from "../src/domain/provider-request-gate.ts"

const roots: string[] = []

function modelEntry(
  overrides: Partial<{
    id: string
    provider: string
    modelId: string
    contextWindow: number
    thinkingEnabled: boolean
    reasoningEffort: string
    passthroughThinking: boolean
  }> = {},
) {
  return {
    id: "solver",
    provider: "custom-openai",
    modelId: "solver-model",
    contextWindow: 64_000,
    thinkingEnabled: true,
    reasoningEffort: "medium",
    passthroughThinking: false,
    ...overrides,
  }
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("file model configuration", () => {
  it("通过 Responses bridge 暴露三种自定义 Provider 协议", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctf-model-bridge-"))
    roots.push(root)
    const configuration = await createFileModelConfiguration({
      storagePath: join(root, "model-config.json"),
      secretStore: await FileSecretStore.open(join(root, "secrets.json")),
    })
    await configuration.addCustomProvider({
      name: "Completions",
      api: "openai-completions",
      baseUrl: "https://completion.example.test/v1",
      apiKey: "completion-secret",
    })
    await configuration.addCustomProvider({
      name: "Anthropic",
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com/v1",
      apiKey: "anthropic-secret",
    })
    await configuration.addCustomProvider({
      name: "Responses",
      api: "openai-responses",
      baseUrl: "https://responses.example.test/v1",
      apiKey: "responses-secret",
    })
    await configuration.update({
      models: [
        modelEntry({ id: "completion", provider: "custom-completions", modelId: "gpt" }),
        modelEntry({ id: "anthropic", provider: "custom-anthropic", modelId: "claude" }),
        modelEntry({ id: "responses", provider: "custom-responses", modelId: "gpt-responses" }),
      ],
      solverModelId: "completion",
      tldrModelId: "completion",
      subagentModels: {},
    })

    await expect(configuration.codexSecurityConfiguration("completion")).resolves.toMatchObject({
      model: "gpt",
      providerApi: "openai-completions",
      baseUrl: "https://completion.example.test/v1",
      apiKey: "completion-secret",
    })
    await expect(configuration.codexSecurityConfiguration("anthropic")).resolves.toMatchObject({
      model: "claude",
      providerApi: "anthropic-messages",
    })
    await expect(configuration.codexSecurityConfiguration("responses")).resolves.toMatchObject({
      model: "gpt-responses",
      providerApi: "openai-responses",
    })
  })
  it("从自定义供应商的 /models 获取去重模型 ID", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctf-model-discovery-"))
    roots.push(root)
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            data: [{ id: "model-b" }, { id: "model-a" }, { id: "model-a" }],
          }),
          { headers: { "content-type": "application/json" } },
        ),
    )
    const configuration = await createFileModelConfiguration({
      storagePath: join(root, "model-config.json"),
      secretStore: await FileSecretStore.open(join(root, "secrets.json")),
      fetch: fetchMock,
    })
    await configuration.addCustomProvider({
      name: "Gateway",
      api: "openai-completions",
      baseUrl: "https://models.example.test/v1/",
      apiKey: "provider-secret",
    })

    await expect(configuration.discoverCustomProviderModels("custom-gateway")).resolves.toEqual([
      "model-a",
      "model-b",
    ])
    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe("https://models.example.test/v1/models")
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer provider-secret")
  })

  for (const endpointCase of [
    { api: "openai-completions", endpointPath: "/proxy/chat/completions" },
    { api: "openai-responses", endpointPath: "/proxy/responses" },
    { api: "anthropic-messages", endpointPath: "/proxy/v1/messages" },
  ] as const) {
    it(`${endpointCase.api} 使用配置的最终请求 Endpoint`, async () => {
      const root = await mkdtemp(join(tmpdir(), "ctf-model-endpoint-"))
      roots.push(root)
      const requestPaths: string[] = []
      const server = createServer((request, response) => {
        requestPaths.push(request.url ?? "")
        response.writeHead(400)
        response.end("endpoint test")
      })
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject)
        server.listen(0, "127.0.0.1", resolve)
      })
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("测试 Provider 未监听端口")

      try {
        const configuration = await createFileModelConfiguration({
          storagePath: join(root, "model-config.json"),
          secretStore: await FileSecretStore.open(join(root, "secrets.json")),
          providerRequestGate: new ProviderRequestGate({
            minimumIntervalMs: 0,
            transientCooldownMs: 0,
          }),
        })
        const provider = `custom-${endpointCase.api}`
        await configuration.addCustomProvider({
          name: endpointCase.api,
          api: endpointCase.api,
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          endpointUrl: `http://127.0.0.1:${address.port}${endpointCase.endpointPath}`,
          apiKey: "provider-secret",
        })
        await configuration.update({
          models: [modelEntry({ provider })],
          solverModelId: "solver",
          tldrModelId: "solver",
          subagentModels: {},
        })
        const agent = configuration.createAgentOptions()
        const model = agent.initialState?.model
        if (!model) throw new Error("测试模型未配置")

        await modelsFromAgentOptions(agent, model)
          .streamSimple(model, { systemPrompt: "test", messages: [], tools: [] })
          .result()

        expect(requestPaths).toContain(endpointCase.endpointPath)
      } finally {
        server.closeAllConnections()
        if (server.listening) {
          await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          )
        }
      }
    })
  }

  it("只把 API Key 写入 Secret Store", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctf-model-config-"))
    roots.push(root)
    const storagePath = join(root, "model-config.json")
    const secretsPath = join(root, "secrets.json")
    const configuration = await createFileModelConfiguration({
      storagePath,
      secretStore: await FileSecretStore.open(secretsPath),
    })
    await configuration.addCustomProvider({
      name: "OpenAI",
      api: "openai-completions",
      baseUrl: "https://models.example.test/v1",
      apiKey: "secret-key",
    })

    const view = await configuration.update({
      models: [modelEntry({ reasoningEffort: "high" })],
      solverModelId: "solver",
      tldrModelId: "solver",
      subagentModels: {},
    })

    expect(view.models[0]).toMatchObject({
      configured: true,
    })
    expect(JSON.stringify(view)).not.toContain("secret-key")
    expect(await readFile(storagePath, "utf8")).not.toContain("secret-key")
    expect(await readFile(secretsPath, "utf8")).toContain("secret-key")

    const agent = configuration.createAgentOptions()
    expect(agent.initialState?.model).toMatchObject({
      id: "solver-model",
      provider: "custom-openai",
      api: "openai-completions",
      baseUrl: "https://models.example.test/v1",
      maxTokens: 64_000,
    })
    expect(await agent.getApiKey?.("custom-openai")).toBe("secret-key")
    expect(await agent.getApiKey?.("another-provider")).toBeUndefined()
    expect(agent.initialState?.systemPrompt).toBe(SOLVER_SYSTEM_PROMPT)

    const disabledThinking = await configuration.update({
      models: [modelEntry({ thinkingEnabled: false, reasoningEffort: "high" })],
      solverModelId: "solver",
      tldrModelId: "solver",
      subagentModels: {},
    })
    expect(disabledThinking.models[0]?.supportedThinkingLevels).toContain("high")
  })

  it("编辑自定义供应商时保留 id 与未替换的 API Key", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctf-model-provider-edit-"))
    roots.push(root)
    const storagePath = join(root, "model-config.json")
    const secretsPath = join(root, "secrets.json")
    const configuration = await createFileModelConfiguration({
      storagePath,
      secretStore: await FileSecretStore.open(secretsPath),
    })
    await configuration.addCustomProvider({
      name: "Internal Gateway",
      api: "openai-completions",
      baseUrl: "https://models.example.test/v1",
      apiKey: "original-secret",
    })

    const edited = await configuration.updateCustomProvider("custom-internal-gateway", {
      name: "Internal Responses",
      api: "openai-responses",
      baseUrl: "https://responses.example.test/v1/",
    })

    expect(edited.customProviders).toEqual([
      expect.objectContaining({
        id: "custom-internal-gateway",
        name: "Internal Responses",
        api: "openai-responses",
        baseUrl: "https://responses.example.test/v1",
        apiKeyConfigured: true,
      }),
    ])
    expect(await readFile(secretsPath, "utf8")).toContain("original-secret")
  })

  it("拒绝非 v3 模型配置", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctf-model-migration-"))
    roots.push(root)
    const storagePath = join(root, "model-config.json")
    const secretsPath = join(root, "secrets.json")
    await writeFile(
      storagePath,
      JSON.stringify({
        modelId: "solver-model",
        maxTokens: 4_096,
        apiKey: "legacy-key",
      }),
    )

    await expect(
      createFileModelConfiguration({
        storagePath,
        secretStore: await FileSecretStore.open(secretsPath),
      }),
    ).rejects.toThrow("必须使用 v3")
  })

  it("从 OpenAI-compatible 请求中移除两种输出 token 字段", () => {
    expect(
      omitOutputTokenLimit({
        model: "solver-model",
        max_tokens: 4_096,
        max_completion_tokens: 8_192,
      }),
    ).toEqual({ model: "solver-model" })
  })

  it("不同 AgentOptions 的同 Provider 请求共享瞬时故障冷却", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctf-model-provider-gate-"))
    roots.push(root)
    const requestTimes: number[] = []
    const server = createServer((_request, response) => {
      requestTimes.push(Date.now())
      response.writeHead(503)
      response.end()
    })
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", resolve)
    })
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("测试 Provider 未监听端口")

    try {
      const configuration = await createFileModelConfiguration({
        storagePath: join(root, "model-config.json"),
        secretStore: await FileSecretStore.open(join(root, "secrets.json")),
        providerRequestGate: new ProviderRequestGate({
          minimumIntervalMs: 0,
          transientCooldownMs: 25,
        }),
      })
      await configuration.addCustomProvider({
        name: "Failing Gateway",
        api: "openai-completions",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        apiKey: "provider-secret",
      })
      await configuration.update({
        models: [modelEntry({ provider: "custom-failing-gateway" })],
        solverModelId: "solver",
        tldrModelId: "solver",
        subagentModels: {},
      })
      const firstAgent = configuration.createAgentOptions()
      const secondAgent = configuration.createAgentOptions()
      const firstModel = firstAgent.initialState?.model
      const secondModel = secondAgent.initialState?.model
      if (!firstModel || !secondModel) throw new Error("测试模型未配置")

      await modelsFromAgentOptions(firstAgent, firstModel)
        .streamSimple(firstModel, { systemPrompt: "test", messages: [], tools: [] })
        .result()
      await modelsFromAgentOptions(secondAgent, secondModel)
        .streamSimple(secondModel, { systemPrompt: "test", messages: [], tools: [] })
        .result()

      expect(requestTimes).toHaveLength(2)
      expect((requestTimes[1] ?? 0) - (requestTimes[0] ?? 0)).toBeGreaterThanOrEqual(20)
    } finally {
      server.closeAllConnections()
      if (server.listening) {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        )
      }
    }
  })

  it("配置不完整时保持可恢复状态且不创建 Agent", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctf-model-incomplete-"))
    roots.push(root)
    const configuration = await createFileModelConfiguration({
      storagePath: join(root, "model-config.json"),
      secretStore: await FileSecretStore.open(join(root, "secrets.json")),
    })

    expect(configuration.snapshot()).toMatchObject({
      configured: false,
      models: [],
      supportedThinkingLevels: [],
    })
    expect(() => configuration.createAgentOptions()).toThrow("未选择 Solver")
  })

  it("使用 Pi Provider 凭据与原生模型创建 Agent", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctf-native-model-"))
    roots.push(root)
    const authentication = await createFileModelAuthentication({
      storagePath: join(root, "auth.json"),
    })
    await authentication.importJson(JSON.stringify({ OPENAI_API_KEY: "openai-test-key" }))
    const openAi = (await authentication.snapshot()).providers.find(
      (provider) => provider.id === "openai",
    )
    const modelId = openAi?.models[0]?.id
    if (!modelId) throw new Error("Pi 未提供 OpenAI 内置模型")
    const configuration = await createFileModelConfiguration({
      storagePath: join(root, "model-config.json"),
      secretStore: await FileSecretStore.open(join(root, "secrets.json")),
      authentication,
    })

    const view = await configuration.update({
      models: [
        modelEntry({
          provider: "openai",
          modelId,
          reasoningEffort: "high",
        }),
      ],
      solverModelId: "solver",
      tldrModelId: "solver",
      subagentModels: {},
    })

    expect(view.models[0]).toMatchObject({
      configured: true,
    })
    expect(configuration.createAgentOptions()).toMatchObject({
      initialState: { model: { provider: "openai", id: modelId } },
    })
  })

  it("为 Solver、TLDR 和 SubAgent 注册并选择不同模型", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctf-model-pool-"))
    roots.push(root)
    const configuration = await createFileModelConfiguration({
      storagePath: join(root, "model-config.json"),
      secretStore: await FileSecretStore.open(join(root, "secrets.json")),
    })
    await configuration.addCustomProvider({
      name: "OpenAI",
      api: "openai-completions",
      baseUrl: "https://models.example.test/v1",
      apiKey: "solver-key",
    })
    await configuration.addCustomProvider({
      name: "Worker Provider",
      api: "openai-responses",
      baseUrl: "https://workers.example.test/v1",
      apiKey: "worker-key",
    })
    await configuration.addCustomProvider({
      name: "Anthropic Proxy",
      api: "anthropic-messages",
      baseUrl: "https://anthropic.example.test",
      apiKey: "anthropic-key",
    })

    const view = await configuration.update({
      models: [
        modelEntry(),
        modelEntry({
          id: "worker",
          provider: "custom-worker-provider",
          modelId: "worker-model",
        }),
        modelEntry({
          id: "anthropic",
          provider: "custom-anthropic-proxy",
          modelId: "claude-compatible",
        }),
      ],
      solverModelId: "solver",
      tldrModelId: "worker",
      subagentModels: { explorer: "worker" },
    })

    expect(view).toMatchObject({
      configured: true,
      solverModelId: "solver",
      tldrModelId: "worker",
      subagentModels: { explorer: "worker" },
    })
    const solver = configuration.createAgentOptions("solver")
    const tldr = configuration.createAgentOptions("tldr")
    expect(solver.initialState?.model).toMatchObject({
      provider: "custom-openai",
      id: "solver-model",
    })
    expect(tldr.initialState?.model).toMatchObject({
      provider: "custom-worker-provider",
      id: "worker-model",
      api: "openai-responses",
    })
    const solverModel = solver.initialState?.model
    if (!solverModel) throw new Error("missing solver model")
    const registry = modelsFromAgentOptions(solver, solverModel)
    expect(registry.getModel("custom-worker-provider", "worker-model")).toBeDefined()
    expect(registry.getModel("custom-anthropic-proxy", "claude-compatible")).toMatchObject({
      api: "anthropic-messages",
    })
    expect(configuration.modelForSubagent("explorer")).toBe("custom-worker-provider/worker-model")

    const projectBindings = {
      solverModelId: "worker",
      tldrModelId: "solver",
      subagentModels: { explorer: "solver" },
    }
    expect(
      configuration.createAgentOptions("solver", projectBindings).initialState?.model,
    ).toMatchObject({ provider: "custom-worker-provider", id: "worker-model" })
    expect(configuration.modelForSubagent("explorer", projectBindings)).toBe(
      "custom-openai/solver-model",
    )
  })

  it("首次建模型且 solverModelId 为空时自动落到第一个模型", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctf-model-first-"))
    roots.push(root)
    const configuration = await createFileModelConfiguration({
      storagePath: join(root, "model-config.json"),
      secretStore: await FileSecretStore.open(join(root, "secrets.json")),
    })
    await configuration.addCustomProvider({
      name: "DeepSeek",
      api: "openai-completions",
      baseUrl: "https://api.deepseek.example/v1",
      apiKey: "deepseek-key",
    })

    // 前端新建模型时 solverModelId 为空字符串（尚无 solver 绑定）。
    const view = await configuration.update({
      models: [
        modelEntry({
          id: "m-1",
          provider: "custom-deepseek",
          modelId: "deepseek-v4-flash",
        }),
      ],
      solverModelId: "",
      tldrModelId: "",
      subagentModels: {},
    })

    expect(view.solverModelId).toBe("m-1")
    expect(view.tldrModelId).toBe("m-1")
    expect(configuration.createAgentOptions("solver").initialState?.model).toMatchObject({
      provider: "custom-deepseek",
      id: "deepseek-v4-flash",
    })
  })
})
