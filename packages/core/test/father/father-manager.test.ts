import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentOptions } from "@earendil-works/pi-agent-core"
import { afterEach, describe, expect, it } from "vitest"
import { FatherSessionManager } from "../../src/index.ts"

const roots: string[] = []
afterEach(async () =>
  Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  ),
)

describe("FatherSessionManager", () => {
  it("无表单创建随机命名的空白 Session 并持久化", async () => {
    const root = await mkdtemp(join(tmpdir(), "father-session-"))
    roots.push(root)
    const options = {
      root,
      image: "unused",
      createAgentOptions: () =>
        ({
          initialState: { model: { provider: "test", id: "model" } },
        }) as AgentOptions,
    }
    const manager = await FatherSessionManager.open(options)
    const created = await manager.create({ createdBy: "nick" })

    expect(created.title).toMatch(/^[a-z]+-[a-z]+$/)
    expect(created.pluginId).toBeUndefined()
    expect(created.status).toBe("draft")
    expect(
      (await FatherSessionManager.open(options)).get(created.id)?.title,
    ).toBe(created.title)
  })
})
