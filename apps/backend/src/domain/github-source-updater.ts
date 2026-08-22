import { randomUUID } from "node:crypto"
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import type { SecretStore } from "@ctf-agent/core"
import type { BuildIdentity } from "./build-identity.ts"
import {
  type SourceUpdateChannel,
  type SourceUpdaterConfiguration,
  type SourceUpdaterConfigurationUpdate,
  createFileSourceUpdaterConfiguration,
  GITHUB_SOURCE_UPDATER_TOKEN,
} from "./source-updater-config.ts"

const GITHUB_API_VERSION = "2022-11-28"
const DEFAULT_GITHUB_API = "https://api.github.com"
const STATE_VERSION = 1 as const

export type SourceUpdateRelation = "behind" | "ahead" | "identical" | "diverged" | "unknown"
export type SourceUpdateOperationKind = "check" | "prepare" | "apply" | "rollback"
export type SourceUpdateOperationStatus =
  | "checking"
  | "preparing"
  | "prepared"
  | "waiting_for_idle"
  | "applying"
  | "verifying"
  | "succeeded"
  | "failed"
  | "rolled_back"
  | "rollback_failed"

export interface SourceUpdateCandidateView {
  version: string | null
  revision: string
  ref: string
  channel: SourceUpdateChannel
  htmlUrl: string
  changelog: string | null
  publishedAt: string | null
  signatureVerified: boolean
  verified: boolean
  relation: SourceUpdateRelation
  aheadBy: number | null
  behindBy: number | null
}

export interface SourceUpdateOperationView {
  id: string
  kind: SourceUpdateOperationKind
  status: SourceUpdateOperationStatus
  currentRevision: string | null
  targetRevision: string | null
  message: string
  startedAt: string
  updatedAt: string
  error?: { code: string; message: string }
}

export interface SourceUpdateExecutorView {
  connected: boolean
  protocolVersion: number | null
  canPrepare: boolean
  canApply: boolean
  reason: string | null
}

export interface SourceUpdaterView {
  id: "github-source-updater"
  configuration: ReturnType<SourceUpdaterConfiguration["snapshot"]>
  current: BuildIdentity
  candidate: SourceUpdateCandidateView | null
  executor: SourceUpdateExecutorView
  operation: SourceUpdateOperationView | null
  lastCheckedAt: string | null
  nextCheckAt: string | null
  error: { code: string; message: string } | null
}

export interface SourceUpdateExecutor {
  snapshot(): SourceUpdateExecutorView
  prepare(input: {
    operationId: string
    repository: string
    channel: SourceUpdateChannel
    revision: string
    version: string | null
  }): Promise<{ message?: string }>
  apply(input: {
    operationId: string
    repository: string
    revision: string
    expectedCurrentRevision: string | null
  }): Promise<{ message?: string }>
  rollback(input: { operationId: string }): Promise<{ message?: string }>
}

export interface SourceUpdaterActivity {
  activeSolvers: number
  activeFatherTurns: number
  activeAudits: number
}

export interface SourceUpdaterMaintenance {
  begin(): void | Promise<void>
  end(): void | Promise<void>
}

export interface GitHubSourceUpdaterOptions {
  storageDirectory: string
  secretStore: SecretStore
  buildIdentity: BuildIdentity
  repository?: string
  fetch?: typeof globalThis.fetch
  githubApiBaseUrl?: string
  executor?: SourceUpdateExecutor
  activity?: () => SourceUpdaterActivity
  automaticApplyAllowed?: () => boolean
  maintenance?: SourceUpdaterMaintenance
  onStatus?: (snapshot: SourceUpdaterView) => void | Promise<void>
}

export interface GitHubSourceUpdater {
  snapshot(): Promise<SourceUpdaterView>
  updateConfiguration(input: SourceUpdaterConfigurationUpdate): Promise<SourceUpdaterView>
  setGitHubToken(token: string | undefined): Promise<SourceUpdaterView>
  checkNow(): Promise<SourceUpdateOperationView>
  prepare(expectedTargetRevision?: string): Promise<SourceUpdateOperationView>
  apply(input: {
    operationId: string
    expectedCurrentRevision: string | null
    expectedTargetRevision: string
  }): Promise<SourceUpdateOperationView>
  rollback(operationId: string): Promise<SourceUpdateOperationView>
  setStatusListener(listener: (snapshot: SourceUpdaterView) => void | Promise<void>): void
  setActivityProvider(provider: () => SourceUpdaterActivity): void
  setMaintenanceController(maintenance: SourceUpdaterMaintenance): void
  start(): void
  close(): void
}

