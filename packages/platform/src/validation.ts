import { createHash } from "node:crypto"
import type { ChallengeInfo, ChallengeSummary, PlatformPlugin, RemoteEnvironment } from "./index.ts"

export const PLATFORM_VALIDATION_HARNESS_VERSION = "2"

const DEFAULT_VALIDATION_OPERATION_TIMEOUT_MS = 30_000
const DEFAULT_VALIDATION_ENVIRONMENT_START_TIMEOUT_MS = 4 * 60_000

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
  /** Test-only/embedding overrides; production uses bounded defaults. */
  timeouts?: {
    operationMs?: number
    environmentStartMs?: number
  }
}): Promise<PlatformValidationReport> {
  const startedAt = new Date().toISOString()
  const checks: PlatformValidationCheck[] = []
  const capabilities: PlatformValidationReport["capabilities"] = {}
  let projectClosed = false
  let environmentDestroyed: boolean | null = null
  let project: Awaited<ReturnType<PlatformPlugin["connect"]>> | undefined
  let startedEnvironment: RemoteEnvironment | undefined
  const operationTimeoutMs = input.timeouts?.operationMs ?? DEFAULT_VALIDATION_OPERATION_TIMEOUT_MS
  const environmentStartTimeoutMs =
    input.timeouts?.environmentStartMs ?? DEFAULT_VALIDATION_ENVIRONMENT_START_TIMEOUT_MS

  const check = async <T>(
    id: string,
    operation: () => Promise<T> | T,
    options: { timeoutMs?: number; onTimeout?: () => void } = {},
  ): Promise<T | undefined> => {
    const started = performance.now()
    try {
      const value = await validationDeadline(
        Promise.resolve().then(operation),
        options.timeoutMs ?? operationTimeoutMs,
        id,
        options.onTimeout,
      )
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
          const startController = new AbortController()
          let startOperation: Promise<RemoteEnvironment> | undefined
          startedEnvironment = await check(
            "environment.start",
            () => {
              startOperation = environmentCapability.instance?.start(startController.signal)
              return startOperation as Promise<RemoteEnvironment>
            },
            {
              timeoutMs: environmentStartTimeoutMs,
              onTimeout: () => startController.abort(validationTimeoutError("environment.start")),
            },
          )
          if (startedEnvironment) {
            if (environmentCapability.instance.waitUntilReady) {
              startedEnvironment = await check(
                "environment.readiness",
                () =>
                  environmentCapability.instance?.waitUntilReady?.(
                    startedEnvironment as RemoteEnvironment,
                    startController.signal,
                  ),
                {
                  timeoutMs: environmentStartTimeoutMs,
                  onTimeout: () =>
                    startController.abort(validationTimeoutError("environment.readiness")),
                },
              )
            } else {
              skipped(
                checks,
                "environment.readiness",
                "插件未实现协议感知 readiness，使用兼容状态检查",
              )
            }
            await check("environment.status", () => environmentCapability.instance?.status())
          }
          await check("environment.destroy", () => environmentCapability.instance?.destroy())
          environmentDestroyed = checkPassed(checks, "environment.destroy")
          if (!startedEnvironment && startOperation) {
            // A candidate may ignore abort and finish after the gate stopped
            // waiting. Repeat idempotent cleanup if that happens.
            void startOperation.then(
              async () => {
                try {
                  await validationDeadline(
                    Promise.resolve(environmentCapability.instance?.destroy()),
                    operationTimeoutMs,
                    "environment.lateDestroy",
                  )
                } catch {
                  // The report already records the primary lifecycle failure.
                }
              },
              () => undefined,
            )
          }
          const environmentChecks = [
            "environment.start",
            ...(environmentCapability.instance.waitUntilReady ? ["environment.readiness"] : []),
            "environment.status",
            "environment.destroy",
          ]
          capabilities.environment = environmentChecks.every((id) => checkPassed(checks, id))
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
      await check("project.close", () => project?.close())
      projectClosed = checkPassed(checks, "project.close")
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

async function validationDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  id: string,
  onTimeout?: () => void,
): Promise<T> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error(`Validation timeout for ${id} must be a positive integer`)
  }
  const timeout = AbortSignal.timeout(timeoutMs)
  try {
    return await new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(validationTimeoutError(id, timeoutMs))
      timeout.addEventListener("abort", onAbort, { once: true })
      operation.then(resolve, reject).finally(() => timeout.removeEventListener("abort", onAbort))
    })
  } catch (error) {
    if (!timeout.aborted) throw error
    onTimeout?.()
    throw validationTimeoutError(id, timeoutMs)
  }
}

function validationTimeoutError(id: string, timeoutMs?: number): Error {
  return Object.assign(
    new Error(
      timeoutMs === undefined
        ? `Validation operation cancelled: ${id}`
        : `Validation operation ${id} exceeded ${timeoutMs}ms`,
    ),
    { name: "PlatformValidationTimeoutError", code: "ETIMEDOUT" },
  )
}

function checkPassed(checks: readonly PlatformValidationCheck[], id: string): boolean {
  return checks.some((check) => check.id === id && check.status === "passed")
}

function failed(checks: PlatformValidationCheck[], id: string, message: string): void {
  checks.push({ id, status: "failed", message, durationMs: 0 })
}

function skipped(checks: PlatformValidationCheck[], id: string, message: string): void {
  checks.push({ id, status: "skipped", message, durationMs: 0 })
}
