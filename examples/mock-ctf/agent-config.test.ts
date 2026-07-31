import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { loadModelEnvironment } from "./agent-config.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })))
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
      apiKey: "secret-key",
    })

    expect(view).toMatchObject({
      configured: true,
      apiKeyConfigured: true,
      apiKeySource: "webui",
    })
    expect(JSON.stringify(view)).not.toContain("secret-key")
    expect(await readFile(storagePath, "utf8")).toContain("secret-key")

    const reloaded = loadModelEnvironment({ storagePath })
    expect(reloaded.snapshot()).toEqual(view)
  })
})