interface StoredRemoteResponse {
  etag?: string
  payload: unknown
}

interface StoredState {
  version: 1
  remote: Record<string, StoredRemoteResponse>
  candidate: SourceUpdateCandidateView | null
  operation: SourceUpdateOperationView | null
  lastCheckedAt: string | null
  nextCheckAt: string | null
  error: { code: string; message: string } | null
}

interface GitHubResponse<T> {
  status: number
  etag: string | null
  payload: T | null
}

interface GitHubCommit {
  sha?: unknown
  html_url?: unknown
  commit?: {
    message?: unknown
    verification?: { verified?: unknown }
  }
}

interface GitHubRelease {
  tag_name?: unknown
  html_url?: unknown
  body?: unknown
  published_at?: unknown
  draft?: unknown
  prerelease?: unknown
}

interface GitHubCompare {
  status?: unknown
  ahead_by?: unknown
  behind_by?: unknown
}

class SourceUpdaterError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = "SourceUpdaterError"
  }
}

export async function createFileGitHubSourceUpdater(
  options: GitHubSourceUpdaterOptions,
): Promise<GitHubSourceUpdater> {
  const configuration = await createFileSourceUpdaterConfiguration({
    storagePath: `${options.storageDirectory}/config.json`,
    secretStore: options.secretStore,
    repository: options.repository ?? options.buildIdentity.repository,
  })
  const statePath = `${options.storageDirectory}/state.json`
  const state = await readState(statePath)
  const updater = new GitHubSourceUpdaterImpl(options, configuration, statePath, state)
  return updater
}

class GitHubSourceUpdaterImpl implements GitHubSourceUpdater {
  private readonly fetch: typeof globalThis.fetch
  private readonly githubApiBaseUrl: string
  private readonly executor: SourceUpdateExecutor
  private state: StoredState
  private checkTimer: NodeJS.Timeout | undefined
  private checking: Promise<SourceUpdateOperationView> | undefined
  private activityProvider: (() => SourceUpdaterActivity) | undefined
  private maintenance: SourceUpdaterMaintenance | undefined
  private persistence: Promise<void> = Promise.resolve()
  private closed = false

  constructor(
    private readonly options: GitHubSourceUpdaterOptions,
    private readonly configuration: SourceUpdaterConfiguration,
    private readonly statePath: string,
    state: StoredState,
  ) {
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.githubApiBaseUrl = normalizeApiBaseUrl(options.githubApiBaseUrl ?? DEFAULT_GITHUB_API)
    this.executor = options.executor ?? unavailableExecutor()
    this.state = state
  }

  async snapshot(): Promise<SourceUpdaterView> {
    return {
      id: "github-source-updater",
      configuration: this.configuration.snapshot(),
      current: { ...this.options.buildIdentity },
      candidate: this.state.candidate ? cloneCandidate(this.state.candidate) : null,
      executor: this.executor.snapshot(),
      operation: this.state.operation ? { ...this.state.operation } : null,
      lastCheckedAt: this.state.lastCheckedAt,
      nextCheckAt: this.state.nextCheckAt,
      error: this.state.error ? { ...this.state.error } : null,
    }
  }

  async updateConfiguration(input: SourceUpdaterConfigurationUpdate): Promise<SourceUpdaterView> {
    await this.configuration.update(input)
    this.scheduleNextCheck(true)
    return this.publish()
  }

  async setGitHubToken(token: string | undefined): Promise<SourceUpdaterView> {
    await this.configuration.setGitHubToken(token)
    this.state.error = null
    await this.persist()
    return this.publish()
  }

  async checkNow(): Promise<SourceUpdateOperationView> {
    if (this.checking) return this.checking
    this.checking = this.performCheck()
    try {
      return await this.checking
    } finally {
      this.checking = undefined
    }
  }

