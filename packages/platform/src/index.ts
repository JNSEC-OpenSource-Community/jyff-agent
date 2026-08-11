export interface Attachment {
  id: string
  name: string
  /** Some platforms only reveal the size after download. */
  size?: number
}

export interface ChallengeSummary {
  id: string
  title: string
  category: string
  score: number
  solved?: boolean
  /** Whether this challenge exposes a remotely managed environment. */
  needsEnv?: boolean
}

export interface ChallengeInfo extends ChallengeSummary {
  description: string
  attachments: Attachment[]
  environmentGuide?: string
}

export type AnnouncementKind = "normal" | "hint" | "new_challenge" | "solve_broadcast" | "unknown"

export interface Announcement {
  id: string
  title: string
  content: string
  publishedAt: string
  kind?: AnnouncementKind
  rawType?: string
}

export interface ContestOverview {
  id: string
  name: string
  challenges: number
  announcements: number
}

export interface RemoteEnvironment {
  id: string
  challengeId: string
  status: "starting" | "running" | "stopped"
  endpoint?: string
}

export interface FlagSubmission {
  status: "accepted" | "rejected" | "already_solved"
  message: string
}

/** A challenge-scoped capability. Methods intentionally take no challenge id. */
export interface ChallengeCapability {
  getInfo(): Promise<ChallengeInfo>
  downloadAttachment(attachmentId: string): Promise<{ attachment: Attachment; content: Uint8Array }>
  submitFlag(flag: string): Promise<FlagSubmission>
  instance?: {
    start(signal?: AbortSignal): Promise<RemoteEnvironment>
    status(): Promise<RemoteEnvironment | null>
    destroy(): Promise<void>
  }
}

/** Full contest control plane. This capability must never be passed to an agent. */
export interface PlatformProject {
  refresh(): Promise<ContestOverview>
  getOverview(): Promise<ContestOverview>
  listChallenges(): Promise<ChallengeSummary[]>
  listAnnouncements(): Promise<Announcement[]>
  listRemoteEnvironments(): Promise<RemoteEnvironment[]>
  getRemoteEnvironment(id: string): Promise<RemoteEnvironment | null>
  destroyRemoteEnvironment(id: string): Promise<void>
  bindChallenge(challengeId: string): Promise<ChallengeCapability>
  close(): Promise<void>
}

export interface PlatformConfig<T = unknown> {
  parse(value: unknown): T
}

export interface PlatformSetupField {
  key: string
  label: string
  type: "text" | "url" | "integer"
  required: boolean
  placeholder?: string
  minimum?: number
  maximum?: number
}

export interface PlatformSecretField {
  name: string
  label: string
  type: "text" | "password" | "token" | "cookie"
  required: boolean
}

export interface PlatformAuthStrategy {
  id: string
  label: string
  config: Record<string, unknown>
  secrets: readonly PlatformSecretField[]
}

export interface PlatformSetupDescriptor {
  label: string
  description: string
  defaultConfig: Record<string, unknown>
  fields: readonly PlatformSetupField[]
  authStrategies: readonly PlatformAuthStrategy[]
}

export interface PlatformConnectOptions<T = unknown> {
  project: { id: string; name: string }
  config: T
  resolveSecret: (name: string) => string | undefined
}

/**
 * Runtime-erased platform plugin contract. A plugin owns validation of its
 * configuration; Project only selects the plugin and supplies secrets.
 */
export interface PlatformPlugin {
  readonly id: string
  readonly config: PlatformConfig
  readonly setup?: PlatformSetupDescriptor
  connect(options: PlatformConnectOptions): Promise<PlatformProject>
}

