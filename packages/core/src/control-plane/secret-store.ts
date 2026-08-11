import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

export interface SecretStore {
  get(name: string): string | undefined
  has(name: string): boolean
  set(values: Readonly<Record<string, string | undefined>>): Promise<void>
}

export class MemorySecretStore implements SecretStore {
  private readonly values = new Map<string, string>()

  constructor(initial: Readonly<Record<string, string>> = {}) {
    for (const [name, value] of Object.entries(initial)) {
      if (value) this.values.set(name, value)
    }
  }

  get(name: string): string | undefined {
    return this.values.get(name)
  }

  has(name: string): boolean {
    return this.values.has(name)
  }

  async set(values: Readonly<Record<string, string | undefined>>): Promise<void> {
    for (const [name, value] of Object.entries(values)) {
      validateSecretName(name)
      if (value === undefined || value === "") this.values.delete(name)
      else this.values.set(name, value)
    }
  }
}

export class FileSecretStore implements SecretStore {
  private constructor(
    readonly path: string,
    private readonly values: Map<string, string>,
  ) {}

  static async open(path: string): Promise<FileSecretStore> {
    let parsed: unknown = {}
    try {
      parsed = JSON.parse(await readFile(path, "utf8"))
    } catch (error) {
      if (!hasCode(error, "ENOENT")) {
        throw new Error(`无法读取 SecretStore: ${path}`, { cause: error })
      }
    }
    if (!isRecord(parsed)) throw new Error(`SecretStore 格式无效: ${path}`)
    const values = new Map<string, string>()
    for (const [name, value] of Object.entries(parsed)) {
      validateSecretName(name)
      if (typeof value !== "string") {
        throw new Error(`SecretStore 中的 ${name} 不是字符串`)
      }
      if (value) values.set(name, value)
    }
    return new FileSecretStore(path, values)
  }

  get(name: string): string | undefined {
    return this.values.get(name)
  }

  has(name: string): boolean {
    return this.values.has(name)
  }

  async set(values: Readonly<Record<string, string | undefined>>): Promise<void> {
    const next = new Map(this.values)
    for (const [name, value] of Object.entries(values)) {
      validateSecretName(name)
      if (value === undefined || value === "") next.delete(name)
      else next.set(name, value)
    }
    await mkdir(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temporary, `${JSON.stringify(Object.fromEntries(next), null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    })
    await chmod(temporary, 0o600)
    await rename(temporary, this.path)
    this.values.clear()
    for (const [name, value] of next) this.values.set(name, value)
  }
}

function validateSecretName(name: string): void {
  if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(name)) {
    throw new Error(`Secret 名称无效: ${name}`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  )
}
