import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentOptions } from "@earendil-works/pi-agent-core"
import { afterEach, describe, expect, it, vi } from "vite-plus/test"
import { FatherSessionManager } from "../../src/index.ts"

const roots: string[] = []
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
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
    expect((await FatherSessionManager.open(options)).get(created.id)?.title).toBe(created.title)
    const workspace = manager.workspace(created.id)
    await manager.delete(created.id)
    expect(manager.get(created.id)).toBeUndefined()
    await expect(access(workspace)).rejects.toThrow()
  })

  it("重启时回收异常中断 Father 的遗留 Docker Sandbox", async () => {
    const root = await mkdtemp(join(tmpdir(), "father-orphan-"))
    roots.push(root)
    const options = {
      root,
      image: "unused",
      createAgentOptions: () =>
        ({
          initialState: { model: { provider: "test", id: "model" } },
        }) as AgentOptions,
      sandboxFactory: vi.fn(async () => ({ close: vi.fn() })) as never,
    }
    const manager = await FatherSessionManager.open(options)
    const created = await manager.create({ createdBy: "nick" })
    const indexPath = join(root, ".ctf-agent", "father", "sessions.json")
    const records = JSON.parse(await readFile(indexPath, "utf8")) as Array<{
      id: string
      status: string
    }>
    if (!records[0]) throw new Error("Father 测试记录未持久化")
    records[0].status = "running"
    await writeFile(indexPath, JSON.stringify(records))

    const removeManagedSandboxes = vi.fn(async (_runIds: readonly string[]) => undefined)
    const restarted = await FatherSessionManager.open({
      ...options,
      removeManagedSandboxes,
    })

    expect(removeManagedSandboxes).toHaveBeenCalledWith([created.id.slice("father-".length)])
    expect(restarted.get(created.id)?.status).toBe("stopped")
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

    const stopped = await manager.stop(session.id)
    expect(fakeAgent.close).toHaveBeenCalledOnce()
    expect(stopped.status).toBe("stopped")
    await expect(access(manager.workspace(session.id))).resolves.toBeUndefined()
  })

  it("验证结果抵达空闲 Father 时启动新的 prompt", async () => {
    const root = await mkdtemp(join(tmpdir(), "father-validation-notice-"))
    roots.push(root)
    const promptOrSteer = vi.fn(async () => undefined)
    const fakeAgent = {
      state: { isStreaming: false },
      prompt: vi.fn(async () => undefined),
      promptOrSteer,
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
    await manager.notifyValidation(session.id, {
      status: "failed",
      pluginId: "example",
    } as never)

    expect(promptOrSteer).toHaveBeenCalledWith(
      expect.stringContaining("<plugin_validation_result>"),
    )
    expect(fakeAgent.steer).not.toHaveBeenCalled()
  })

  it("每个 Father 工作回合结束后回收 sandbox，并在修复时按需重建", async () => {
    const root = await mkdtemp(join(tmpdir(), "father-recycle-"))
    roots.push(root)
    const prompts: Array<() => void> = []
    const sandboxFactory = vi.fn(async () => ({ close: vi.fn() }))
    const agents: Array<{
      close: ReturnType<typeof vi.fn>
    }> = []
    const manager = await FatherSessionManager.open({
      root,
      image: "unused",
      createAgentOptions: () =>
        ({
          initialState: { model: { provider: "test", id: "model" } },
        }) as AgentOptions,
      sandboxFactory: sandboxFactory as never,
      agentFactory: vi.fn(async () => {
        let finish: (() => void) | undefined
        const agent = {
          state: { isStreaming: false },
          prompt: vi.fn(
            () =>
              new Promise<void>((resolve) => {
                finish = resolve
              }),
          ),
          steer: vi.fn(),
          close: vi.fn(async () => undefined),
          subscribe: vi.fn(),
        }
        agents.push(agent)
        prompts.push(() => finish?.())
        return agent
      }) as never,
    })
    const session = await manager.create({ createdBy: "nick" })

    await manager.send(session.id, "制作插件")
    expect(sandboxFactory).toHaveBeenCalledTimes(1)
    prompts[0]?.()
    await vi.waitFor(() => expect(agents[0]?.close).toHaveBeenCalledOnce())
    expect(manager.get(session.id)?.status).toBe("stopped")

    await manager.send(session.id, "修复验证失败的问题")
    expect(sandboxFactory).toHaveBeenCalledTimes(2)
    prompts[1]?.()
    await vi.waitFor(() => expect(agents[1]?.close).toHaveBeenCalledOnce())
  })

  it("启动 Father 前将内置 skill 复制到 sandbox workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "father-skill-"))
    roots.push(root)
    const skillDirectory = join(root, "extension-authoring")
    const skillPath = join(skillDirectory, "SKILL.md")
    await mkdir(join(skillDirectory, "references"), { recursive: true })
    await writeFile(
      skillPath,
      [
        "---",
        "name: extension-authoring",
        "description: Build platform extensions",
        "---",
        "# Extension authoring",
      ].join("\n"),
    )
    await writeFile(
      join(skillDirectory, "references", "platform-contract.md"),
      "# Platform contract",
    )
    await writeFile(
      join(skillDirectory, "references", "platform-contract.d.ts"),
      "export interface PlatformPlugin { readonly id: string }",
    )
    const fakeAgent = {
      state: { isStreaming: false },
      prompt: vi.fn(async () => undefined),
      steer: vi.fn(),
      close: vi.fn(async () => undefined),
      subscribe: vi.fn(),
    }
    const agentFactory = vi.fn(async () => fakeAgent)
    const manager = await FatherSessionManager.open({
      root,
      image: "unused",
      createAgentOptions: () =>
        ({
          initialState: { model: { provider: "test", id: "model" } },
        }) as AgentOptions,
      skills: [
        {
          name: "extension-authoring",
          description: "Build platform extensions",
          content: "# Extension authoring",
          filePath: skillPath,
          baseDir: skillDirectory,
        },
      ],
      sandboxFactory: vi.fn(async () => ({ close: vi.fn() })) as never,
      agentFactory: agentFactory as never,
    })

    const session = await manager.create({ createdBy: "nick" })
    await manager.send(session.id, "创建插件")

    expect(agentFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        skills: [
          expect.objectContaining({
            name: "extension-authoring",
            filePath: "/workspace/.skills/skill-1/SKILL.md",
          }),
        ],
      }),
    )
    expect(
      await readFile(join(manager.workspace(session.id), ".skills", "skill-1", "SKILL.md"), "utf8"),
    ).toContain("# Extension authoring")
    expect(
      await readFile(
        join(
          manager.workspace(session.id),
          ".skills",
          "skill-1",
          "references",
          "platform-contract.md",
        ),
        "utf8",
      ),
    ).toBe("# Platform contract")
    expect(
      await readFile(
        join(manager.workspace(session.id), "node_modules", "@ctf-agent", "platform", "index.d.ts"),
        "utf8",
      ),
    ).toContain("interface PlatformPlugin")
  })
})
