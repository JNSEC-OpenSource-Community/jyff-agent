import { execFile as execFileCallback } from "node:child_process"
import { randomUUID, timingSafeEqual } from "node:crypto"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

const execFile = promisify(execFileCallback)
const execTimeoutMs = 2 * 60 * 60 * 1_000
const healthTimeoutMs = 3_000
const healthAttempts = 60
const protocolVersion = 1

export interface UpdateWorkerOptions {
  host: string
  port: number
  token: string
  repository: string
  deploymentRoot: string
  releasesDirectory: string
  currentPath: string
  previousPath: string
  serviceName: string
  healthUrl: string
  allowApply: boolean
  runSandboxBuild: boolean
  githubToken?: string
  fetch?: typeof globalThis.fetch
}

interface WorkerOperation {
  id: string
  repository: string
  revision: string
  version: string | null
  stagingDirectory: string
  status: "preparing" | "prepared" | "applying" | "succeeded" | "failed" | "rolled_back"
  currentRevision: string | null
  previousTarget: string | null
  message: string
  updatedAt: string
}

interface WorkerState {
  version: 1
  operation: WorkerOperation | null
}

export class UpdateWorkerError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message)
    this.name = "UpdateWorkerError"
  }
}

export class SourceUpdateWorker {
  private state: WorkerState
  private queue: Promise<void> = Promise.resolve()
  private readonly fetch: typeof globalThis.fetch

