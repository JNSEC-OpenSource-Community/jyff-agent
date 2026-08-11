import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vite-plus/test"
import { ProjectConfigStore, projectStorageKey } from "../../src/control-plane/config-store.ts"
import type { ProjectConfig } from "../../src/project/config.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ctf-project-registry-"))
  roots.push(root)
  return root
}

function config(id: string, name = id): ProjectConfig {
  return {
    version: 1,
    project: { id, name },
    platform: { plugin: "test", config: {} },
    sandbox: { image: "solver", privileged: false, networkMode: "none" },
  }
}

describe("ProjectConfigStore", () => {
  it("注册多个 Project 时使用独立哈希状态目录并可分别更新", async () => {
    const root = await fixture()
    const store = new ProjectConfigStore(root)

    const first = await store.saveProject(config("spring-ctf", "Spring CTF"))
    const second = await store.saveProject(config("../unsafe", "Unsafe ID"))
    await store.saveProject(config("spring-ctf", "Spring CTF 2026"))

    expect(first.stateDirectory).toBe(join(root, ".ctf-agent"))
    expect(second.stateDirectory).toBe(
      join(root, ".ctf-agent", "projects", projectStorageKey("../unsafe")),
    )
    expect((await store.list()).map((item) => item.config.project)).toEqual([
      { id: "spring-ctf", name: "Spring CTF 2026" },
      { id: "../unsafe", name: "Unsafe ID" },
    ])
    await expect(
      access(join(second.stateDirectory, "project-config.json")),
    ).resolves.toBeUndefined()
    expect(await readFile(store.registryPath, "utf8")).not.toContain("../unsafe/")
  })

  it("保留注册表根 Project 的状态目录", async () => {
    const root = await fixture()
    await mkdir(join(root, ".ctf-agent"), { recursive: true })
    await writeFile(
      join(root, ".ctf-agent", "project-config.json"),
      JSON.stringify(config("legacy", "Legacy Project")),
    )
    await writeFile(
      join(root, ".ctf-agent", "project-registry.json"),
      JSON.stringify({
        version: 1,
        projects: [
          {
            id: "legacy",
            directory: ".",
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString(),
            archived: false,
          },
        ],
      }),
    )
    await writeFile(join(root, ".ctf-agent", "runs.sqlite"), "legacy-state")
    const store = new ProjectConfigStore(root)

    const [legacy] = await store.list()
    expect(legacy).toMatchObject({
      config: { project: { id: "legacy", name: "Legacy Project" } },
      stateDirectory: join(root, ".ctf-agent"),
      rootProject: true,
    })

    const updated = await store.saveProject(config("legacy", "Renamed"))
    expect(updated.stateDirectory).toBe(join(root, ".ctf-agent"))
    expect(await readFile(join(root, ".ctf-agent", "runs.sqlite"), "utf8")).toBe("legacy-state")
    expect((await store.load("legacy"))?.project.name).toBe("Renamed")
  })

  it("删除隔离 Project 时清理其状态目录并保留其他注册项", async () => {
    const root = await fixture()
    const store = new ProjectConfigStore(root)
    await store.saveProject(config("first"))
    const second = await store.saveProject(config("second"))
    await writeFile(join(second.stateDirectory, "runs.sqlite"), "state")

    await expect(store.deleteProject("second")).resolves.toMatchObject({
      config: { project: { id: "second" } },
    })
    await expect(access(second.stateDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    })
    expect((await store.list()).map((item) => item.config.project.id)).toEqual(["first"])
    await expect(store.deleteProject("missing")).resolves.toBeUndefined()
  })

  it("重置 Solver 数据时保留 Project 和运行配置", async () => {
    const root = await fixture()
    const store = new ProjectConfigStore(root)
    await store.saveProject(config("first"))
    const second = await store.saveProject(config("second"))
    await mkdir(join(second.stateDirectory, "runs", "run-1"), {
      recursive: true,
    })
    await mkdir(join(second.stateDirectory, "challenges", "web"), {
      recursive: true,
    })
    await writeFile(join(second.stateDirectory, "runs.sqlite"), "state")
    await writeFile(join(second.stateDirectory, "runtime-config.json"), "runtime")

    await store.resetProjectData("second")

    expect((await store.loadProject("second"))?.config.project.id).toBe("second")
    expect(await readFile(join(second.stateDirectory, "runtime-config.json"), "utf8")).toBe(
      "runtime",
    )
    for (const artifact of ["runs.sqlite", "runs", "challenges"]) {
      await expect(access(join(second.stateDirectory, artifact))).rejects.toMatchObject({
        code: "ENOENT",
      })
    }
    await expect(store.resetProjectData("missing")).rejects.toThrow("Project 不存在")
  })

  it("在服务端注册表持久化归档状态并兼容旧字段缺失", async () => {
    const root = await fixture()
    const store = new ProjectConfigStore(root)
    await store.saveProject(config("spring-ctf"))

    expect((await store.loadProject("spring-ctf"))?.archived).toBe(false)
    await expect(store.setArchived("spring-ctf", true)).resolves.toMatchObject({
      archived: true,
    })
    expect((await new ProjectConfigStore(root).list())[0]?.archived).toBe(true)

    const persisted = JSON.parse(await readFile(store.registryPath, "utf8"))
    delete persisted.projects[0].archived
    await writeFile(store.registryPath, JSON.stringify(persisted))
    expect((await new ProjectConfigStore(root).list())[0]?.archived).toBe(false)
    await expect(store.setArchived("missing", true)).rejects.toThrow("Project 不存在")
  })

  it("删除根 Project 时只清理项目状态并保留全局配置", async () => {
    const root = await fixture()
    const stateDirectory = join(root, ".ctf-agent")
    await mkdir(join(stateDirectory, "runs"), { recursive: true })
    await mkdir(join(stateDirectory, "challenges"), { recursive: true })
    await writeFile(join(stateDirectory, "project-config.json"), JSON.stringify(config("legacy")))
    await writeFile(
      join(stateDirectory, "project-registry.json"),
      JSON.stringify({
        version: 1,
        projects: [
          {
            id: "legacy",
            directory: ".",
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString(),
            archived: false,
          },
        ],
      }),
    )
    await writeFile(join(stateDirectory, "runtime-config.json"), "runtime")
    await writeFile(join(stateDirectory, "runs.sqlite"), "state")
    await writeFile(join(stateDirectory, "global-config.json"), "global")
    await writeFile(join(stateDirectory, "secrets.json"), "secrets")
    const store = new ProjectConfigStore(root)

    await store.deleteProject("legacy")

    expect(await store.list()).toEqual([])
    await expect(access(join(stateDirectory, "project-config.json"))).rejects.toMatchObject({
      code: "ENOENT",
    })
    await expect(access(join(stateDirectory, "runs.sqlite"))).rejects.toMatchObject({
      code: "ENOENT",
    })
    expect(await readFile(join(stateDirectory, "global-config.json"), "utf8")).toBe("global")
    expect(await readFile(join(stateDirectory, "secrets.json"), "utf8")).toBe("secrets")
  })
})
