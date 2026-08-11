import { createHash } from "node:crypto"
import type { ChallengeInfo, ChallengeSummary, PlatformPlugin, RemoteEnvironment } from "./index.ts"

export const PLATFORM_VALIDATION_HARNESS_VERSION = "1"

export type PlatformValidationLevel = "failed" | "read_only_verified" | "fully_verified"

export interface PlatformValidationProfile {
  id: string
  project: { id: string; name: string }
  config: unknown
  secrets?: Readonly<Record<string, string | undefined>>
  expected?: {
    contestId?: string
    contestName?: string
    challengeId?: string
    attachmentChallengeId?: string
    environmentChallengeId?: string
  }
  mutations?: {
    invalidFlag?: string
    testEnvironmentLifecycle?: boolean
  }
}

export interface PlatformValidationCheck {
  id: string
  status: "passed" | "failed" | "skipped"
  message: string
  durationMs: number
}

export interface PlatformValidationReport {
  pluginId: string
  revision: string
  contentHash: string
  harnessVersion: string
  profileId: string
  profileFingerprint: string
  authorSessionId: string
  status: PlatformValidationLevel
  startedAt: string
  completedAt: string
  checks: PlatformValidationCheck[]
  capabilities: Record<string, "passed" | "failed" | "skipped">
  cleanup: {
    projectClosed: boolean
    environmentDestroyed: boolean | null
  }
}

export async function validatePlatformPlugin(input: {
  plugin: PlatformPlugin
  revision: string
  contentHash: string
  authorSessionId: string
  profile: PlatformValidationProfile
}): Promise<PlatformValidationReport> {
  const startedAt = new Date().toISOString()
  const checks: PlatformValidationCheck[] = []
  const capabilities: PlatformValidationReport["capabilities"] = {}
  let projectClosed = false
  let environmentDestroyed: boolean | null = null
  let project: Awaited<ReturnType<PlatformPlugin["connect"]>> | undefined
  let startedEnvironment: RemoteEnvironment | undefined

  const check = async <T>(id: string, operation: () => Promise<T> | T): Promise<T | undefined> => {
    const started = performance.now()
    try {
      const value = await operation()
      checks.push({
        id,
        status: "passed",
        message: "通过",
        durationMs: Math.round(performance.now() - started),
      })
      return value
    } catch (error) {
      checks.push({
        id,
        status: "failed",
        message: safeError(error),
        durationMs: Math.round(performance.now() - started),
      })
      return undefined
    }
  }

  const parsed = await check("config.parse", () => input.plugin.config.parse(input.profile.config))
  if (parsed !== undefined) {
    project = await check("plugin.connect", () =>
      input.plugin.connect({
        project: input.profile.project,
        config: parsed,
        resolveSecret: (name) => input.profile.secrets?.[name],
      }),
    )
  }

  try {
    if (project) {
      const overview = await check("project.getOverview", () => project?.getOverview())
      await check("project.refresh", () => project?.refresh())
      if (overview && input.profile.expected?.contestId) {
        await check("expected.contestId", () => {
          if (overview.id !== input.profile.expected?.contestId) {
            throw new Error("比赛 ID 与测试配置不一致")
          }
        })
      }
      if (overview && input.profile.expected?.contestName) {
        await check("expected.contestName", () => {
          if (overview.name !== input.profile.expected?.contestName) {
            throw new Error("比赛名称与测试配置不一致")
          }
        })
      }

      const challenges = await check("project.listChallenges", async () => {
        const first = await project?.listChallenges()
        const second = await project?.listChallenges()
        validateChallenges(first ?? [])
        validateChallenges(second ?? [])
        if (JSON.stringify(first) !== JSON.stringify(second)) {
          throw new Error("连续两次题目列表结果不稳定")
        }
        return first ?? []
      })
      capabilities.challenges = checkPassed(checks, "project.listChallenges") ? "passed" : "failed"

      await check("project.listAnnouncements", async () => {
        const announcements = await project?.listAnnouncements()
        const ids = new Set<string>()
        for (const announcement of announcements ?? []) {
          if (!announcement.id || ids.has(announcement.id)) {
            throw new Error("公告 ID 为空或重复")
          }
          ids.add(announcement.id)
          if (Number.isNaN(Date.parse(announcement.publishedAt))) {
            throw new Error("公告时间无效")
          }
        }
      })
      capabilities.announcements = checkPassed(checks, "project.listAnnouncements")
        ? "passed"
        : "failed"

      const selected = selectChallenge(challenges ?? [], input.profile.expected?.challengeId)
      if (selected) {
        const capability = await check("project.bindChallenge", () =>
          project?.bindChallenge(selected.id),
        )
        if (capability) {
          await check("challenge.getInfo", async () => {
            const info = await capability.getInfo()
            validateChallengeInfo(selected, info)
          })
          capabilities.challengeInfo = checkPassed(checks, "challenge.getInfo")
            ? "passed"
            : "failed"

          const invalidFlag = input.profile.mutations?.invalidFlag
          if (invalidFlag) {
            await check("challenge.submitRejectedFlag", async () => {
              const result = await capability.submitFlag(invalidFlag)
              if (result.status !== "rejected") {
                throw new Error("测试 Flag 未返回 rejected")
              }
            })
            capabilities.submitFlag = checkPassed(checks, "challenge.submitRejectedFlag")
              ? "passed"
              : "failed"
          } else {
            skipped(checks, "challenge.submitRejectedFlag", "未提供测试 Flag")
            capabilities.submitFlag = "skipped"
          }
        }
      } else {
        skipped(checks, "project.bindChallenge", "测试配置没有可用题目")
        capabilities.challengeInfo = "skipped"
        capabilities.submitFlag = "skipped"
      }

      await check("project.listRemoteEnvironments", () => project?.listRemoteEnvironments())
      if (
        input.profile.mutations?.testEnvironmentLifecycle &&
        input.profile.expected?.environmentChallengeId
      ) {
        const environmentCapability = await check("environment.bindChallenge", () =>
          project?.bindChallenge(input.profile.expected?.environmentChallengeId ?? ""),
        )
        if (!environmentCapability?.instance) {
          failed(checks, "environment.start", "插件未提供环境生命周期能力")
          capabilities.environment = "failed"
        } else {
          startedEnvironment = await check("environment.start", () =>
            environmentCapability.instance?.start(),
          )
          if (startedEnvironment) {
            await check("environment.status", () => environmentCapability.instance?.status())
          }
          try {
            await environmentCapability.instance.destroy()
            environmentDestroyed = true
            passed(checks, "environment.destroy", "环境已销毁")
          } catch (error) {
            environmentDestroyed = false
            failed(checks, "environment.destroy", safeError(error))
          }
          capabilities.environment = [
            "environment.start",
            "environment.status",
            "environment.destroy",
          ].every((id) => checkPassed(checks, id))
            ? "passed"
            : "failed"
        }
      } else {
        skipped(checks, "environment.lifecycle", "未启用环境生命周期测试")
        capabilities.environment = "skipped"
      }
    }
  } finally {
    if (project) {
      try {
        await project.close()
        projectClosed = true
        passed(checks, "project.close", "连接已关闭")
      } catch (error) {
        failed(checks, "project.close", safeError(error))
      }
    }
  }

  const failedAny = checks.some(({ status }) => status === "failed")
  const requiredReadChecks = [
    "config.parse",
    "plugin.connect",
    "project.getOverview",
    "project.refresh",
    "project.listChallenges",
    "project.listAnnouncements",
    "project.close",
  ]
  const readOnlyPassed = requiredReadChecks.every((id) => checkPassed(checks, id))
  const mutations = [capabilities.submitFlag, capabilities.environment]
  const allMutationsPassed = mutations.every((status) => status === "passed")
  const status: PlatformValidationLevel = failedAny
    ? "failed"
    : readOnlyPassed && allMutationsPassed
      ? "fully_verified"
      : readOnlyPassed
        ? "read_only_verified"
        : "failed"

  return {
    pluginId: input.plugin.id,
    revision: input.revision,
    contentHash: input.contentHash,
    harnessVersion: PLATFORM_VALIDATION_HARNESS_VERSION,
    profileId: input.profile.id,
    profileFingerprint: fingerprintProfile(input.profile),
    authorSessionId: input.authorSessionId,
    status,
    startedAt,
    completedAt: new Date().toISOString(),
    checks,
    capabilities,
    cleanup: { projectClosed, environmentDestroyed },
  }
}