  private constructor(
    private readonly options: UpdateWorkerOptions,
    private readonly statePath: string,
    state: WorkerState,
  ) {
    this.state = state
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis)
  }

  static async open(options: UpdateWorkerOptions): Promise<SourceUpdateWorker> {
    await mkdir(options.deploymentRoot, { recursive: true, mode: 0o750 })
    await mkdir(options.releasesDirectory, { recursive: true, mode: 0o750 })
    const statePath = join(options.deploymentRoot, ".source-updater-worker.json")
    return new SourceUpdateWorker(options, statePath, await readWorkerState(statePath))
  }

  async status(): Promise<Record<string, unknown>> {
    return {
      protocolVersion,
      connected: true,
      canPrepare: true,
      canApply: this.options.allowApply,
      reason: this.options.allowApply
        ? null
        : "Worker 未被授予应用权限；设置 CTF_AGENT_UPDATE_ALLOW_APPLY=1 后才允许切换",
      repository: this.options.repository,
      operation: this.state.operation ? publicOperation(this.state.operation) : null,
    }
  }

  async prepare(input: {
    operationId: string
    repository: string
    revision: string
    version?: string | null
  }): Promise<{ message: string }> {
    validateOperationInput(input, this.options.repository)
    return this.serialized(async () => {
      const existing = this.state.operation
      if (
        existing?.id === input.operationId &&
        existing.revision === input.revision &&
        existing.status === "prepared"
      ) {
        return { message: "候选源码已经准备完成" }
      }
      if (existing && ["preparing", "applying"].includes(existing.status)) {
        throw new UpdateWorkerError(
          "source_update_worker_busy",
          "Update Worker 正在处理另一个操作",
          409,
        )
      }
      const stagingDirectory = join(this.options.releasesDirectory, input.revision)
      await rm(stagingDirectory, { recursive: true, force: true })
      const operation: WorkerOperation = {
        id: input.operationId,
        repository: input.repository,
        revision: input.revision,
        version: input.version ?? null,
        stagingDirectory,
        status: "preparing",
        currentRevision: await currentRevision(this.options.currentPath),
        previousTarget: null,
        message: "正在获取并构建候选源码",
        updatedAt: now(),
      }
      this.state.operation = operation
      await this.persist()
      try {
        await this.prepareSource(operation)
        operation.status = "prepared"
        operation.message = "候选源码已通过构建校验"
        operation.updatedAt = now()
        await this.persist()
        return { message: operation.message }
      } catch (error) {
        operation.status = "failed"
        operation.message = workerErrorText(error)
        operation.updatedAt = now()
        await this.persist()
        await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined)
        throw normalizeWorkerError(error, "source_update_worker_prepare_failed")
      }
    })
  }

  async apply(input: {
    operationId: string
    repository: string
    revision: string
    expectedCurrentRevision: string | null
  }): Promise<{ message: string }> {
    validateOperationInput(input, this.options.repository)
    if (!this.options.allowApply) {
      throw new UpdateWorkerError(
        "source_update_worker_apply_disabled",
        "Update Worker 未开启应用权限",
        503,
      )
    }
    return this.serialized(async () => {
      const operation = this.state.operation
      if (
        !operation ||
        operation.id !== input.operationId ||
        operation.revision !== input.revision ||
        operation.status !== "prepared"
      ) {
        throw new UpdateWorkerError(
          "source_update_worker_operation_conflict",
          "候选源码尚未准备完成",
          409,
        )
      }
      const actualCurrent = await currentRevision(this.options.currentPath)
      if (actualCurrent !== input.expectedCurrentRevision) {
        throw new UpdateWorkerError(
          "source_update_worker_revision_conflict",
          "当前部署版本已经变化",
          409,
        )
      }
      const previousTarget = await switchCurrentTo(
        operation.stagingDirectory,
        this.options.currentPath,
        this.options.previousPath,
      )
      operation.previousTarget = previousTarget
      operation.currentRevision = actualCurrent
      operation.status = "applying"
      operation.message = "正在重启服务并执行健康检查"
      operation.updatedAt = now()
      await this.persist()
      try {
        await restartService(this.options.serviceName)
        await waitForHealth(this.fetch, this.options.healthUrl, operation.revision)
        operation.status = "succeeded"
        operation.message = "源码版本已应用，健康检查通过"
        operation.updatedAt = now()
        await this.persist()
        return { message: operation.message }
      } catch (error) {
        operation.status = "failed"
        operation.message = "新版本健康检查失败，正在恢复旧版本"
        operation.updatedAt = now()
        await this.persist()
        await restorePrevious(
          previousTarget,
          this.options.currentPath,
          this.options.previousPath,
        ).catch(() => undefined)
        await restartService(this.options.serviceName).catch(() => undefined)
        operation.message = workerErrorText(error)
        operation.updatedAt = now()
        await this.persist()
        throw normalizeWorkerError(error, "source_update_worker_health_failed", 503)
      }
    })
  }

  async rollback(input: { operationId: string }): Promise<{ message: string }> {
    if (!this.options.allowApply) {
      throw new UpdateWorkerError(
        "source_update_worker_apply_disabled",
        "Update Worker 未开启应用权限",
        503,
      )
    }
    return this.serialized(async () => {
      const operation = this.state.operation
      if (!operation || operation.id !== input.operationId || !operation.previousTarget) {
        throw new UpdateWorkerError(
          "source_update_worker_rollback_unavailable",
          "没有可回滚的部署版本",
          409,
        )
      }
      const currentTarget = await readLinkTarget(this.options.currentPath)
      await replaceLink(this.options.currentPath, operation.previousTarget)
      await replaceLink(this.options.previousPath, currentTarget)
      try {
        await restartService(this.options.serviceName)
        await waitForHealth(this.fetch, this.options.healthUrl, operation.previousTarget)
        operation.status = "rolled_back"
        operation.message = "已恢复上一个源码版本"
        operation.updatedAt = now()
        await this.persist()
        return { message: operation.message }
      } catch (error) {
        await replaceLink(this.options.currentPath, currentTarget).catch(() => undefined)
        await replaceLink(this.options.previousPath, operation.previousTarget).catch(
          () => undefined,
        )
        await restartService(this.options.serviceName).catch(() => undefined)
        operation.status = "failed"
        operation.message = workerErrorText(error)
        operation.updatedAt = now()
        await this.persist()
        throw normalizeWorkerError(error, "source_update_worker_rollback_failed", 503)
      }
    })
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.authorized(request)) {
      sendJson(response, 401, {
        error: "source_update_worker_unauthorized",
        message: "Worker 鉴权失败",
      })
      return
    }
    try {
      if (request.method === "GET" && request.url === "/v1/status") {
        sendJson(response, 200, await this.status())
        return
      }
      if (request.method !== "POST") {
        sendJson(response, 404, { error: "not_found" })
        return
      }
      const body = await readBody(request)
      if (request.url === "/v1/operations/prepare") {
        const input = parsePrepare(body)
        sendJson(response, 200, await this.prepare(input))
        return
      }
      if (request.url === "/v1/operations/apply") {
        const input = parseApply(body)
        sendJson(response, 200, await this.apply(input))
        return
      }
      if (request.url === "/v1/operations/rollback") {
        const input = parseRollback(body)
        sendJson(response, 200, await this.rollback(input))
        return
      }
      sendJson(response, 404, { error: "not_found" })
    } catch (error) {
      const normalized = normalizeWorkerError(error, "source_update_worker_failed")
      sendJson(response, normalized.status, { error: normalized.code, message: normalized.message })
    }
  }

  private authorized(request: IncomingMessage): boolean {
    const value = request.headers.authorization
    if (typeof value !== "string" || !value.startsWith("Bearer ")) return false
    const supplied = Buffer.from(value.slice("Bearer ".length))
    const expected = Buffer.from(this.options.token)
    return supplied.byteLength === expected.byteLength && timingSafeEqual(supplied, expected)
  }

  private async prepareSource(operation: WorkerOperation): Promise<void> {
    const remote = `https://github.com/${operation.repository}.git`
    const gitEnvironment = gitAuthEnvironment(this.options.githubToken)
    await runCommand("git", ["init", operation.stagingDirectory], { env: gitEnvironment })
    await runCommand("git", ["-C", operation.stagingDirectory, "remote", "add", "origin", remote], {
      env: gitEnvironment,
    })
    await runCommand(
      "git",
      ["-C", operation.stagingDirectory, "fetch", "--depth=1", "origin", operation.revision],
      { env: gitEnvironment },
    )
    await runCommand(
      "git",
      ["-C", operation.stagingDirectory, "checkout", "--detach", operation.revision],
      { env: gitEnvironment },
    )
    if (process.env.CTF_AGENT_UPDATE_SKIP_BUILD !== "1") {
      const vp = process.platform === "win32" ? "vp.cmd" : "vp"
      await runCommand(vp, ["install", "--frozen-lockfile"], { cwd: operation.stagingDirectory })
      await runCommand(vp, ["check"], { cwd: operation.stagingDirectory })
      await runCommand(vp, ["run", "typecheck"], { cwd: operation.stagingDirectory })
      await runCommand(vp, ["test"], { cwd: operation.stagingDirectory })
      await runCommand(vp, ["build"], { cwd: operation.stagingDirectory })
      if (this.options.runSandboxBuild) {
        await runCommand(vp, ["run", "build:sandbox"], { cwd: operation.stagingDirectory })
      }
    }
    await writeFile(
      join(operation.stagingDirectory, ".ctf-agent-build.json"),
      `${JSON.stringify({ version: operation.version, revision: operation.revision, repository: operation.repository }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    )
  }

  private async serialized<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.queue
    let release: (() => void) | undefined
    this.queue = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await operation()
    } finally {
      release?.()
    }
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true, mode: 0o750 })
    const temporary = `${this.statePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      })
      try {
        await rename(temporary, this.statePath)
      } catch (error) {
        if (!isReplaceRenameError(error)) throw error
        await rm(this.statePath, { force: true })
        await rename(temporary, this.statePath)
      }
      await chmod(this.statePath, 0o600)
    } finally {
      await rm(temporary, { force: true })
    }
  }
}

