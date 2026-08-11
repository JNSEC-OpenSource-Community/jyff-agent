import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto"
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { promisify } from "node:util"

const scrypt = promisify(scryptCallback)
const PASSWORD_BYTES = 64
const SESSION_TTL_MS = 24 * 60 * 60 * 1_000

interface StoredAuthenticationConfiguration {
  version: 1
  authentication:
    | { enabled: false }
    | {
        enabled: true
        username: string
        salt: string
        passwordHash: string
      }
}

interface SessionRecord {
  username: string
  expiresAt: number
}

export interface WebUiAuthenticationView {
  enabled: boolean
  username: string | null
}

export interface WebUiLoginSession {
  token: string
  username: string
  expiresAt: string
}

export interface WebUiAuthentication {
  snapshot(): WebUiAuthenticationView
  configure(input: {
    enabled: boolean
    username?: string
    password?: string
  }): Promise<WebUiAuthenticationView>
  login(username: string, password: string): Promise<WebUiLoginSession>
  authenticate(token: string | undefined): boolean
  logout(token: string | undefined): void
}

export async function createFileWebUiAuthentication(
  storagePath: string,
): Promise<WebUiAuthentication> {
  return new FileWebUiAuthentication(storagePath, await readConfiguration(storagePath))
}

class FileWebUiAuthentication implements WebUiAuthentication {
  private readonly sessions = new Map<string, SessionRecord>()

  constructor(
    private readonly storagePath: string,
    private configuration: StoredAuthenticationConfiguration,
  ) {}

  snapshot(): WebUiAuthenticationView {
    const authentication = this.configuration.authentication
    return {
      enabled: authentication.enabled,
      username: authentication.enabled ? authentication.username : null,
    }
  }

  async configure(input: {
    enabled: boolean
    username?: string
    password?: string
  }): Promise<WebUiAuthenticationView> {
    if (!input.enabled) {
      this.configuration = { version: 1, authentication: { enabled: false } }
      this.sessions.clear()
      await persistConfiguration(this.storagePath, this.configuration)
      return this.snapshot()
    }

    const username = normalizedUsername(input.username)
    const current = this.configuration.authentication
    const password = input.password ?? ""
    if (!password && current.enabled && current.username === username) {
      return this.snapshot()
    }
    validatePassword(password)
    const salt = randomBytes(16)
    const passwordHash = await derivePassword(password, salt)
    this.configuration = {
      version: 1,
      authentication: {
        enabled: true,
        username,
        salt: salt.toString("base64"),
        passwordHash: passwordHash.toString("base64"),
      },
    }
    this.sessions.clear()
    await persistConfiguration(this.storagePath, this.configuration)
    return this.snapshot()
  }

  async login(username: string, password: string): Promise<WebUiLoginSession> {
    const authentication = this.configuration.authentication
    if (!authentication.enabled) throw new Error("WebUI 鉴权未启用")
    const salt = Buffer.from(authentication.salt, "base64")
    const expected = Buffer.from(authentication.passwordHash, "base64")
    const actual = await derivePassword(password, salt)
    if (
      username !== authentication.username ||
      actual.byteLength !== expected.byteLength ||
      !timingSafeEqual(actual, expected)
    ) {
      throw new Error("用户名或密码错误")
    }
    this.pruneSessions()
    const token = randomBytes(32).toString("base64url")
    const expiresAt = Date.now() + SESSION_TTL_MS
    this.sessions.set(token, { username, expiresAt })
    return { token, username, expiresAt: new Date(expiresAt).toISOString() }
  }

  authenticate(token: string | undefined): boolean {
    if (!this.configuration.authentication.enabled) return true
    if (!token) return false
    const session = this.sessions.get(token)
    if (!session) return false
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(token)
      return false
    }
    return true
  }

  logout(token: string | undefined): void {
    if (token) this.sessions.delete(token)
  }

  private pruneSessions(): void {
    const now = Date.now()
    for (const [token, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(token)
    }
  }
}

async function readConfiguration(path: string): Promise<StoredAuthenticationConfiguration> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(path, "utf8"))
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      return { version: 1, authentication: { enabled: false } }
    }
    throw new Error(`无法读取 WebUI 全局配置: ${path}`, { cause: error })
  }
  if (!isRecord(parsed) || parsed.version !== 1) {
    throw new Error(`WebUI 全局配置格式无效: ${path}`)
  }
  const authentication = parsed.authentication
  if (!isRecord(authentication) || typeof authentication.enabled !== "boolean") {
    throw new Error(`WebUI 鉴权配置格式无效: ${path}`)
  }
  if (!authentication.enabled) {
    return { version: 1, authentication: { enabled: false } }
  }
  return {
    version: 1,
    authentication: {
      enabled: true,
      username: normalizedUsername(authentication.username),
      salt: requiredText(authentication.salt, "authentication.salt"),
      passwordHash: requiredText(authentication.passwordHash, "authentication.passwordHash"),
    },
  }
}

async function persistConfiguration(
  path: string,
  configuration: StoredAuthenticationConfiguration,
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

async function derivePassword(password: string, salt: Buffer): Promise<Buffer> {
  return (await scrypt(password, salt, PASSWORD_BYTES)) as Buffer
}

function normalizedUsername(value: unknown): string {
  const username = requiredText(value, "用户名")
  if (username.length > 128) throw new Error("用户名长度不能超过 128")
  return username
}

function validatePassword(password: string): void {
  if (password.length < 8 || password.length > 1024) {
    throw new Error("密码长度必须为 8–1024")
  }
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} 必须是非空字符串`)
  }
  return value.trim()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code
}
