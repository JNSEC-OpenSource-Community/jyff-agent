import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vite-plus/test"
import {
  createFileBuiltInPluginConfiguration,
  TOKEN_USAGE_PLUGIN_ID,
} from "../src/domain/built-in-plugin-config.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("内置插件配置", () => {
  it("首次启动默认开启 Token 消耗插件，并持久化显式开关", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctf-agent-plugins-"))
    roots.push(root)
    const path = join(root, "built-in-plugins.json")

    const initial = await createFileBuiltInPluginConfiguration(path)
    expect(initial.isEnabled(TOKEN_USAGE_PLUGIN_ID)).toBe(true)
    expect(initial.snapshot()).toMatchObject({
      plugins: [{ id: TOKEN_USAGE_PLUGIN_ID, enabled: true, defaultEnabled: true }],
    })

    await initial.setEnabled(TOKEN_USAGE_PLUGIN_ID, false)
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      version: 1,
      enabled: { [TOKEN_USAGE_PLUGIN_ID]: false },
    })

    const reopened = await createFileBuiltInPluginConfiguration(path)
    expect(reopened.isEnabled(TOKEN_USAGE_PLUGIN_ID)).toBe(false)
  })
})