export async function createUpdateWorkerFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ worker: SourceUpdateWorker; options: UpdateWorkerOptions }> {
  const deploymentRoot = requiredPath(env.CTF_AGENT_UPDATE_ROOT, "CTF_AGENT_UPDATE_ROOT")
  const repository = requiredRepository(env.CTF_AGENT_REPOSITORY)
  const serviceName = requiredServiceName(env.CTF_AGENT_SERVICE_NAME)
  const token = requiredText(env.CTF_AGENT_UPDATE_WORKER_TOKEN, "CTF_AGENT_UPDATE_WORKER_TOKEN")
  const healthUrl = normalizeHealthUrl(
    env.CTF_AGENT_UPDATE_HEALTH_URL ?? "http://127.0.0.1:3000/health",
  )
  const options: UpdateWorkerOptions = {
    host: env.CTF_AGENT_UPDATE_WORKER_HOST ?? "127.0.0.1",
    port: positiveInteger(env.CTF_AGENT_UPDATE_WORKER_PORT, 5460),
    token,
    repository,
    deploymentRoot,
    releasesDirectory: requiredPath(
      env.CTF_AGENT_UPDATE_RELEASES_DIR ?? join(deploymentRoot, "releases"),
      "CTF_AGENT_UPDATE_RELEASES_DIR",
    ),
    currentPath: requiredPath(
      env.CTF_AGENT_UPDATE_CURRENT_PATH ?? join(deploymentRoot, "current"),
      "CTF_AGENT_UPDATE_CURRENT_PATH",
    ),
    previousPath: requiredPath(
      env.CTF_AGENT_UPDATE_PREVIOUS_PATH ?? join(deploymentRoot, "previous"),
      "CTF_AGENT_UPDATE_PREVIOUS_PATH",
    ),
    serviceName,
    healthUrl,
    allowApply: env.CTF_AGENT_UPDATE_ALLOW_APPLY === "1",
    runSandboxBuild: env.CTF_AGENT_UPDATE_BUILD_SANDBOX === "1",
    ...(env.CTF_GITHUB_UPDATER_TOKEN ? { githubToken: env.CTF_GITHUB_UPDATER_TOKEN } : {}),
  }
  return { worker: await SourceUpdateWorker.open(options), options }
}