  async prepare(expectedTargetRevision?: string): Promise<SourceUpdateOperationView> {
    const candidate = this.requireCandidate(expectedTargetRevision)
    if (candidate.relation !== "ahead") {
      throw new SourceUpdaterError(
        "source_update_not_available",
        candidate.relation === "identical"
          ? "当前已经是 GitHub 上的最新版本"
          : "候选版本不是当前版本的快进更新，已阻止准备",
      )
    }
    if (this.options.buildIdentity.dirty) {
      throw new SourceUpdaterError(
        "source_update_dirty_worktree",
        "当前源码工作区有未提交修改，已阻止覆盖更新",
      )
    }
    this.requireExecutor("prepare")
    const operation = this.beginOperation("prepare", "正在准备 GitHub 源码更新", candidate.revision)
    await this.persist()
    await this.publish()
    try {
      await this.executor.prepare({
        operationId: operation.id,
        repository: this.configuration.current().repository,
        channel: candidate.channel,
        revision: candidate.revision,
        version: candidate.version,
      })
      operation.status = "prepared"
      operation.message = "更新已准备完成，可以应用"
      await this.finishOperation(operation)
      return operation
    } catch (error) {
      return this.failOperation(operation, error, "source_update_prepare_failed")
    }
  }

  async apply(input: {
    operationId: string
    expectedCurrentRevision: string | null
    expectedTargetRevision: string
  }): Promise<SourceUpdateOperationView> {
    const candidate = this.requireCandidate(input.expectedTargetRevision)
    this.requireExecutor("apply")
    const operation = this.state.operation
    if (
      !operation ||
      operation.id !== input.operationId ||
      (operation.status !== "prepared" && operation.status !== "waiting_for_idle")
    ) {
      throw new SourceUpdaterError("source_update_operation_conflict", "更新操作已过期，请重新准备")
    }
    if (this.options.buildIdentity.revision !== input.expectedCurrentRevision) {
      throw new SourceUpdaterError(
        "source_update_revision_conflict",
        "当前源码版本已经变化，请重新检查",
      )
    }
    const activity = this.activityProvider?.() ??
      this.options.activity?.() ?? {
        activeSolvers: 0,
        activeFatherTurns: 0,
        activeAudits: 0,
      }
    if (activity.activeSolvers + activity.activeFatherTurns + activity.activeAudits > 0) {
      operation.status = "waiting_for_idle"
      operation.message = "系统仍有运行中的 Solver、Father 或 Audit，请等待空闲后重试"
      await this.finishOperation(operation)
      throw new SourceUpdaterError("source_update_system_busy", operation.message)
    }
    if (candidate.revision !== input.expectedTargetRevision) {
      throw new SourceUpdaterError(
        "source_update_revision_conflict",
        "候选版本已经变化，请重新检查",
      )
    }

    this.maintenance ??= this.options.maintenance
    await this.maintenance?.begin()
    try {
      operation.status = "applying"
      operation.message = "正在切换源码版本并重启服务"
      operation.updatedAt = new Date().toISOString()
      await this.persist()
      await this.publish()
      await this.executor.apply({
        operationId: operation.id,
        repository: this.configuration.current().repository,
        revision: candidate.revision,
        expectedCurrentRevision: input.expectedCurrentRevision,
      })
      operation.status = "succeeded"
      operation.message = "源码版本已切换，Update Worker 已通过健康检查"
      await this.finishOperation(operation)
      return operation
    } catch (error) {
      return this.failOperation(operation, error, "source_update_apply_failed")
    } finally {
      await this.maintenance?.end()
    }
  }

  async rollback(operationId: string): Promise<SourceUpdateOperationView> {
    this.requireExecutor("rollback")
    const operation = this.state.operation
    if (!operation || operation.id !== operationId) {
      throw new SourceUpdaterError("source_update_operation_conflict", "找不到可回滚的更新操作")
    }
    operation.kind = "rollback"
    operation.status = "applying"
    operation.message = "正在回滚到上一个源码版本"
    operation.updatedAt = new Date().toISOString()
    await this.persist()
    await this.publish()
    try {
      await this.executor.rollback({ operationId })
      operation.status = "rolled_back"
      operation.message = "已回滚到上一个源码版本"
      await this.finishOperation(operation)
      return operation
    } catch (error) {
      operation.status = "rollback_failed"
      return this.failOperation(operation, error, "source_update_rollback_failed")
    }
  }

