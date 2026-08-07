import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  ProjectConfigStore,
  projectStorageKey,
} from "../../src/control-plane/config-store.ts"
import type { ProjectConfig } from "../../src/project/config.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
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
    expect(await readFile(store.registryPath, "utf8")).not.toContain(
      "../unsafe/",
    )
  })

  it("把旧单 Project 映射到原状态目录以保留 RunStore 和 workspace", async () => {
    const root = await fixture()
    await mkdir(join(root, ".ctf-agent"), { recursive: true })
    await writeFile(
      join(root, ".ctf-agent", "project-config.json"),
      JSON.stringify(config("legacy", "Legacy Project")),
    )
    await writeFile(join(root, ".ctf-agent", "runs.sqlite"), "legacy-state")
    const store = new ProjectConfigStore(root)

    const [legacy] = await store.list()
    expect(legacy).toMatchObject({
      config: { project: { id: "legacy", name: "Legacy Project" } },
      stateDirectory: join(root, ".ctf-agent"),
      legacy: true,
    })

    const updated = await store.saveProject(config("legacy", "Renamed"))
    expect(updated.stateDirectory).toBe(join(root, ".ctf-agent"))
    expect(
      await readFile(join(root, ".ctf-agent", "runs.sqlite"), "utf8"),
    ).toBe("legacy-state")
    expect((await store.load("legacy"))?.project.name).toBe("Renamed")
  })
})