export async function startUpdateWorker(): Promise<void> {
  const { worker, options } = await createUpdateWorkerFromEnvironment()
  const server = createServer((request, response) => {
    void worker.handle(request, response)
  })
  await new Promise<void>((resolveStart, reject) => {
    server.once("error", reject)
    server.listen(options.port, options.host, () => resolveStart())
  })
  console.log(`CTF Agent Update Worker 已启动：http://${options.host}:${options.port}`)
  const close = () => {
    server.close(() => process.exit(0))
  }
  process.once("SIGINT", close)
  process.once("SIGTERM", close)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await startUpdateWorker()
}

async function readWorkerState(path: string): Promise<WorkerState> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"))
    if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.operation)) {
      return { version: 1, operation: null }
    }
    return { version: 1, operation: parsed.operation as unknown as WorkerOperation }
  } catch (error) {
    if (hasCode(error, "ENOENT")) return { version: 1, operation: null }
    throw new Error(`无法读取 Update Worker 状态: ${path}`, { cause: error })
  }
}

function validateOperationInput(
  input: { operationId: string; repository: string; revision: string },
  repository: string,
): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.operationId)) {
    throw new UpdateWorkerError("source_update_worker_invalid_operation", "operationId 无效")
  }
  if (input.repository !== repository) {
    throw new UpdateWorkerError("source_update_worker_repository_mismatch", "Worker 拒绝非受信仓库")
  }
  if (!/^[a-f0-9]{40,64}$/iu.test(input.revision)) {
    throw new UpdateWorkerError("source_update_worker_invalid_revision", "revision 必须是 Git SHA")
  }
}

function parsePrepare(value: unknown): {
  operationId: string
  repository: string
  revision: string
  version?: string | null
} {
  if (!isRecord(value)) throw new UpdateWorkerError("invalid_json", "请求体必须是对象")
  return {
    operationId: requiredText(value.operationId, "operationId"),
    repository: requiredText(value.repository, "repository"),
    revision: requiredText(value.revision, "revision"),
    ...(value.version === null || typeof value.version === "string"
      ? { version: value.version }
      : {}),
  }
}

function parseApply(value: unknown): {
  operationId: string
  repository: string
  revision: string
  expectedCurrentRevision: string | null
} {
  if (!isRecord(value)) throw new UpdateWorkerError("invalid_json", "请求体必须是对象")
  return {
    operationId: requiredText(value.operationId, "operationId"),
    repository: requiredText(value.repository, "repository"),
    revision: requiredText(value.revision, "revision"),
    expectedCurrentRevision: nullableText(value.expectedCurrentRevision),
  }
}

function parseRollback(value: unknown): { operationId: string } {
  if (!isRecord(value)) throw new UpdateWorkerError("invalid_json", "请求体必须是对象")
  return { operationId: requiredText(value.operationId, "operationId") }
}

async function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<void> {
  try {
    await execFile(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      timeout: execTimeoutMs,
      maxBuffer: 256 * 1024,
      windowsHide: true,
    })
  } catch {
    throw new UpdateWorkerError("source_update_worker_build_failed", `更新校验步骤失败：${command}`)
  }
}

