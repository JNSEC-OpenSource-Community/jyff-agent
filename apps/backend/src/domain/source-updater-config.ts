import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import type { SecretStore } from "@ctf-agent/core"
import { DEFAULT_SOURCE_REPOSITORY } from "./build-identity.ts"

export const SOURCE_UPDATER_PLUGIN_ID = "github-source-updater" as const
export const GITHUB_SOURCE_UPDATER_TOKEN = "CTF_GITHUB_UPDATER_TOKEN" as const

export type SourceUpdateChannel = { kind: "release" } | { kind: "branch"; ref: string }
export type SourceUpdateApplyPolicy = "when-idle" | "maintenance-window"

export interface SourceUpdaterConfigurationView {
  enabled: boolean
  repository: string
  channel: SourceUpdateChannel
  automaticCheck: boolean
  intervalMinutes: number
  automaticApply: boolean
  applyPolicy: SourceUpdateApplyPolicy
  githubTokenConfigured: boolean
}

export interface SourceUpdaterConfigurationUpdate {
  enabled?: boolean
  repository?: string
  channel?: SourceUpdateChannel
  automaticCheck?: boolean
  intervalMinutes?: number
  automaticApply?: boolean
  applyPolicy?: SourceUpdateApplyPolicy
}

export interface SourceUpdaterConfiguration {
  snapshot(): SourceUpdaterConfigurationView
  current(): {
    enabled: boolean
    repository: string
    channel: SourceUpdateChannel
    automaticCheck: boolean
    intervalMinutes: number
    automaticApply: boolean
    applyPolicy: SourceUpdateApplyPolicy
  }
  update(input: SourceUpdaterConfigurationUpdate): Promise<SourceUpdaterConfigurationView>
  setGitHubToken(token: string | undefined): Promise<void>
}

interface StoredSourceUpdaterConfiguration {
  version: 1
  enabled: boolean
  repository: string
  channel: SourceUpdateChannel
  automaticCheck: boolean
  intervalMinutes: number
  automaticApply: boolean
  applyPolicy: SourceUpdateApplyPolicy
}

export async function createFileSourceUpdaterConfiguration(options: {
  storagePath: string
  secretStore: SecretStore
  repository?: string
}): Promise<SourceUpdaterConfiguration> {
  const allowedRepository = normalizeRepository(options.repository ?? DEFAULT_SOURCE_REPOSITORY)
  let configuration = await readConfiguration(options.storagePath, allowedRepository)

  function current() {
    return {
      enabled: configuration.enabled,
      repository: configuration.repository,
      channel: cloneChannel(configuration.channel),
      automaticCheck: configuration.automaticCheck,
      intervalMinutes: configuration.intervalMinutes,
      automaticApply: configuration.automaticApply,
      applyPolicy: configuration.applyPolicy,
    }
  }

  function snapshot(): SourceUpdaterConfigurationView {
    return {
      ...current(),
      githubTokenConfigured: options.secretStore.has(GITHUB_SOURCE_UPDATER_TOKEN),
    }
  }

  return {
    snapshot,
    current,
    async update(input) {
      const next: StoredSourceUpdaterConfiguration = {
        version: 1,
        enabled: input.enabled === undefined ? configuration.enabled : input.enabled,
        repository:
          input.repository === undefined
            ? configuration.repository
            : normalizeAllowedRepository(input.repository, allowedRepository),
        channel:
          input.channel === undefined ? configuration.channel : normalizeChannel(input.channel),
        automaticCheck:
          input.automaticCheck === undefined ? configuration.automaticCheck : input.automaticCheck,
        intervalMinutes:
          input.intervalMinutes === undefined
            ? configuration.intervalMinutes
            : normalizeInterval(input.intervalMinutes),
        automaticApply:
          input.automaticApply === undefined ? configuration.automaticApply : input.automaticApply,
        applyPolicy:
          input.applyPolicy === undefined ? configuration.applyPolicy : input.applyPolicy,
      }
      if (next.automaticApply && next.channel.kind !== "release") {
        throw new Error("自动应用只支持经过验证的 GitHub Release 通道")
      }
      configuration = next
      await persist(options.storagePath, next)
      return snapshot()
    },
    async setGitHubToken(token) {
      await options.secretStore.set({
        [GITHUB_SOURCE_UPDATER_TOKEN]: token?.trim() || undefined,
      })
    },
  }
}

