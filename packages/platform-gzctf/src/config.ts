import type { PlatformConfig } from "@ctf-agent/platform"

export type GZCTFAuthConfig =
  | { type: "password"; usernameSecret: string; passwordSecret: string }
  | { type: "cookie"; cookieSecret: string }

export interface GZCTFPlatformConfig {
  baseUrl: string
  gameId: number
  name?: string
  auth: GZCTFAuthConfig
  timeoutMs: number
  submissionPollIntervalMs: number
  submissionTimeoutMs: number
}

const allowedKeys = new Set([
  "baseUrl", "gameId", "name", "auth", "timeoutMs", "submissionPollIntervalMs", "submissionTimeoutMs",
])

export const gzctfConfig: PlatformConfig<GZCTFPlatformConfig> = {
  parse(value): GZCTFPlatformConfig {
    const raw = object(value, "GZCTF 平台配置")
    rejectUnknown(raw, allowedKeys, "GZCTF 平台配置")

    const baseUrl = text(raw.baseUrl, "GZCTF baseUrl").replace(/\/+$/, "")
    const url = new URL(baseUrl)
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("GZCTF baseUrl 仅支持 http 或 https")
    }
    if (url.username || url.password || url.search || url.hash) {
      throw new Error("GZCTF baseUrl 不能包含凭据、query 或 fragment")
    }

    const gameId = integer(raw.gameId, "GZCTF gameId", 1)
    const auth = parseAuth(raw.auth)
    const timeoutMs = optionalInteger(raw.timeoutMs, 15_000, "GZCTF timeoutMs", 1_000, 120_000)
    const submissionPollIntervalMs = optionalInteger(
      raw.submissionPollIntervalMs, 500, "GZCTF submissionPollIntervalMs", 50, 10_000,
    )
    const submissionTimeoutMs = optionalInteger(
      raw.submissionTimeoutMs, 30_000, "GZCTF submissionTimeoutMs", 1_000, 300_000,
    )
    if (raw.name !== undefined && (typeof raw.name !== "string" || raw.name.trim() === "")) {
      throw new Error("GZCTF name 必须是非空字符串")
    }

    return {
      baseUrl,
      gameId,
      auth,
      timeoutMs,
      submissionPollIntervalMs,
      submissionTimeoutMs,
      ...(typeof raw.name === "string" ? { name: raw.name.trim() } : {}),
    }
  },
}

function parseAuth(value: unknown): GZCTFAuthConfig {
  if (value === undefined) {
    return { type: "password", usernameSecret: "GZCTF_USERNAME", passwordSecret: "GZCTF_PASSWORD" }
  }
  const raw = object(value, "GZCTF auth")
  const type = text(raw.type, "GZCTF auth.type")
  if (type === "password") {
    rejectUnknown(raw, new Set(["type", "usernameSecret", "passwordSecret"]), "GZCTF password auth")
    return {
      type,
      usernameSecret: raw.usernameSecret === undefined ? "GZCTF_USERNAME" : text(raw.usernameSecret, "GZCTF usernameSecret"),
      passwordSecret: raw.passwordSecret === undefined ? "GZCTF_PASSWORD" : text(raw.passwordSecret, "GZCTF passwordSecret"),
    }
  }
  if (type === "cookie") {
    rejectUnknown(raw, new Set(["type", "cookieSecret"]), "GZCTF cookie auth")
    return {
      type,
      cookieSecret: raw.cookieSecret === undefined ? "GZCTF_COOKIE" : text(raw.cookieSecret, "GZCTF cookieSecret"),
    }
  }
  throw new Error("GZCTF auth.type 必须是 password 或 cookie")
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label}必须是对象`)
  return value as Record<string, unknown>
}

function rejectUnknown(raw: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw new Error(`${label}包含未知字段: ${key}`)
  }
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} 必须是非空字符串`)
  return value.trim()
}

function integer(value: unknown, label: string, minimum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum) throw new Error(`${label} 必须是大于等于 ${minimum} 的整数`)
  return value as number
}

function optionalInteger(value: unknown, fallback: number, label: string, min: number, max: number): number {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`${label} 必须是 ${min} 到 ${max} 之间的整数`)
  }
  return value as number
}