  start(): void {
    this.scheduleNextCheck(true)
  }

  setStatusListener(listener: (snapshot: SourceUpdaterView) => void | Promise<void>): void {
    const previous = this.options.onStatus
    this.options.onStatus = async (snapshot) => {
      await previous?.(snapshot)
      await listener(snapshot)
    }
  }

  setActivityProvider(provider: () => SourceUpdaterActivity): void {
    this.activityProvider = provider
  }

  setMaintenanceController(maintenance: SourceUpdaterMaintenance): void {
    this.maintenance = maintenance
  }

  close(): void {
    this.closed = true
    if (this.checkTimer) clearTimeout(this.checkTimer)
    this.checkTimer = undefined
  }

  private async performCheck(): Promise<SourceUpdateOperationView> {
    const operation = this.beginOperation("check", "正在检查 GitHub 源码版本", null)
    await this.persist()
    await this.publish()
    try {
      const current = this.configuration.current()
      if (!current.enabled) {
        operation.status = "succeeded"
        operation.message = "GitHub 源码更新插件未启用"
        await this.finishOperation(operation)
        return operation
      }
      const candidate = await this.resolveCandidate(current.repository, current.channel)
      this.state.candidate = candidate
      this.state.lastCheckedAt = new Date().toISOString()
      this.state.nextCheckAt = new Date(Date.now() + current.intervalMinutes * 60_000).toISOString()
      this.state.error = null
      operation.status = "succeeded"
      operation.targetRevision = candidate?.revision ?? null
      operation.message = candidate
        ? candidate.relation === "ahead"
          ? `发现可用更新：${candidate.revision.slice(0, 12)}`
          : candidate.relation === "identical"
            ? "当前已经是最新版本"
            : "GitHub 上没有可直接应用的快进更新"
        : "没有找到可用的 GitHub 版本"
      await this.finishOperation(operation)
      if (
        candidate?.relation === "ahead" &&
        current.channel.kind === "release" &&
        candidate.verified &&
        current.automaticApply &&
        (this.options.automaticApplyAllowed?.() ?? true) &&
        current.applyPolicy === "when-idle" &&
        this.executor.snapshot().canApply
      ) {
        void this.automaticallyApply(candidate.revision).catch(() => undefined)
      }
      return operation
    } catch (error) {
      return this.failOperation(operation, error, "source_update_check_failed")
    } finally {
      this.scheduleNextCheck(false)
    }
  }

  private async automaticallyApply(targetRevision: string): Promise<void> {
    const prepared = await this.prepare(targetRevision)
    await this.apply({
      operationId: prepared.id,
      expectedCurrentRevision: this.options.buildIdentity.revision,
      expectedTargetRevision: targetRevision,
    })
  }

  private async resolveCandidate(
    repository: string,
    channel: SourceUpdateChannel,
  ): Promise<SourceUpdateCandidateView | null> {
    const remote =
      channel.kind === "release"
        ? await this.latestRelease(repository)
        : await this.branchCommit(repository, channel.ref)
    if (!remote) return null
    const target = remote.commit
    const currentRevision = this.options.buildIdentity.revision
    let relation: SourceUpdateRelation = currentRevision ? "unknown" : "unknown"
    let aheadBy: number | null = null
    let behindBy: number | null = null
    if (currentRevision && currentRevision.toLowerCase() === target.sha.toLowerCase()) {
      relation = "identical"
      aheadBy = 0
      behindBy = 0
    } else if (currentRevision) {
      const compare = await this.compare(repository, currentRevision, target.sha)
      relation = compare.status
      aheadBy = compare.aheadBy
      behindBy = compare.behindBy
    }
    const version = channel.kind === "release" ? remote.version : null
    return {
      version,
      revision: target.sha,
      ref: remote.ref,
      channel:
        channel.kind === "release" ? { kind: "release" } : { kind: "branch", ref: channel.ref },
      htmlUrl: remote.htmlUrl,
      changelog: remote.changelog,
      publishedAt: remote.publishedAt,
      signatureVerified: target.signatureVerified,
      verified: target.signatureVerified,
      relation,
      aheadBy,
      behindBy,
    }
  }

