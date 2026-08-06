import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FileSecretStore } from "@ctf-agent/core"
import { afterEach, describe, expect, it } from "vitest"
import { createFileModelAuthentication } from "../src/model-authentication.ts"
import {
  createFileModelConfiguration,
  omitOutputTokenLimit,
} from "../src/model-configuration.ts"

const roots: string[] = []

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
      provider: "custom-openai",
      modelId: "solver-model",
      baseUrl: "https://models.example.test/v1",
      contextWindow: 64_000,
      thinkingEnabled: true,
      reasoningEffort: "high",
      passthroughThinking: false,
      apiKey: "secret-key",
    })

    expect(view).toMatchObject({
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

    const disabledThinking = await configuration.update({
      provider: "custom-openai",
      modelId: "solver-model",
      baseUrl: "https://models.example.test/v1",
      contextWindow: 64_000,
      thinkingEnabled: false,
      reasoningEffort: "high",
      passthroughThinking: false,
    })
    expect(disabledThinking.supportedThinkingLevels).toContain("high")
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

    expect(configuration.snapshot().apiKeySource).toBe("secret-store")
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
      apiKeyConfigured: false,
      thinkingEnabled: true,
      reasoningEffort: "max",
      supportedThinkingLevels: [],
    })
    expect(() => configuration.createAgentOptions()).toThrow("未配置 Model ID")
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
      provider: "openai",
      modelId,
      baseUrl: "",
      contextWindow: 64_000,
      thinkingEnabled: true,
      reasoningEffort: "high",
      passthroughThinking: false,
    })

    expect(view).toMatchObject({
      configured: true,
      apiKeyConfigured: true,
      apiKeySource: "provider-credential",
    })
    expect(configuration.createAgentOptions()).toMatchObject({
      initialState: { model: { provider: "openai", id: modelId } },
    })
  })
})
