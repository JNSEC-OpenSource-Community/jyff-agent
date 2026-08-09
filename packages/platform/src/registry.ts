import type { PlatformPlugin } from "./index.ts"

export interface RegisteredPlatformPlugin {
  plugin: PlatformPlugin
  source: "builtin" | "extension"
  revision?: string
  authorSessionId?: string
}

/** 动态平台注册表；内置插件不可被扩展覆盖。 */
export class PlatformPluginRegistry {
  private readonly builtins = new Map<string, RegisteredPlatformPlugin>()
  private readonly extensions = new Map<string, RegisteredPlatformPlugin>()

  constructor(plugins: readonly PlatformPlugin[] = []) {
    for (const plugin of plugins) {
      if (this.builtins.has(plugin.id)) {
        throw new Error(`平台插件 ID 重复: ${plugin.id}`)
      }
      this.builtins.set(plugin.id, { plugin, source: "builtin" })
    }
  }

  list(): RegisteredPlatformPlugin[] {
    return [...this.builtins.values(), ...this.extensions.values()]
  }

  plugins(): PlatformPlugin[] {
    return this.list().map(({ plugin }) => plugin)
  }

  resolve(id: string): PlatformPlugin | undefined {
    return this.builtins.get(id)?.plugin ?? this.extensions.get(id)?.plugin
  }

  registerExtension(input: {
    plugin: PlatformPlugin
    revision: string
    authorSessionId: string
  }): RegisteredPlatformPlugin {
    if (this.builtins.has(input.plugin.id)) {
      throw new Error(`扩展不能覆盖内置平台插件: ${input.plugin.id}`)
    }
    const registration: RegisteredPlatformPlugin = {
      ...input,
      source: "extension",
    }
    this.extensions.set(input.plugin.id, registration)
    return registration
  }

  unregisterExtension(id: string): boolean {
    return this.extensions.delete(id)
  }
}