  private async latestRelease(repository: string): Promise<RemoteCandidate | null> {
    const key = `release:${repository}`
    const response = await this.github<GitHubRelease>(
      key,
      `/repos/${encodeRepository(repository)}/releases/latest`,
    )
    const release = requirePayload(response.payload, "GitHub Release 响应无效")
    if (release.draft === true || release.prerelease === true) return null
    const tag = requiredText(release.tag_name, "GitHub Release 缺少 tag")
    const commit = await this.commit(repository, tag)
    return {
      ref: tag,
      version: tag.replace(/^v/iu, ""),
      htmlUrl: requiredUrl(release.html_url, "GitHub Release 链接无效"),
      changelog: optionalText(release.body),
      publishedAt: normalizeDate(release.published_at),
      commit,
    }
  }

  private async branchCommit(repository: string, ref: string): Promise<RemoteCandidate> {
    const commit = await this.commit(repository, ref)
    return {
      ref,
      version: null,
      htmlUrl: requiredUrl(commit.htmlUrl, "GitHub commit 链接无效"),
      changelog: commit.message,
      publishedAt: null,
      commit,
    }
  }

  private async commit(repository: string, ref: string): Promise<RemoteCommit> {
    const key = `commit:${repository}:${ref}`
    const response = await this.github<GitHubCommit>(
      key,
      `/repos/${encodeRepository(repository)}/commits/${encodeURIComponent(ref)}`,
    )
    const payload = requirePayload(response.payload, "GitHub commit 响应无效")
    const sha = requiredRevision(payload.sha, "GitHub commit SHA 无效")
    return {
      sha,
      htmlUrl: requiredUrl(payload.html_url, "GitHub commit 链接无效"),
      message: optionalText(payload.commit?.message),
      signatureVerified: payload.commit?.verification?.verified === true,
    }
  }

  private async compare(
    repository: string,
    current: string,
    target: string,
  ): Promise<{
    status: SourceUpdateRelation
    aheadBy: number | null
    behindBy: number | null
  }> {
    const key = `compare:${repository}:${current}...${target}`
    const response = await this.github<GitHubCompare>(
      key,
      `/repos/${encodeRepository(repository)}/compare/${encodeURIComponent(current)}...${encodeURIComponent(target)}`,
    )
    const payload = requirePayload(response.payload, "GitHub compare 响应无效")
    const status = payload.status
    if (
      status !== "ahead" &&
      status !== "behind" &&
      status !== "identical" &&
      status !== "diverged"
    ) {
      throw new SourceUpdaterError("source_update_compare_invalid", "GitHub compare 返回了未知关系")
    }
    return {
      status,
      aheadBy: integerOrNull(payload.ahead_by),
      behindBy: integerOrNull(payload.behind_by),
    }
  }