function gitAuthEnvironment(token: string | undefined): NodeJS.ProcessEnv | undefined {
  if (!token) return undefined
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}`,
  }
}

async function restartService(serviceName: string): Promise<void> {
  if (process.platform === "win32") {
    throw new UpdateWorkerError(
      "source_update_worker_service_unavailable",
      "Update Worker 暂不支持 Windows 服务重启",
      503,
    )
  }
  await runCommand("systemctl", ["restart", serviceName])
}

async function waitForHealth(
  fetch: typeof globalThis.fetch,
  healthUrl: string,
  expectedRevision: string,
): Promise<void> {
  for (let attempt = 0; attempt < healthAttempts; attempt += 1) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), healthTimeoutMs)
    try {
      const response = await fetch(healthUrl, { signal: controller.signal })
      if (response.ok) {
        const body = (await response.json()) as {
          status?: unknown
          buildIdentity?: { revision?: unknown }
        }
        if (body.status === "ok") {
          const revision = body.buildIdentity?.revision
          if (revision === undefined || revision === expectedRevision) return
        }
      }
    } catch {
      // 服务正在重启，继续轮询。
    } finally {
      clearTimeout(timeout)
    }
    await delay(1_000)
  }
  throw new UpdateWorkerError("source_update_worker_health_failed", "新版本健康检查超时", 503)
}

async function switchCurrentTo(
  stagingDirectory: string,
  currentPath: string,
  previousPath: string,
): Promise<string | null> {
  const previousTarget = await readLinkTarget(currentPath)
  await replaceLink(previousPath, previousTarget)
  await replaceLink(currentPath, stagingDirectory)
  return previousTarget
}

async function restorePrevious(
  previousTarget: string | null,
  currentPath: string,
  previousPath: string,
): Promise<void> {
  if (!previousTarget) return
  const currentTarget = await readLinkTarget(currentPath)
  await replaceLink(currentPath, previousTarget)
  await replaceLink(previousPath, currentTarget)
}

async function replaceLink(path: string, target: string | null): Promise<void> {
  if (!target) {
    await rm(path, { force: true })
    return
  }
  const temporary = `${path}.next-${process.pid}-${Date.now()}-${randomUUID()}`
  await rm(temporary, { force: true })
  await symlink(target, temporary, process.platform === "win32" ? "junction" : "dir")
  await rm(path, { force: true })
  await rename(temporary, path)
}

async function readLinkTarget(path: string): Promise<string | null> {
  try {
    const stats = await lstat(path)
    if (!stats.isSymbolicLink())
      throw new UpdateWorkerError("source_update_worker_invalid_layout", `${path} 必须是 symlink`)
    const target = await readlink(path)
    return resolve(dirname(path), target)
  } catch (error) {
    if (hasCode(error, "ENOENT")) return null
    throw error
  }
}

async function currentRevision(path: string): Promise<string | null> {
  const target = await readLinkTarget(path)
  if (!target) return null
  try {
    const parsed: unknown = JSON.parse(
      await readFile(join(target, ".ctf-agent-build.json"), "utf8"),
    )
    return isRecord(parsed) && typeof parsed.revision === "string" ? parsed.revision : null
  } catch {
    return null
  }
}

function normalizeWorkerError(
  error: unknown,
  fallbackCode: string,
  status = 400,
): UpdateWorkerError {
  if (error instanceof UpdateWorkerError) return error
  return new UpdateWorkerError(fallbackCode, "Update Worker 操作失败", status)
}

function workerErrorText(error: unknown): string {
  return error instanceof Error ? error.message : "Update Worker 操作失败"
}

function publicOperation(operation: WorkerOperation): Omit<WorkerOperation, "stagingDirectory"> {
  const { stagingDirectory: _stagingDirectory, ...safe } = operation
  return safe
}

function normalizeHealthUrl(value: string): string {
  const parsed = new URL(value)
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    !["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)
  ) {
    throw new Error("CTF_AGENT_UPDATE_HEALTH_URL 必须指向本机地址")
  }
  return parsed.toString()
}

function requiredRepository(value: string | undefined): string {
  const repository = requiredText(value, "CTF_AGENT_REPOSITORY")
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
    throw new Error("CTF_AGENT_REPOSITORY 无效")
  return repository
}

function requiredServiceName(value: string | undefined): string {
  const service = requiredText(value, "CTF_AGENT_SERVICE_NAME")
  if (!/^[A-Za-z0-9_.@-]+$/.test(service)) throw new Error("CTF_AGENT_SERVICE_NAME 无效")
  return service
}

function requiredPath(value: string | undefined, name: string): string {
  return resolve(requiredText(value, name))
}

function requiredText(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} 必须是非空字符串`)
  return value.trim()
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined
    ? null
    : requiredText(value, "expectedCurrentRevision")
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? fallback : Number(value)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) throw new Error("Worker 端口无效")
  return parsed
}

function now(): string {
  return new Date().toISOString()
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const raw = JSON.stringify(body)
  response.statusCode = status
  response.setHeader("Content-Type", "application/json; charset=utf-8")
  response.setHeader("Cache-Control", "no-store")
  response.end(raw)
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk as Uint8Array)
    size += buffer.byteLength
    if (size > 128 * 1024)
      throw new UpdateWorkerError("payload_too_large", "Worker 请求体过大", 413)
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"))
  } catch {
    throw new UpdateWorkerError("invalid_json", "Worker 请求体不是有效 JSON")
  }
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
