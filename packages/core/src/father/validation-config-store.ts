import { createHash } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import type { SecretStore } from "../control-plane/secret-store.ts"

interface StoredValidationConfig {
  schemaFingerprint: string
  config: unknown
  secretNames: string[]
}

export class FatherValidationConfigStore {
  constructor(
    private readonly root: string,
    private readonly secrets: SecretStore,
  ) {}

  async read(sessionId: string, schemaFingerprint: string) {
    try {
      const stored = JSON.parse(
        await readFile(this.path(sessionId), "utf8"),
      ) as StoredValidationConfig
      if (stored.schemaFingerprint !== schemaFingerprint) return undefined
      return {
        config: stored.config,
        configuredSecrets: Object.fromEntries(
          stored.secretNames.map((name) => [
            name,
            { configured: this.secrets.has(this.key(sessionId, name)) },
          ]),
        ),
        secrets: Object.fromEntries(
          stored.secretNames.map((name) => [
            name,
            this.secrets.get(this.key(sessionId, name)),
          ]),
        ),
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw error
    }
  }

  async save(input: {
    sessionId: string
    schemaFingerprint: string
    config: unknown
    secrets: Record<string, string | undefined>
    secretNames: string[]
  }): Promise<void> {
    const values: Record<string, string | undefined> = {}
    for (const name of input.secretNames) {
      const value = input.secrets[name]
      if (value) values[this.key(input.sessionId, name)] = value
    }
    await this.secrets.set(values)
    const target = this.path(input.sessionId)
    const temporary = `${target}.tmp-${process.pid}`
    await mkdir(dirname(target), { recursive: true })
    await writeFile(
      temporary,
      JSON.stringify(
        {
          schemaFingerprint: input.schemaFingerprint,
          config: input.config,
          secretNames: input.secretNames,
        },
        null,
        2,
      ),
    )
    await rename(temporary, target)
  }

  private path(sessionId: string): string {
    return join(
      resolve(this.root),
      ".ctf-agent",
      "father",
      "sessions",
      sessionId,
      "validation-config.json",
    )
  }

  private key(sessionId: string, name: string): string {
    const prefix = createHash("sha256")
      .update(sessionId)
      .digest("hex")
      .slice(0, 16)
      .toUpperCase()
    const suffix = name
      .toUpperCase()
      .replace(/[^A-Z0-9_]/g, "_")
      .slice(0, 80)
    return `FATHER_${prefix}_${suffix}`
  }
}
