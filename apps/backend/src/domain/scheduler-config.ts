import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

export interface SchedulerConfiguration {
  snapshot(): number
  update(maxConcurrent: number): Promise<number>
}

export async function createFileSchedulerConfiguration(options: {
  storagePath: string
  fallback: number
}): Promise<SchedulerConfiguration> {
  validateMaxConcurrent(options.fallback)
  let current = options.fallback
  try {
    const parsed = JSON.parse(await readFile(options.storagePath, "utf8")) as {
      maxConcurrent?: unknown
    }
    validateMaxConcurrent(parsed.maxConcurrent)
    current = Number(parsed.maxConcurrent)
  } catch (error) {
    if (!hasCode(error, "ENOENT")) {
      console.warn(
        `无法读取调度配置 ${options.storagePath}：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  return {
    snapshot: () => current,
    update: async (maxConcurrent) => {
      validateMaxConcurrent(maxConcurrent)
      await persist(options.storagePath, maxConcurrent)
      current = maxConcurrent
      return current
    },
  }
}

async function persist(path: string, maxConcurrent: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify({ maxConcurrent }, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    })
    await rename(temporary, path)
    await chmod(path, 0o600)
  } finally {
    await rm(temporary, { force: true })
  }
}

function validateMaxConcurrent(value: unknown): void {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 64) {
    throw new Error("maxConcurrent 必须是 1–64 的整数")
  }
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code
}
