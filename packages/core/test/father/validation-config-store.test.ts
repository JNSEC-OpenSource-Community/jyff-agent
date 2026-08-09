import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  FatherValidationConfigStore,
  MemorySecretStore,
} from "../../src/index.ts"

const roots: string[] = []
afterEach(async () =>
  Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  ),
)

describe("FatherValidationConfigStore", () => {
  it("复用相同 schema 的配置并把密钥留在 SecretStore", async () => {
    const root = await mkdtemp(join(tmpdir(), "father-config-"))
    roots.push(root)
    const secrets = new MemorySecretStore()
    const store = new FatherValidationConfigStore(root, secrets)
    await store.save({
      sessionId: "father-1",
      schemaFingerprint: "schema-a",
      config: { baseUrl: "https://example.test" },
      secrets: { TOKEN: "secret-value" },
      secretNames: ["TOKEN"],
    })

    const saved = await store.read("father-1", "schema-a")
    expect(saved?.config).toEqual({ baseUrl: "https://example.test" })
    expect(saved?.configuredSecrets.TOKEN).toEqual({ configured: true })
    expect(saved?.secrets.TOKEN).toBe("secret-value")
    expect(await store.read("father-1", "schema-b")).toBeUndefined()
  })
})
