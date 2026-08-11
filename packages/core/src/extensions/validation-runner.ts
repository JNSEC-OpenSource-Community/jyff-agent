import { pathToFileURL } from "node:url"
import type { PlatformPlugin, PlatformValidationProfile } from "@ctf-agent/platform"
import { validatePlatformPlugin } from "./platform-validation.ts"

interface RunnerInput {
  entry: string
  pluginId: string
  manifestSetup: unknown
  revision: string
  contentHash: string
  authorSessionId: string
  profile: PlatformValidationProfile
}

let serializedInput = ""
for await (const chunk of process.stdin) serializedInput += String(chunk)
const input = JSON.parse(serializedInput) as RunnerInput
const imported = (await import(`${pathToFileURL(input.entry).href}?validation=${Date.now()}`)) as {
  default?: unknown
  platformPlugin?: unknown
}
const plugin = imported.platformPlugin ?? imported.default
if (!isPlatformPlugin(plugin)) throw new Error("入口未导出有效 PlatformPlugin")
if (plugin.id !== input.pluginId) throw new Error("manifest ID 与插件导出 ID 不一致")
if (stableJson(plugin.setup) !== stableJson(input.manifestSetup)) {
  throw new Error("manifest setup 与插件导出的 setup 不一致")
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}
const report = await validatePlatformPlugin({
  plugin,
  revision: input.revision,
  contentHash: input.contentHash,
  authorSessionId: input.authorSessionId,
  profile: input.profile,
})
process.stdout.write(`\n__FATHER_REPORT__${JSON.stringify(report)}`)

function isPlatformPlugin(value: unknown): value is PlatformPlugin {
  if (!value || typeof value !== "object") return false
  const plugin = value as Partial<PlatformPlugin>
  return (
    typeof plugin.id === "string" &&
    typeof plugin.config?.parse === "function" &&
    typeof plugin.connect === "function"
  )
}
