import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FileSecretStore, modelsFromAgentOptions } from "@ctf-agent/core"
import { SOLVER_SYSTEM_PROMPT } from "@ctf-agent/prompts"
import { afterEach, describe, expect, it } from "vitest"
import { createFileModelAuthentication } from "../src/domain/model-auth.ts"
import {
  createFileModelConfiguration,
  omitOutputTokenLimit,
} from "../src/domain/model-pool.ts"

const roots: string[] = []

function modelEntry(
  overrides: Partial<{
    id: string
    provider: string
    modelId: string
    baseUrl: string
    contextWindow: number
    thinkingEnabled: boolean
    reasoningEffort: string
    passthroughThinking: boolean
    apiKey: string
  }> = {},
) {
  return {
    id: "solver",
    provider: "custom-openai",
    modelId: "solver-model",
    baseUrl: "https://models.example.test/v1",
    contextWindow: 64_000,
    thinkingEnabled: true,
    reasoningEffort: "medium",
    passthroughThinking: false,
    ...overrides,
  }
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe("file model configuration", () => {
  it("只把 API Key 写入 Secret Store", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctf-model-config-"))
    roots.push(root)
    const storagePath = join(root, "model-config.json")
    const secretsPath = join(root, "secrets.json")
    const configuration = await createFileModelConfiguration({
      storagePath,
      secretStore: await FileSecretStore.open(secretsPath),
    })

    const view = await configuration.update({
      models: [modelEntry({ reasoningEffort: "high", apiKey: "secret-key" })],
      solverModelId: "solver",
      tldrModelId: "solver",
      subagentModels: {},
    })

    expect(view.models[0]).toMatchObject({
      configured: true,
      apiKeyConfigured: true,
      apiKeySource: "secret-store",
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
    expect(disabledThinking.models[0]?.supportedThinkingLevels).toContain(
      "high",
    )
  })

  it("把旧模型配置中的明文 Key 迁移到 Secret Store", async () => {
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

    const configuration = await createFileModelConfiguration({
      storagePath,
      secretStore: await FileSecretStore.open(secretsPath),
    })

    expect(configuration.snapshot().models[0]?.apiKeySource).toBe(
      "secret-store",
    )
    expect(await readFile(storagePath, "utf8")).not.toContain("legacy-key")
    expect(await readFile(storagePath, "utf8")).not.toContain("maxTokens")
    expect(await readFile(secretsPath, "utf8")).toContain("legacy-key")
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
    await authentication.importJson(
      JSON.stringify({ OPENAI_API_KEY: "openai-test-key" }),
    )
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
          baseUrl: "",
          reasoningEffort: "high",
        }),
      ],
      solverModelId: "solver",
      tldrModelId: "solver",
      subagentModels: {},
    })

    expect(view.models[0]).toMatchObject({
      configured: true,
      apiKeyConfigured: true,
      apiKeySource: "provider-credential",
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

    const view = await configuration.update({
      models: [
        modelEntry({ apiKey: "solver-key" }),
        modelEntry({
          id: "worker",
          provider: "worker-provider",
          modelId: "worker-model",
          baseUrl: "https://workers.example.test/v1",
          apiKey: "worker-key",
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
      provider: "worker-provider",
      id: "worker-model",
    })
    const solverModel = solver.initialState?.model
    if (!solverModel) throw new Error("missing solver model")
    const registry = modelsFromAgentOptions(solver, solverModel)
    expect(registry.getModel("worker-provider", "worker-model")).toBeDefined()
    expect(configuration.modelForSubagent("explorer")).toBe(
      "worker-provider/worker-model",
    )

    const projectBindings = {
      solverModelId: "worker",
      tldrModelId: "solver",
      subagentModels: { explorer: "solver" },
    }
    expect(
      configuration.createAgentOptions("solver", projectBindings).initialState
        ?.model,
    ).toMatchObject({ provider: "worker-provider", id: "worker-model" })
    expect(configuration.modelForSubagent("explorer", projectBindings)).toBe(
      "custom-openai/solver-model",
    )
  })
})
