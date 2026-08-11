import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import type {
  AgentModelBindings,
  DashboardProjectRuntimeConfiguration,
  ProjectRuntimeConfigurationView,
} from "../types.ts"

interface StoredProjectRuntimeConfiguration extends AgentModelBindings {
  version: 1
  maxConcurrent: number
  maxRemoteEnvironments: number
}

export async function createFileProjectRuntimeConfiguration(options: {
  storagePath: string
  fallback: ProjectRuntimeConfigurationView
  availableModelIds: () => ReadonlySet<string>
}): Promise<DashboardProjectRuntimeConfiguration> {
  const stored = await readConfiguration(options.storagePath, options.fallback)
  validateConfiguration(stored, options.availableModelIds())
  let current = stored
  return {
    snapshot: () => publicView(current),
    update: async (configuration) => {
      const next: StoredProjectRuntimeConfiguration = {
        version: 1,
        ...configuration,
        subagentModels: { ...configuration.subagentModels },
      }
      validateConfiguration(next, options.availableModelIds())
      await persist(options.storagePath, next)
      current = next
      return publicView(current)
    },
  }
}

async function readConfiguration(
  path: string,
  fallback: ProjectRuntimeConfigurationView,
): Promise<StoredProjectRuntimeConfiguration> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(path, "utf8"))
  } catch (error) {
    if (hasCode(error, "ENOENT")) return { version: 1, ...fallback }
    throw new Error(`无法读取 Project 运行配置: ${path}`, { cause: error })
  }
  if (!isRecord(parsed) || parsed.version !== 1) {
    throw new Error(`Project 运行配置格式无效: ${path}`)
  }
  return {
    version: 1,
    solverModelId: stringValue(parsed.solverModelId),
    tldrModelId: stringValue(parsed.tldrModelId),
    subagentModels: stringRecord(parsed.subagentModels),
    maxConcurrent: Number(parsed.maxConcurrent),
    maxRemoteEnvironments:
      parsed.maxRemoteEnvironments === undefined
        ? fallback.maxRemoteEnvironments
        : Number(parsed.maxRemoteEnvironments),
  }
}

function validateConfiguration(
  configuration: StoredProjectRuntimeConfiguration,
  modelIds: ReadonlySet<string>,
): void {
  if (
    !Number.isInteger(configuration.maxConcurrent) ||
    configuration.maxConcurrent < 1 ||
    configuration.maxConcurrent > 64
  ) {
    throw new Error("maxConcurrent 必须是 1–64 的整数")
  }
  if (
    !Number.isInteger(configuration.maxRemoteEnvironments) ||
    configuration.maxRemoteEnvironments < 1 ||
    configuration.maxRemoteEnvironments > 64
  ) {
    throw new Error("maxRemoteEnvironments 必须是 1–64 的整数")
  }
  if (modelIds.size === 0) {
    if (
      configuration.solverModelId ||
      configuration.tldrModelId ||
      Object.keys(configuration.subagentModels).length > 0
    ) {
      throw new Error("空模型池不能包含 Project 模型绑定")
    }
    return
  }
  if (!modelIds.has(configuration.solverModelId)) {
    throw new Error(`Solver 模型不存在: ${configuration.solverModelId}`)
  }
  if (configuration.tldrModelId && !modelIds.has(configuration.tldrModelId)) {
    throw new Error(`TLDR 模型不存在: ${configuration.tldrModelId}`)
  }
  for (const [role, modelId] of Object.entries(configuration.subagentModels)) {
    if (!role.trim() || !modelIds.has(modelId)) {
      throw new Error(`SubAgent ${role || "<empty>"} 的模型不存在: ${modelId}`)
    }
  }
}

async function persist(
  path: string,
  configuration: StoredProjectRuntimeConfiguration,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(configuration, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    })
    await rename(temporary, path)
    await chmod(path, 0o600)
  } finally {
    await rm(temporary, { force: true })
  }
}

function publicView(
  configuration: StoredProjectRuntimeConfiguration,
): ProjectRuntimeConfigurationView {
  return {
    solverModelId: configuration.solverModelId,
    tldrModelId: configuration.tldrModelId,
    subagentModels: { ...configuration.subagentModels },
    maxConcurrent: configuration.maxConcurrent,
    maxRemoteEnvironments: configuration.maxRemoteEnvironments,
  }
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}
  return Object.fromEntries(
    Object.entries(value)
      .map(
        ([key, entryValue]) =>
          [key.trim(), typeof entryValue === "string" ? entryValue.trim() : ""] as const,
      )
      .filter(([key, entryValue]) => Boolean(key) && Boolean(entryValue)),
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code
}