async function readConfiguration(
  path: string,
  repository: string,
): Promise<StoredSourceUpdaterConfiguration> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(path, "utf8"))
  } catch (error) {
    if (hasCode(error, "ENOENT")) return defaultConfiguration(repository)
    throw new Error(`无法读取 GitHub 源码更新配置: ${path}`, { cause: error })
  }
  if (!isRecord(parsed) || parsed.version !== 1) {
    throw new Error(`GitHub 源码更新配置格式无效: ${path}`)
  }
  const storedRepository = normalizeAllowedRepository(parsed.repository, repository)
  const channel = normalizeChannel(parsed.channel)
  const automaticApply = booleanValue(parsed.automaticApply, false)
  if (automaticApply && channel.kind !== "release") {
    throw new Error("自动应用只支持经过验证的 GitHub Release 通道")
  }
  return {
    version: 1,
    enabled: booleanValue(parsed.enabled, false),
    repository: storedRepository,
    channel,
    automaticCheck: booleanValue(parsed.automaticCheck, true),
    intervalMinutes: normalizeInterval(parsed.intervalMinutes ?? 360),
    automaticApply,
    applyPolicy: normalizeApplyPolicy(parsed.applyPolicy),
  }
}

function defaultConfiguration(repository: string): StoredSourceUpdaterConfiguration {
  return {
    version: 1,
    enabled: false,
    repository,
    channel: { kind: "branch", ref: "main" },
    automaticCheck: true,
    intervalMinutes: 360,
    automaticApply: false,
    applyPolicy: "when-idle",
  }
}

function normalizeRepository(value: string): string {
  const normalized = value
    .trim()
    .replace(/^https?:\/\/github\.com\//iu, "")
    .replace(/\.git$/iu, "")
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(normalized)) {
    throw new Error("GitHub repository 必须使用 owner/repository 格式")
  }
  return normalized
}

function normalizeAllowedRepository(value: unknown, allowed: string): string {
  if (typeof value !== "string" || normalizeRepository(value) !== allowed) {
    throw new Error(`只允许更新受信仓库: ${allowed}`)
  }
  return allowed
}

function normalizeChannel(value: unknown): SourceUpdateChannel {
  if (!isRecord(value) || (value.kind !== "release" && value.kind !== "branch")) {
    throw new Error("GitHub 更新通道必须是 release 或 branch")
  }
  if (value.kind === "release") return { kind: "release" }
  if (typeof value.ref !== "string") throw new Error("branch 更新通道缺少 ref")
  const ref = value.ref.trim()
  if (!ref || ref.length > 128 || ref.includes("..") || ref.startsWith("/") || ref.endsWith("/")) {
    throw new Error("GitHub branch/ref 无效")
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(ref)) throw new Error("GitHub branch/ref 包含非法字符")
  return { kind: "branch", ref }
}

function normalizeInterval(value: unknown): number {
  const interval = Number(value)
  if (!Number.isInteger(interval) || interval < 15 || interval > 1_440) {
    throw new Error("自动检查间隔必须是 15–1440 分钟的整数")
  }
  return interval
}

function normalizeApplyPolicy(value: unknown): SourceUpdateApplyPolicy {
  if (value === "when-idle" || value === "maintenance-window") return value
  if (value === undefined) return "when-idle"
  throw new Error("自动应用策略无效")
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback
}

function cloneChannel(channel: SourceUpdateChannel): SourceUpdateChannel {
  return channel.kind === "release" ? { kind: "release" } : { kind: "branch", ref: channel.ref }
}

async function persist(
  path: string,
  configuration: StoredSourceUpdaterConfiguration,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(configuration, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    })
    try {
      await rename(temporary, path)
    } catch (error) {
      if (!isReplaceRenameError(error)) throw error
      await rm(path, { force: true })
      await rename(temporary, path)
    }
    await chmod(path, 0o600)
  } finally {
    await rm(temporary, { force: true })
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isReplaceRenameError(error: unknown): boolean {
  return hasCode(error, "EPERM") || hasCode(error, "EEXIST") || hasCode(error, "ENOTEMPTY")
}

function hasCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code
}
