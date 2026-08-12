import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

export const TOKEN_USAGE_PLUGIN_ID = "token-usage" as const

export type BuiltInPluginId = typeof TOKEN_USAGE_PLUGIN_ID

export interface BuiltInPluginView {
  id: BuiltInPluginId
  name: string
  description: string
  enabled: boolean
  defaultEnabled: boolean
}

export interface BuiltInPluginConfigurationView {
  plugins: BuiltInPluginView[]
}

export interface BuiltInPluginConfiguration {
  snapshot(): BuiltInPluginConfigurationView
  has(pluginId: string): pluginId is BuiltInPluginId
  isEnabled(pluginId: BuiltInPluginId): boolean
  setEnabled(pluginId: BuiltInPluginId, enabled: boolean): Promise<BuiltInPluginConfigurationView>
}

interface StoredBuiltInPluginConfiguration {
  version: 1
  enabled: Partial<Record<BuiltInPluginId, boolean>>
}

const DEFINITIONS: ReadonlyArray<Omit<BuiltInPluginView, "enabled"> & { defaultEnabled: boolean }> =
  [
    {
      id: TOKEN_USAGE_PLUGIN_ID,
      name: "Token 消耗",
      description: "按比赛和模型汇总 Solver、SubAgent 与 TLDR 的输入、输出和缓存命中用量。",
      defaultEnabled: true,
    },
  ]

export function defaultBuiltInPluginConfigurationView(): BuiltInPluginConfigurationView {
  return {
    plugins: DEFINITIONS.map((plugin) => ({ ...plugin, enabled: plugin.defaultEnabled })),
  }
}

export async function createFileBuiltInPluginConfiguration(
  storagePath: string,
): Promise<BuiltInPluginConfiguration> {
  let configuration = await readConfiguration(storagePath)

  function snapshot(): BuiltInPluginConfigurationView {
    return {
      plugins: DEFINITIONS.map((plugin) => ({
        ...plugin,
        enabled: configuration.enabled[plugin.id] ?? plugin.defaultEnabled,
      })),
    }
  }

  return {
    snapshot,

    has(pluginId): pluginId is BuiltInPluginId {
      return DEFINITIONS.some((plugin) => plugin.id === pluginId)
    },

    isEnabled(pluginId) {
      const plugin = DEFINITIONS.find((candidate) => candidate.id === pluginId)
      return configuration.enabled[pluginId] ?? plugin?.defaultEnabled ?? false
    },

    async setEnabled(pluginId, enabled) {
      const nextConfiguration: StoredBuiltInPluginConfiguration = {
        version: 1,
        enabled: { ...configuration.enabled, [pluginId]: enabled },
      }
      await persistConfiguration(storagePath, nextConfiguration)
      configuration = nextConfiguration
      return snapshot()
    },
  }
}

async function readConfiguration(path: string): Promise<StoredBuiltInPluginConfiguration> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(path, "utf8"))
  } catch (error) {
    if (hasCode(error, "ENOENT")) return { version: 1, enabled: {} }
    throw new Error(`无法读取内置插件配置: ${path}`, { cause: error })
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.enabled)) {
    throw new Error(`内置插件配置格式无效: ${path}`)
  }
  const enabled: StoredBuiltInPluginConfiguration["enabled"] = {}
  for (const plugin of DEFINITIONS) {
    const value = parsed.enabled[plugin.id]
    if (value !== undefined && typeof value !== "boolean") {
      throw new Error(`内置插件 ${plugin.id} 的 enabled 必须是布尔值`)
    }
    if (typeof value === "boolean") enabled[plugin.id] = value
  }
  return { version: 1, enabled }
}

async function persistConfiguration(
  path: string,
  configuration: StoredBuiltInPluginConfiguration,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code
}
