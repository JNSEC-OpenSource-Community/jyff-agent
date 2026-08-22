import { execFile as execFileCallback } from "node:child_process"
import { promisify } from "node:util"

const execFile = promisify(execFileCallback)
export const DEFAULT_SOURCE_REPOSITORY = "JNSEC-OpenSource-Community/jyff-agent"
export const FALLBACK_BUILD_VERSION = "0.1.0"

export interface BuildIdentity {
  version: string | null
  revision: string | null
  repository: string
  builtAt: string | null
  dirty: boolean
  source: "environment" | "git" | "unknown"
}

export async function resolveBuildIdentity(options: {
  applicationRoot: string
  env?: NodeJS.ProcessEnv
}): Promise<BuildIdentity> {
  const env = options.env ?? process.env
  const repository = normalizeRepository(
    env.CTF_AGENT_REPOSITORY ?? env.GITHUB_REPOSITORY ?? DEFAULT_SOURCE_REPOSITORY,
  )
  const version = normalizeVersion(env.CTF_AGENT_VERSION ?? env.npm_package_version)
  const environmentRevision = normalizeRevision(env.CTF_AGENT_REVISION)
  const builtAt = normalizeIsoDate(env.CTF_AGENT_BUILT_AT)

  if (environmentRevision) {
    return {
      version: version ?? FALLBACK_BUILD_VERSION,
      revision: environmentRevision,
      repository,
      builtAt,
      dirty: env.CTF_AGENT_DIRTY === "1",
      source: "environment",
    }
  }

  try {
    const revision = await git(options.applicationRoot, ["rev-parse", "HEAD"])
    const dirty = (await git(options.applicationRoot, ["status", "--porcelain"])).trim().length > 0
    return {
      version: version ?? FALLBACK_BUILD_VERSION,
      revision: normalizeRevision(revision) ?? revision.trim(),
      repository,
      builtAt,
      dirty,
      source: "git",
    }
  } catch {
    return {
      version: version ?? FALLBACK_BUILD_VERSION,
      revision: null,
      repository,
      builtAt,
      dirty: false,
      source: "unknown",
    }
  }
}

function normalizeRepository(value: string): string {
  const normalized = value
    .trim()
    .replace(/^https?:\/\/github\.com\//iu, "")
    .replace(/\.git$/iu, "")
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(normalized)) {
    return DEFAULT_SOURCE_REPOSITORY
  }
  return normalized
}

function normalizeVersion(value: string | undefined): string | null {
  const normalized = value?.trim()
  return normalized && /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(normalized)
    ? normalized.replace(/^v/iu, "")
    : null
}

function normalizeRevision(value: string | undefined): string | null {
  const normalized = value?.trim()
  return normalized && /^[a-f0-9]{7,64}$/iu.test(normalized) ? normalized.toLowerCase() : null
}

function normalizeIsoDate(value: string | undefined): string | null {
  if (!value) return null
  const timestamp = Date.parse(value)
  return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString()
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFile("git", args, {
    cwd,
    timeout: 5_000,
    maxBuffer: 64 * 1024,
    windowsHide: true,
  })
  return result.stdout
}
