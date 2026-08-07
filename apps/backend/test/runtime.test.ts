import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createFileProjectRuntimeConfiguration } from "../src/domain/runtime.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ctf-project-runtime-config-"))
  roots.push(root)
  return join(root, "runtime-config.json")
}

describe("ProjectRuntimeConfiguration", () => {
  it("按 Project 持久化 Agent 模型绑定和并发量", async () => {
    const storagePath = await fixture()
    const options = {
      storagePath,
      fallback: {
        solverModelId: "solver",
        tldrModelId: "solver",
        subagentModels: {},
        maxConcurrent: 8,
      },
      availableModelIds: () => new Set(["solver", "worker"]),
    }
    const configuration = await createFileProjectRuntimeConfiguration(options)
    expect(configuration.snapshot()).toMatchObject({
      solverModelId: "solver",
      maxConcurrent: 8,
    })

    await configuration.update({
      solverModelId: "worker",
      tldrModelId: "solver",
      subagentModels: { explorer: "worker" },
      maxConcurrent: 3,
    })
    expect(JSON.parse(await readFile(storagePath, "utf8"))).toMatchObject({
      version: 1,
      solverModelId: "worker",
      maxConcurrent: 3,
    })
    expect(
      (await createFileProjectRuntimeConfiguration(options)).snapshot(),
    ).toEqual(configuration.snapshot())
  })

  it("拒绝不存在的模型和越界并发量且不污染当前值", async () => {
    const configuration = await createFileProjectRuntimeConfiguration({
      storagePath: await fixture(),
      fallback: {
        solverModelId: "solver",
        tldrModelId: "solver",
        subagentModels: {},
        maxConcurrent: 8,
      },
      availableModelIds: () => new Set(["solver"]),
    })
    await expect(
      configuration.update({
        solverModelId: "missing",
        tldrModelId: "solver",
        subagentModels: {},
        maxConcurrent: 8,
      }),
    ).rejects.toThrow("Solver 模型不存在")
    await expect(
      configuration.update({
        solverModelId: "solver",
        tldrModelId: "solver",
        subagentModels: {},
        maxConcurrent: 65,
      }),
    ).rejects.toThrow("maxConcurrent 必须是 1–64")
    expect(configuration.snapshot().solverModelId).toBe("solver")
  })
})