/** Validate an extension-owned setup descriptor without executing plugin code. */
export function parsePlatformSetupDescriptor(value: unknown): PlatformSetupDescriptor {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("platform setup 无效")
  }
  const setup = value as Record<string, unknown>
  const exactKeys = (
    object: Record<string, unknown>,
    allowed: readonly string[],
    label: string,
  ) => {
    if (Object.keys(object).some((key) => !allowed.includes(key))) {
      throw new Error(`${label} 包含未知字段`)
    }
  }
  exactKeys(
    setup,
    ["label", "description", "defaultConfig", "fields", "authStrategies"],
    "platform setup",
  )
  if (typeof setup.label !== "string" || !setup.label.trim())
    throw new Error("platform setup label 无效")
  if (typeof setup.description !== "string") throw new Error("platform setup description 无效")
  if (
    !setup.defaultConfig ||
    typeof setup.defaultConfig !== "object" ||
    Array.isArray(setup.defaultConfig)
  ) {
    throw new Error("platform setup defaultConfig 无效")
  }
  if (!Array.isArray(setup.fields) || !Array.isArray(setup.authStrategies)) {
    throw new Error("platform setup fields 无效")
  }
  const fieldKeys = new Set<string>()
  const fields = setup.fields.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new Error("platform setup field 无效")
    const field = item as Record<string, unknown>
    exactKeys(
      field,
      ["key", "label", "type", "required", "placeholder", "minimum", "maximum"],
      "platform setup field",
    )
    if (
      typeof field.key !== "string" ||
      !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(field.key) ||
      fieldKeys.has(field.key)
    ) {
      throw new Error("platform setup field key 无效或重复")
    }
    fieldKeys.add(field.key)
    if (typeof field.label !== "string" || !field.label.trim())
      throw new Error("platform setup field label 无效")
    if (!(["text", "url", "integer"] as const).includes(field.type as never))
      throw new Error("platform setup field type 无效")
    if (typeof field.required !== "boolean") throw new Error("platform setup field required 无效")
    if (field.placeholder !== undefined && typeof field.placeholder !== "string")
      throw new Error("platform setup field placeholder 无效")
    for (const key of ["minimum", "maximum"] as const) {
      if (field[key] !== undefined && typeof field[key] !== "number")
        throw new Error(`platform setup field ${key} 无效`)
    }
    return field as unknown as PlatformSetupField
  })
  const strategyIds = new Set<string>()
  const authStrategies = setup.authStrategies.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new Error("platform auth strategy 无效")
    const strategy = item as Record<string, unknown>
    exactKeys(strategy, ["id", "label", "config", "secrets"], "platform auth strategy")
    if (
      typeof strategy.id !== "string" ||
      !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(strategy.id) ||
      strategyIds.has(strategy.id)
    ) {
      throw new Error("platform auth strategy ID 无效或重复")
    }
    strategyIds.add(strategy.id)
    if (typeof strategy.label !== "string" || !strategy.label.trim())
      throw new Error("platform auth strategy label 无效")
    if (!strategy.config || typeof strategy.config !== "object" || Array.isArray(strategy.config))
      throw new Error("platform auth strategy config 无效")
    if (!Array.isArray(strategy.secrets)) throw new Error("platform auth strategy secrets 无效")
    const secretNames = new Set<string>()
    const secrets = strategy.secrets.map((secretValue) => {
      if (!secretValue || typeof secretValue !== "object" || Array.isArray(secretValue))
        throw new Error("platform secret field 无效")
      const secret = secretValue as Record<string, unknown>
      exactKeys(secret, ["name", "label", "type", "required"], "platform secret field")
      if (
        typeof secret.name !== "string" ||
        !/^[A-Z][A-Z0-9_]{0,79}$/.test(secret.name) ||
        secretNames.has(secret.name)
      ) {
        throw new Error("platform secret name 无效或重复")
      }
      secretNames.add(secret.name)
      if (typeof secret.label !== "string" || !secret.label.trim())
        throw new Error("platform secret label 无效")
      if (!(["text", "password", "token", "cookie"] as const).includes(secret.type as never))
        throw new Error("platform secret type 无效")
      if (typeof secret.required !== "boolean") throw new Error("platform secret required 无效")
      return secret as unknown as PlatformSecretField
    })
    return { ...strategy, secrets } as unknown as PlatformAuthStrategy
  })
  return {
    label: setup.label.trim(),
    description: setup.description,
    defaultConfig: setup.defaultConfig as Record<string, unknown>,
    fields,
    authStrategies,
  }
}

/**
 * Platform adapters mark failures that are safe to retry without charging an
 * Agent attempt. Keep the check structural so Core does not depend on a
 * concrete platform error class.
 */
export function isRetryablePlatformError(error: unknown): boolean {
  if (error && typeof error === "object" && (error as { retryable?: unknown }).retryable === true) {
    return true
  }
  if (error instanceof AggregateError) {
    return error.errors.length > 0 && error.errors.every((item) => isRetryablePlatformError(item))
  }
  if (!error || typeof error !== "object") return false
  const cause = (error as { cause?: unknown }).cause
  return cause !== undefined && isRetryablePlatformError(cause)
}

export * from "./ctfd.ts"
export * from "./gzctf.ts"
export * from "./registry.ts"
export * from "./validation.ts"
