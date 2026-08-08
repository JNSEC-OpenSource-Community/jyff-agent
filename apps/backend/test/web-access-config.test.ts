import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MemorySecretStore, webAccessSecretName } from "@ctf-agent/core"
import { afterEach, describe, expect, it } from "vitest"
import { createFileWebAccessConfiguration } from "../src/domain/web-access-config.ts"

describe("web-access 配置服务", () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    )
  })

  async function open() {
    const root = await mkdtemp(join(tmpdir(), "ctf-web-access-"))
    roots.push(root)
    const secretStore = new MemorySecretStore()
    const configuration = await createFileWebAccessConfiguration({
      storagePath: join(root, "web-access.json"),
      secretStore,
    })
    return { configuration, secretStore, root }
  }

  it("初始为空：禁用、无 provider、密钥均未配置", async () => {
    const { configuration } = await open()
    const snapshot = await configuration.snapshot()
    expect(snapshot.enabled).toBe(false)
    expect(snapshot.providers.length).toBeGreaterThan(0)
    expect(snapshot.providers.every((p) => p.configured === false)).toBe(true)
  })

  it("setProviderKey 后 snapshot 标记 configured，但绝不泄漏密钥值", async () => {
    const { configuration, secretStore } = await open()
    await configuration.setProviderKey("brave", "super-secret-token")

    const snapshot = await configuration.snapshot()
    const brave = snapshot.providers.find((p) => p.id === "brave")
    expect(brave?.configured).toBe(true)

    // 密钥值只应存在于 SecretStore，不在任何 HTTP 视图中。
    const serialized = JSON.stringify(snapshot)
    expect(serialized).not.toContain("super-secret-token")
    expect(secretStore.get(webAccessSecretName("brave"))).toBe(
      "super-secret-token",
    )
  })

  it("setProviderKey 空值删除密钥", async () => {
    const { configuration, secretStore } = await open()
    await configuration.setProviderKey("gemini", "k1")
    expect(secretStore.has(webAccessSecretName("gemini"))).toBe(true)
    await configuration.setProviderKey("gemini", undefined)
    expect(secretStore.has(webAccessSecretName("gemini"))).toBe(false)
  })

  it("update 持久化 enabled/providers/workflow/ssrf", async () => {
    const { configuration } = await open()
    await configuration.update({
      enabled: true,
      providers: ["brave", "gemini"],
      workflow: "auto-summary",
      summaryModel: { provider: "anthropic", id: "claude-haiku-4-5" },
      ssrf: { allowRanges: ["10.0.0.0/8"], trustEnvProxy: true },
    })
    const snapshot = await configuration.snapshot()
    expect(snapshot.enabled).toBe(true)
    // providers 视图列出全部候选；enabled 子集即选中的 allowlist。
    expect(
      snapshot.providers.filter((p) => p.enabled).map((p) => p.id),
    ).toEqual(["brave", "gemini"])
    expect(snapshot.workflow).toBe("auto-summary")
    expect(snapshot.summaryModel).toEqual({
      provider: "anthropic",
      id: "claude-haiku-4-5",
    })
    expect(snapshot.ssrf).toEqual({
      allowRanges: ["10.0.0.0/8"],
      trustEnvProxy: true,
    })
  })

  it("未知 provider 拒绝写入", async () => {
    const { configuration } = await open()
    await expect(
      configuration.setProviderKey("not-a-provider", "k"),
    ).rejects.toThrow()
    await expect(
      configuration.update({ providers: ["not-a-provider"] }),
    ).rejects.toThrow()
  })

  it("projectSnapshot 返回 Project 注入所需的完整配置", async () => {
    const { configuration } = await open()
    await configuration.update({
      enabled: true,
      providers: ["brave"],
      workflow: "none",
      ssrf: { allowRanges: [], trustEnvProxy: false },
    })
    const snapshot = await configuration.projectSnapshot()
    expect(snapshot.enabled).toBe(true)
    expect(snapshot.providers).toEqual(["brave"])
    expect(snapshot.timeouts.fetchMs).toBeGreaterThan(0)
  })
})