  private async github<T>(key: string, path: string): Promise<GitHubResponse<T>> {
    const cached = this.state.remote[key]
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
      "User-Agent": "ctf-agent-github-source-updater",
    }
    const token = this.options.secretStore.get(GITHUB_SOURCE_UPDATER_TOKEN)
    if (token) headers.Authorization = `Bearer ${token}`
    if (cached?.etag) headers["If-None-Match"] = cached.etag
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15_000)
    try {
      const response = await this.fetch(`${this.githubApiBaseUrl}${path}`, {
        method: "GET",
        headers,
        signal: controller.signal,
      })
      const etag = response.headers.get("etag")
      if (response.status === 304) {
        return {
          status: 304,
          etag: etag ?? cached?.etag ?? null,
          payload: (cached?.payload as T) ?? null,
        }
      }
      const body = await response.text()
      if (body.length > 2 * 1024 * 1024) {
        throw new SourceUpdaterError("source_update_response_too_large", "GitHub 响应超过大小限制")
      }
      let payload: unknown
      try {
        payload = body ? JSON.parse(body) : null
      } catch {
        throw new SourceUpdaterError("source_update_invalid_response", "GitHub 返回了无效 JSON")
      }
      if (!response.ok) {
        if (response.status === 404 && key.startsWith("release:")) {
          throw new SourceUpdaterError(
            "source_update_no_release",
            "GitHub 仓库没有可用的正式 Release",
          )
        }
        const message =
          response.status === 403 || response.status === 429
            ? "GitHub 请求受到限流或权限限制"
            : response.status === 404
              ? "GitHub 资源不存在或当前 Token 无权访问"
              : `GitHub 请求失败（HTTP ${response.status}）`
        throw new SourceUpdaterError(`source_update_github_${response.status}`, message)
      }
      this.state.remote[key] = { ...(etag ? { etag } : {}), payload }
      await this.persist()
      return { status: response.status, etag, payload: payload as T }
    } catch (error) {
      if (error instanceof SourceUpdaterError) throw error
      if (isAbortError(error)) {
        throw new SourceUpdaterError("source_update_github_timeout", "GitHub 请求超时")
      }
      throw new SourceUpdaterError("source_update_github_unavailable", "无法连接 GitHub", {
        cause: error,
      })
    } finally {
      clearTimeout(timeout)
    }
  }

  private requireCandidate(expectedTargetRevision?: string): SourceUpdateCandidateView {
    const candidate = this.state.candidate
    if (!candidate)
      throw new SourceUpdaterError("source_update_check_required", "请先检查 GitHub 更新")
    if (expectedTargetRevision && candidate.revision !== expectedTargetRevision) {
      throw new SourceUpdaterError(
        "source_update_revision_conflict",
        "候选版本已经变化，请重新检查",
      )
    }
    return candidate
  }

  private requireExecutor(action: "prepare" | "apply" | "rollback"): void {
    if (action === "prepare" && !this.executor.snapshot().canPrepare) {
      throw new SourceUpdaterError(
        "source_update_executor_unavailable",
        "更新执行器不可用，无法准备更新",
      )
    }
    if (action === "apply" && !this.executor.snapshot().canApply) {
      throw new SourceUpdaterError(
        "source_update_executor_unavailable",
        "更新执行器不可用，无法应用更新",
      )
    }
    if (action === "rollback" && !this.executor.snapshot().canApply) {
      throw new SourceUpdaterError(
        "source_update_executor_unavailable",
        "更新执行器不可用，无法回滚",
      )
    }
  }

  private beginOperation(
    kind: SourceUpdateOperationKind,
    message: string,
    targetRevision: string | null,
  ): SourceUpdateOperationView {
    const now = new Date().toISOString()
    const operation: SourceUpdateOperationView = {
      id: randomUUID(),
      kind,
      status: kind === "check" ? "checking" : kind === "prepare" ? "preparing" : "applying",
      currentRevision: this.options.buildIdentity.revision,
      targetRevision,
      message,
      startedAt: now,
      updatedAt: now,
    }
    this.state.operation = operation
    this.state.error = null
    return operation
  }

  private async finishOperation(operation: SourceUpdateOperationView): Promise<void> {
    operation.updatedAt = new Date().toISOString()
    this.state.operation = operation
    await this.persist()
    await this.publish()
  }

  private async failOperation(
    operation: SourceUpdateOperationView,
    error: unknown,
    fallbackCode: string,
  ): Promise<SourceUpdateOperationView> {
    const normalized = normalizeError(error, fallbackCode)
    operation.status = operation.kind === "rollback" ? "rollback_failed" : "failed"
    operation.message = normalized.message
    operation.error = normalized
    operation.updatedAt = new Date().toISOString()
    this.state.error = normalized
    await this.persist()
    await this.publish()
    return operation
  }

  private scheduleNextCheck(immediate: boolean): void {
    if (this.checkTimer) clearTimeout(this.checkTimer)
    this.checkTimer = undefined
    if (this.closed) return
    const current = this.configuration.current()
    if (!current.enabled || !current.automaticCheck) return
    const delay = immediate ? 1_000 : current.intervalMinutes * 60_000
    this.state.nextCheckAt = new Date(Date.now() + delay).toISOString()
    this.checkTimer = setTimeout(() => {
      void this.checkNow().catch(() => undefined)
    }, delay)
    this.checkTimer.unref()
    void this.persist()
      .then(() => this.publish())
      .catch(() => undefined)
  }

  private persist(): Promise<void> {
    const write = this.persistence.then(() => atomicWrite(this.statePath, this.state))
    this.persistence = write.catch(() => undefined)
    return write
  }

  private async publish(): Promise<SourceUpdaterView> {
    const snapshot = await this.snapshot()
    await this.options.onStatus?.(snapshot)
    return snapshot
  }
}

