import type { PlatformConfig } from "@ctf-agent/platform"

export interface CTFdPlatformConfig {
  baseUrl: string
  tokenSecret: string
  name?: string
  timeoutMs: number
}

const allowedKeys = new Set(["baseUrl", "tokenSecret", "name", "timeoutMs"])

export const ctfdConfig: PlatformConfig<CTFdPlatformConfig> = {
  parse(value): CTFdPlatformConfig {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("CTFd 平台配置必须是对象")
    }
    const raw = value as Record<string, unknown>
    for (const key of Object.keys(raw)) {
      if (!allowedKeys.has(key)) throw new Error(`CTFd 平台配置包含未知字段: ${key}`)
    }

    const baseUrl = requiredText(raw.baseUrl, "baseUrl").replace(/\/+$/, "")
    const url = new URL(baseUrl)
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("CTFd baseUrl 仅支持 http 或 https")
    }
    if (url.username || url.password || url.search || url.hash) {
      throw new Error("CTFd baseUrl 不能包含凭据、query 或 fragment")
    }

    const tokenSecret = raw.tokenSecret === undefined
      ? "CTFD_TOKEN"
      : requiredText(raw.tokenSecret, "tokenSecret")
    const timeoutMs = raw.timeoutMs === undefined ? 15_000 : raw.timeoutMs
    if (!Number.isInteger(timeoutMs) || (timeoutMs as number) < 1_000 || (timeoutMs as number) > 120_000) {
      throw new Error("CTFd timeoutMs 必须是 1000 到 120000 之间的整数")
    }
    if (raw.name !== undefined && (typeof raw.name !== "string" || raw.name.trim() === "")) {
      throw new Error("CTFd name 必须是非空字符串")
    }

    return {
      baseUrl,
      tokenSecret,
      timeoutMs: timeoutMs as number,
      ...(typeof raw.name === "string" ? { name: raw.name.trim() } : {}),
    }
  },
}

function requiredText(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`CTFd ${name} 必须是非空字符串`)
  }
  return value.trim()
}
