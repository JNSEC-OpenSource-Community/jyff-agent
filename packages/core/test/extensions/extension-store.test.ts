import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PlatformPluginRegistry } from "@ctf-agent/platform"
import { afterEach, describe, expect, it } from "vitest"
import { PlatformExtensionStore } from "../../src/index.ts"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe("PlatformExtensionStore", () => {
  it("仅激活通过 Gate 且内容未变化的 revision", async () => {
    const root = await mkdtemp(join(tmpdir(), "extension-store-"))
    roots.push(root)
    const candidate = join(root, "candidate")
    await mkdir(candidate)
    await writeFile(
      join(candidate, "extension.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: "demo-platform",
        name: "Demo",
        version: "1.0.0",
        entry: "index.mjs",
      }),
    )
    await writeFile(join(candidate, "index.mjs"), candidateSource())
    const registry = new PlatformPluginRegistry([])
    const store = await PlatformExtensionStore.open({ root, registry })
    const profile = {
      id: "profile",
      project: { id: "test", name: "Test" },
      config: {},
    }

    const report = await store.validate({
      sessionId: "father-1",
      candidateDirectory: candidate,
      profile,
    })
    expect(report.status).toBe("read_only_verified")
    await writeFile(join(candidate, "README.md"), "changed")
    await expect(
      store.activate({ sessionId: "father-1", candidateDirectory: candidate }),
    ).rejects.toThrow("发生变化")

    await store.validate({
      sessionId: "father-1",
      candidateDirectory: candidate,
      profile,
    })
    const activated = await store.activate({
      sessionId: "father-1",
      candidateDirectory: candidate,
    })
    expect(activated.authorSessionId).toBe("father-1")
    expect(
      registry.list().find(({ plugin }) => plugin.id === "demo-platform")
        ?.source,
    ).toBe("extension")
  })
})

function candidateSource(): string {
  return `
const overview = { id: "contest", name: "Contest", challenges: 1, announcements: 0 };
export const platformPlugin = {
  id: "demo-platform",
  config: { parse: value => value },
  async connect() { return {
    async refresh() { return overview }, async getOverview() { return overview },
    async listChallenges() { return [{ id: "web-1", title: "Web", category: "web", score: 100 }] },
    async listAnnouncements() { return [] }, async listRemoteEnvironments() { return [] },
    async getRemoteEnvironment() { return null }, async destroyRemoteEnvironment() {},
    async bindChallenge(id) { return { async getInfo() { return { id, title: "Web", category: "web", score: 100, description: "test", attachments: [] } }, async downloadAttachment() {}, async submitFlag() { return { status: "rejected" } } } },
    async close() {}
  } }
}`
}
