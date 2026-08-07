import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createFileSchedulerConfiguration } from "../src/domain/scheduler-config.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe("scheduler configuration", () => {
  it("uses the fallback and persists runtime concurrency changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctf-scheduler-config-"))
    roots.push(root)
    const storagePath = join(root, "scheduler-config.json")
    const configuration = await createFileSchedulerConfiguration({
      storagePath,
      fallback: 2,
    })

    expect(configuration.snapshot()).toBe(2)
    await configuration.update(5)
    expect(configuration.snapshot()).toBe(5)
    expect(JSON.parse(await readFile(storagePath, "utf8"))).toEqual({
      maxConcurrent: 5,
    })

    const reloaded = await createFileSchedulerConfiguration({
      storagePath,
      fallback: 1,
    })
    expect(reloaded.snapshot()).toBe(5)
    await expect(configuration.update(65)).rejects.toThrow("1–64")
  })

  it("falls back when the stored value is invalid", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctf-scheduler-config-"))
    roots.push(root)
    const storagePath = join(root, "scheduler-config.json")
    await writeFile(storagePath, JSON.stringify({ maxConcurrent: 0 }))
    const configuration = await createFileSchedulerConfiguration({
      storagePath,
      fallback: 3,
    })
    expect(configuration.snapshot()).toBe(3)
  })
})
