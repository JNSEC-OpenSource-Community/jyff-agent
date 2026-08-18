import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

/**
 * ShellPoop 反弹 shell 插件的持久化全局配置。
 *
 * ShellPoop 服务本身无鉴权，因此这里只有地址与超时，不需要 SecretStore。
 * 配置持久化到 <stateDirectory>/shellpoop.json（0600，原子写）。
 */

interface StoredShellPoopConfiguration {
  version: 1
  enabled: boolean
  baseUrl: string
  timeoutMs?: number
}

export interface ShellPoopConfigurationView {
  enabled: boolean
  baseUrl: string
  timeoutMs?: number
}

export interface ShellPoopConfiguration {
  snapshot(): Promise<ShellPoopConfigurationView>
  update(input: {
    enabled?: boolean
    baseUrl?: string
    timeoutMs?: number
  }): Promise<ShellPoopConfigurationView>
  /** 返回 Project 注入工具时使用的完整配置。 */
  projectSnapshot(): Promise<{ enabled: boolean; baseUrl: string; timeoutMs: number }>
}

function emptyConfiguration(): StoredShellPoopConfiguration {
  return { version: 1, enabled: false, baseUrl: "http://127.0.0.1:8000" }
}

function isStoredConfiguration(value: unknown): value is StoredShellPoopConfiguration {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const config = value as Record<string, unknown>
  if (config.version !== 1) return false
  if (typeof config.enabled !== "boolean") return false
  return typeof config.baseUrl === "string"
}

function normalizeBaseUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("baseUrl 必须是字符串")
  const trimmed = value.trim().replace(/\/+$/, "")
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error("baseUrl 必须是 http(s):// 地址")
  }
  return trimmed
}

function normalizeTimeoutMs(value: unknown): number | undefined {
  if (value === undefined) return undefined
  const timeout = Number(value)
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("timeoutMs 必须是正数")
  return Math.round(timeout)
}

export async function createFileShellPoopConfiguration(options: {
  storagePath: string
}): Promise<ShellPoopConfiguration> {
  let configuration: StoredShellPoopConfiguration
  try {
    const parsed: unknown = JSON.parse(await readFile(options.storagePath, "utf8"))
    if (isStoredConfiguration(parsed)) {
      configuration = {
        version: 1,
        enabled: parsed.enabled,
        baseUrl: normalizeBaseUrl(parsed.baseUrl),
        ...(parsed.timeoutMs !== undefined
          ? { timeoutMs: normalizeTimeoutMs(parsed.timeoutMs) }
          : {}),
      }
    } else {
      configuration = emptyConfiguration()
    }
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      configuration = emptyConfiguration()
    } else {
      throw new Error(`无法读取 shellpoop 配置: ${options.storagePath}`, {
        cause: error,
      })
    }
  }

  async function persist(value: StoredShellPoopConfiguration): Promise<void> {
    await mkdir(dirname(options.storagePath), { recursive: true, mode: 0o700 })
    const temporary = `${options.storagePath}.${process.pid}.${Date.now()}.tmp`
    try {
      await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      })
      await rename(temporary, options.storagePath)
      await chmod(options.storagePath, 0o600)
    } finally {
      await rm(temporary, { force: true })
    }
  }

  function toView(value: StoredShellPoopConfiguration): ShellPoopConfigurationView {
    return {
      enabled: value.enabled,
      baseUrl: value.baseUrl,
      ...(value.timeoutMs !== undefined ? { timeoutMs: value.timeoutMs } : {}),
    }
  }

  return {
    async snapshot() {
      return toView(configuration)
    },

    async update(input) {
      const next: StoredShellPoopConfiguration = {
        version: 1,
        enabled: input.enabled === undefined ? configuration.enabled : Boolean(input.enabled),
        baseUrl:
          input.baseUrl === undefined ? configuration.baseUrl : normalizeBaseUrl(input.baseUrl),
        ...(input.timeoutMs === undefined
          ? configuration.timeoutMs !== undefined
            ? { timeoutMs: configuration.timeoutMs }
            : {}
          : { timeoutMs: normalizeTimeoutMs(input.timeoutMs) }),
      }
      configuration = next
      await persist(next)
      return toView(next)
    },

    async projectSnapshot() {
      return {
        enabled: configuration.enabled,
        baseUrl: configuration.baseUrl,
        timeoutMs: configuration.timeoutMs ?? 15_000,
      }
    },
  }
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  )
}