export function fingerprintProfile(profile: PlatformValidationProfile): string {
  const redacted = {
    ...profile,
    secrets: Object.keys(profile.secrets ?? {}).sort(),
  }
  return createHash("sha256").update(stableJson(redacted)).digest("hex")
}

function validateChallenges(challenges: readonly ChallengeSummary[]): void {
  const ids = new Set<string>()
  for (const challenge of challenges) {
    if (!challenge.id || ids.has(challenge.id)) {
      throw new Error("题目 ID 为空或重复")
    }
    ids.add(challenge.id)
    if (!Number.isFinite(challenge.score) || challenge.score < 0) {
      throw new Error(`题目分值无效: ${challenge.id}`)
    }
  }
}

function validateChallengeInfo(summary: ChallengeSummary, info: ChallengeInfo): void {
  if (info.id !== summary.id) throw new Error("题目详情 ID 与列表不一致")
  const attachmentIds = new Set<string>()
  for (const attachment of info.attachments) {
    if (!attachment.id || attachmentIds.has(attachment.id)) {
      throw new Error("附件 ID 为空或重复")
    }
    attachmentIds.add(attachment.id)
  }
}

function selectChallenge(
  challenges: readonly ChallengeSummary[],
  expectedId?: string,
): ChallengeSummary | undefined {
  return expectedId ? challenges.find(({ id }) => id === expectedId) : challenges[0]
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

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message
    .replace(/(authorization|cookie|token|password)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .slice(0, 500)
}

function checkPassed(checks: readonly PlatformValidationCheck[], id: string): boolean {
  return checks.some((check) => check.id === id && check.status === "passed")
}

function passed(checks: PlatformValidationCheck[], id: string, message: string): void {
  checks.push({ id, status: "passed", message, durationMs: 0 })
}

function failed(checks: PlatformValidationCheck[], id: string, message: string): void {
  checks.push({ id, status: "failed", message, durationMs: 0 })
}

function skipped(checks: PlatformValidationCheck[], id: string, message: string): void {
  checks.push({ id, status: "skipped", message, durationMs: 0 })
}