interface RemoteCommit {
  sha: string
  htmlUrl: string
  message: string | null
  signatureVerified: boolean
}

interface RemoteCandidate {
  ref: string
  version: string | null
  htmlUrl: string
  changelog: string | null
  publishedAt: string | null
  commit: RemoteCommit
}

export function createHttpSourceUpdateExecutor(options: {
  baseUrl: string
  token?: string
  fetch?: typeof globalThis.fetch
}): SourceUpdateExecutor {
  return new HttpSourceUpdateExecutor(options)
}

class HttpSourceUpdateExecutor implements SourceUpdateExecutor {
  private readonly fetch: typeof globalThis.fetch
  private readonly baseUrl: string

  constructor(
    private readonly options: { baseUrl: string; token?: string; fetch?: typeof globalThis.fetch },
  ) {
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.baseUrl = normalizeWorkerUrl(options.baseUrl)
  }

  snapshot(): SourceUpdateExecutorView {
    return {
      connected: true,
      protocolVersion: 1,
      canPrepare: true,
      canApply: true,
      reason: null,
    }
  }

  prepare(input: Parameters<SourceUpdateExecutor["prepare"]>[0]): Promise<{ message?: string }> {
    return this.request("/v1/operations/prepare", input)
  }

  apply(input: Parameters<SourceUpdateExecutor["apply"]>[0]): Promise<{ message?: string }> {
    return this.request("/v1/operations/apply", input)
  }

  rollback(input: Parameters<SourceUpdateExecutor["rollback"]>[0]): Promise<{ message?: string }> {
    return this.request("/v1/operations/rollback", input)
  }

