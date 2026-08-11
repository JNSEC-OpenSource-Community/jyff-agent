import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vite-plus/test"
import { FileSecretStore, MemorySecretStore } from "../../src/control-plane/secret-store.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function secretPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ctf-secret-store-"))
  roots.push(root)
  await mkdir(join(root, "nested"), { recursive: true })
  return join(root, "nested", "secrets.json")
}

describe("FileSecretStore", () => {
  it("persists namespaced secrets, removes blank values, and restores only retained keys", async () => {
    const path = await secretPath()
    const store = await FileSecretStore.open(path)
    await store.set({
      PROJECT_ALPHA_TOKEN: "alpha-secret",
      PROJECT_BETA_TOKEN: "beta-secret",
    })
    await store.set({ PROJECT_ALPHA_TOKEN: "", PROJECT_GAMMA_TOKEN: "gamma" })

    const restored = await FileSecretStore.open(path)
    expect(restored.get("PROJECT_ALPHA_TOKEN")).toBeUndefined()
    expect(restored.has("PROJECT_BETA_TOKEN")).toBe(true)
    expect(restored.get("PROJECT_GAMMA_TOKEN")).toBe("gamma")
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      PROJECT_BETA_TOKEN: "beta-secret",
      PROJECT_GAMMA_TOKEN: "gamma",
    })
  })

  it("rejects malformed persisted data instead of silently dropping credentials", async () => {
    const path = await secretPath()
    await writeFile(path, JSON.stringify({ PROJECT_ALPHA_TOKEN: 42 }))

    await expect(FileSecretStore.open(path)).rejects.toThrow("不是字符串")
  })
})

describe("MemorySecretStore", () => {
  it("rejects invalid names without changing retained credentials", async () => {
    const store = new MemorySecretStore({ PROJECT_TOKEN: "kept" })

    await expect(store.set({ "project-token": "invalid" })).rejects.toThrow("Secret 名称无效")
    expect(store.get("PROJECT_TOKEN")).toBe("kept")
  })
})
