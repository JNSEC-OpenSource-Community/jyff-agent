import { access, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentOptions } from "@earendil-works/pi-agent-core"
import { afterEach, describe, expect, it, vi } from "vitest"
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
    const workspace = manager.workspace(created.id)
    await manager.delete(created.id)
    expect(manager.get(created.id)).toBeUndefined()
    await expect(access(workspace)).rejects.toThrow()
  })

  it("空闲时启动 prompt 而不是只把指令加入队列", async () => {
    const root = await mkdtemp(join(tmpdir(), "father-turn-"))
    roots.push(root)
    const prompt = vi.fn(async () => undefined)
    const fakeAgent = {
      state: { isStreaming: false },
      prompt,
      steer: vi.fn(),
      close: vi.fn(async () => undefined),
      subscribe: vi.fn(),
    }
    const manager = await FatherSessionManager.open({
      root,
      image: "unused",
      createAgentOptions: () =>
        ({
          initialState: { model: { provider: "test", id: "model" } },
        }) as AgentOptions,
      sandboxFactory: vi.fn(async () => ({ close: vi.fn() })) as never,
      agentFactory: vi.fn(async () => fakeAgent) as never,
    })
    const session = await manager.create({ createdBy: "nick" })
    await manager.send(session.id, "开始工作")
    expect(prompt).toHaveBeenCalledWith("开始工作")
    expect(fakeAgent.steer).not.toHaveBeenCalled()
  })
})