  private async request(path: string, body: unknown): Promise<{ message?: string }> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30_000)
    try {
      const response = await this.fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.options.token ? { Authorization: `Bearer ${this.options.token}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      const raw = await response.text()
      let payload: unknown = {}
      try {
        payload = raw ? JSON.parse(raw) : {}
      } catch {
        payload = {}
      }
      if (!response.ok) {
        throw new SourceUpdaterError("source_update_executor_failed", "更新执行器拒绝了操作")
      }
      return isRecord(payload) && typeof payload.message === "string"
        ? { message: payload.message }
        : {}
    } catch (error) {
      if (error instanceof SourceUpdaterError) throw error
      if (isAbortError(error)) {
        throw new SourceUpdaterError("source_update_executor_timeout", "更新执行器响应超时")
      }
      throw new SourceUpdaterError("source_update_executor_unavailable", "无法连接更新执行器", {
        cause: error,
      })
    } finally {
      clearTimeout(timeout)
    }
  }
}

function unavailableExecutor(): SourceUpdateExecutor {
  return {
    snapshot: () => ({
      connected: false,
      protocolVersion: null,
      canPrepare: false,
      canApply: false,
      reason: "未配置 Update Worker；当前只能检查 GitHub 版本",
    }),
    prepare: async () => {
      throw new SourceUpdaterError("source_update_executor_unavailable", "未配置 Update Worker")
    },
    apply: async () => {
      throw new SourceUpdaterError("source_update_executor_unavailable", "未配置 Update Worker")
    },
    rollback: async () => {
      throw new SourceUpdaterError("source_update_executor_unavailable", "未配置 Update Worker")
    },
  }
}

async function readState(path: string): Promise<StoredState> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"))
    if (!isRecord(parsed) || parsed.version !== STATE_VERSION) return emptyState()
    return {
      version: STATE_VERSION,
      remote: isRecord(parsed.remote)
        ? (parsed.remote as Record<string, StoredRemoteResponse>)
        : {},
      candidate: isCandidate(parsed.candidate) ? parsed.candidate : null,
      operation: isOperation(parsed.operation) ? parsed.operation : null,
      lastCheckedAt: nullableDate(parsed.lastCheckedAt),
      nextCheckAt: nullableDate(parsed.nextCheckAt),
      error: isErrorView(parsed.error) ? parsed.error : null,
    }
  } catch (error) {
    if (hasCode(error, "ENOENT")) return emptyState()
    throw new Error(`无法读取 GitHub 源码更新状态: ${path}`, { cause: error })
  }
}

function emptyState(): StoredState {
  return {
    version: STATE_VERSION,
    remote: {},
    candidate: null,
    operation: null,
    lastCheckedAt: null,
    nextCheckAt: null,
    error: null,
  }
}

async function atomicWrite(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    })
    try {
      await rename(temporary, path)
    } catch (error) {
      if (!isReplaceRenameError(error)) throw error
      await rm(path, { force: true })
      await rename(temporary, path)
    }
    await chmod(path, 0o600)
  } finally {
    await rm(temporary, { force: true })
  }
}

function normalizeApiBaseUrl(value: string): string {
  const parsed = new URL(value)
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("GitHub API 地址必须是无凭据的 HTTPS URL")
  }
  return parsed.toString().replace(/\/$/, "")
}

function normalizeWorkerUrl(value: string): string {
  const parsed = new URL(value)
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("Update Worker 地址无效")
  }
  return parsed.toString().replace(/\/$/, "")
}

function encodeRepository(repository: string): string {
  return repository
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/")
}

function requirePayload<T>(payload: T | null, message: string): T {
  if (!payload) throw new SourceUpdaterError("source_update_invalid_response", message)
  return payload
}

function requiredText(value: unknown, message: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new SourceUpdaterError("source_update_invalid_response", message)
  return value.trim()
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 20_000) : null
}

function requiredUrl(value: unknown, message: string): string {
  const text = requiredText(value, message)
  try {
    const parsed = new URL(text)
    if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "github.com")
      throw new Error()
    return parsed.toString()
  } catch {
    throw new SourceUpdaterError("source_update_invalid_response", message)
  }
}

function requiredRevision(value: unknown, message: string): string {
  const revision = requiredText(value, message)
  if (!/^[a-f0-9]{7,64}$/iu.test(revision)) {
    throw new SourceUpdaterError("source_update_invalid_response", message)
  }
  return revision.toLowerCase()
}

function normalizeDate(value: unknown): string | null {
  if (typeof value !== "string") return null
  const timestamp = Date.parse(value)
  return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString()
}

function integerOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null
}

function normalizeError(error: unknown, fallbackCode: string): { code: string; message: string } {
  if (error instanceof SourceUpdaterError) return { code: error.code, message: error.message }
  return { code: fallbackCode, message: "GitHub 源码更新操作失败" }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError"
}

function cloneCandidate(candidate: SourceUpdateCandidateView): SourceUpdateCandidateView {
  return {
    ...candidate,
    channel: candidate.channel.kind === "release" ? { kind: "release" } : { ...candidate.channel },
  }
}

function isCandidate(value: unknown): value is SourceUpdateCandidateView {
  return (
    isRecord(value) &&
    typeof value.revision === "string" &&
    typeof value.htmlUrl === "string" &&
    isRecord(value.channel)
  )
}

function isOperation(value: unknown): value is SourceUpdateOperationView {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.kind === "string" &&
    typeof value.status === "string"
  )
}

function isErrorView(value: unknown): value is { code: string; message: string } {
  return isRecord(value) && typeof value.code === "string" && typeof value.message === "string"
}

function nullableDate(value: unknown): string | null {
  return value === null ? null : normalizeDate(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isReplaceRenameError(error: unknown): boolean {
  return hasCode(error, "EPERM") || hasCode(error, "EEXIST") || hasCode(error, "ENOTEMPTY")
}

function hasCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code
}
