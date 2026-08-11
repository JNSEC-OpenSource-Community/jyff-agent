import { createHash } from "node:crypto"
import { cp, lstat, mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import {
  type PlatformPlugin,
  type PlatformPluginRegistry,
  type PlatformSetupDescriptor,
  type PlatformValidationProfile,
  type PlatformValidationReport,
  parsePlatformSetupDescriptor,
} from "@ctf-agent/platform"
import { DockerSandbox, type DockerWorkspaceMount } from "@ctf-agent/sandbox"

const MAX_EXTENSION_FILES = 200
const MAX_EXTENSION_BYTES = 2 * 1024 * 1024
const RESERVED_IDS = new Set(["ctfd", "gzctf", "ret2shell"])
const VALIDATION_REPORTS_DIRECTORY = ".validation-reports"

export interface PlatformExtensionManifest {
  schemaVersion: 2
  id: string
  name: string
  version: string
  entry: string
  setup?: PlatformSetupDescriptor
}

export interface PlatformValidationSandboxOptions {
  image: string
  workspaceMount?: (sessionId: string) => DockerWorkspaceMount
  sandboxFactory?: typeof DockerSandbox.create
}

export interface PlatformExtensionView {
  id: string
  name: string
  version: string
  activeRevision: string | null
  authorSessionId?: string
  validation?: PlatformValidationReport
}

export interface PlatformCandidateView {
  pluginId: string
  name: string
  version: string
  contentHash: string
  schemaFingerprint: string
  setup: PlatformSetupDescriptor
}

export class PlatformExtensionStore {
  private readonly reports = new Map<string, PlatformValidationReport>()

  private constructor(
    private readonly root: string,
    private readonly registry: PlatformPluginRegistry,
    private readonly validationSandbox?: PlatformValidationSandboxOptions,
  ) {}

  static async open(options: {
    root: string
    registry: PlatformPluginRegistry
    validationSandbox?: PlatformValidationSandboxOptions
  }): Promise<PlatformExtensionStore> {
    const store = new PlatformExtensionStore(
      join(resolve(options.root), ".ctf-agent", "extensions"),
      options.registry,
      options.validationSandbox,
    )
    await mkdir(store.root, { recursive: true })
    await store.loadInstalled()
    return store
  }

  async describeCandidate(candidateDirectory: string): Promise<PlatformCandidateView> {
    const candidate = await inspectCandidate(candidateDirectory)
    const setup = candidate.manifest.setup
    if (!setup) throw new Error("候选插件必须在 extension.json 中声明 setup")
    return {
      pluginId: candidate.manifest.id,
      name: candidate.manifest.name,
      version: candidate.manifest.version,
      contentHash: candidate.contentHash,
      schemaFingerprint: createHash("sha256").update(stableJson(setup)).digest("hex"),
      setup,
    }
  }

  async validate(input: {
    sessionId: string
    candidateDirectory: string
    profile: PlatformValidationProfile
  }): Promise<PlatformValidationReport> {
    const candidate = await inspectCandidate(input.candidateDirectory)
    if (!candidate.manifest.setup) throw new Error("候选插件必须在 extension.json 中声明 setup")
    if (!this.validationSandbox) throw new Error("Platform validation sandbox 未配置")
    const rawReport = await validateInSandbox({
      sandbox: this.validationSandbox,
      sessionId: input.sessionId,
      candidate,
      profile: input.profile,
    })
    const report = redactReport(rawReport, Object.values(input.profile.secrets ?? {}))
    this.reports.set(input.sessionId, report)
    await atomicWrite(this.validationReportPath(input.sessionId), JSON.stringify(report, null, 2))
    const reportPath = join(dirname(input.candidateDirectory), "validation-report.json")
    await atomicWrite(reportPath, JSON.stringify(report, null, 2))
    return report
  }

  async activate(input: {
    sessionId: string
    candidateDirectory: string
    validationReport?: PlatformValidationReport
  }): Promise<PlatformExtensionView> {
    const report =
      this.reports.get(input.sessionId) ??
      (await this.readValidationReport(input.sessionId)) ??
      input.validationReport
    if (!report || !["read_only_verified", "fully_verified"].includes(report.status)) {
      throw new Error("候选插件尚未通过 Validation Gate")
    }
    if (report.authorSessionId !== input.sessionId) {
      throw new Error("Validation Report 与 Father Session 不一致")
    }
    if (
      !/^[a-f0-9]{64}$/.test(report.contentHash) ||
      report.revision !== report.contentHash.slice(0, 16)
    ) {
      throw new Error("Validation Report revision 无效")
    }
    const candidate = await inspectCandidate(input.candidateDirectory)
    if (candidate.contentHash !== report.contentHash) {
      throw new Error("候选插件在验证后发生变化，必须重新验证")
    }
    if (candidate.manifest.id !== report.pluginId) {
      throw new Error("候选 manifest 与验证报告插件 ID 不一致")
    }
    this.reports.set(input.sessionId, report)
    await atomicWrite(this.validationReportPath(input.sessionId), JSON.stringify(report, null, 2))
    const revision = report.revision
    const target = this.revisionDirectory(candidate.manifest.id, revision)
    try {
      await lstat(target)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      await mkdir(dirname(target), { recursive: true })
      await cp(candidate.directory, target, {
        recursive: true,
        errorOnExist: true,
        force: false,
      })
      await atomicWrite(join(target, "validation-report.json"), JSON.stringify(report, null, 2))
      await atomicWrite(
        join(target, "author.json"),
        JSON.stringify({ sessionId: input.sessionId }, null, 2),
      )
    }
    const plugin = await loadPlugin(target, candidate.manifest)
    this.registry.registerExtension({
      plugin,
      revision,
      authorSessionId: input.sessionId,
    })
    await atomicWrite(
      join(this.extensionDirectory(candidate.manifest.id), "active.json"),
      JSON.stringify({ revision }, null, 2),
    )
    return {
      id: candidate.manifest.id,
      name: candidate.manifest.name,
      version: candidate.manifest.version,
      activeRevision: revision,
      authorSessionId: input.sessionId,
      validation: report,
    }
  }

  async list(): Promise<PlatformExtensionView[]> {
    const views: PlatformExtensionView[] = []
    for (const registration of this.registry.list()) {
      if (registration.source !== "extension") continue
      const id = registration.plugin.id
      const revision = registration.revision ?? null
      if (!revision) continue
      const directory = this.revisionDirectory(id, revision)
      const manifest = parseManifest(
        JSON.parse(await readFile(join(directory, "extension.json"), "utf8")),
      )
      let validation: PlatformValidationReport | undefined
      try {
        validation = JSON.parse(
          await readFile(join(directory, "validation-report.json"), "utf8"),
        ) as PlatformValidationReport
      } catch {
        validation = undefined
      }
      views.push({
        id,
        name: manifest.name,
        version: manifest.version,
        activeRevision: revision,
        ...(registration.authorSessionId ? { authorSessionId: registration.authorSessionId } : {}),
        ...(validation ? { validation } : {}),
      })
    }
    return views.sort((left, right) => left.id.localeCompare(right.id))
  }

  async readCandidateEntry(candidateDirectory: string): Promise<{
    filename: string
    content: Buffer
  }> {
    const candidate = await inspectCandidate(candidateDirectory)
    if (!candidate.manifest.entry.endsWith(".ts")) {
      throw new Error("候选插件入口不是 TypeScript 文件")
    }
    return {
      filename: `${candidate.manifest.id}.ts`,
      content: await readFile(join(candidate.directory, candidate.manifest.entry)),
    }
  }

  async deleteValidationReport(sessionId: string): Promise<void> {
    this.reports.delete(sessionId)
    await unlink(this.validationReportPath(sessionId)).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    })
  }

  private async loadInstalled(): Promise<void> {
    const entries = await readdir(this.root, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === VALIDATION_REPORTS_DIRECTORY) continue
      if (this.registry.resolve(entry.name)) {
        console.warn(`[extensions] 跳过已内置的平台扩展: ${entry.name}`)
        continue
      }
      try {
        const extensionDirectory = this.extensionDirectory(entry.name)
        const active = JSON.parse(
          await readFile(join(extensionDirectory, "active.json"), "utf8"),
        ) as { revision?: unknown }
        if (typeof active.revision !== "string") continue
        const revisionDirectory = this.revisionDirectory(entry.name, active.revision)
        const manifest = parseManifest(
          JSON.parse(await readFile(join(revisionDirectory, "extension.json"), "utf8")),
        )
        const author = JSON.parse(
          await readFile(join(revisionDirectory, "author.json"), "utf8"),
        ) as { sessionId?: unknown }
        if (typeof author.sessionId !== "string") continue
        const plugin = await loadPlugin(revisionDirectory, manifest)
        this.registry.registerExtension({
          plugin,
          revision: active.revision,
          authorSessionId: author.sessionId,
        })
      } catch (error) {
        console.error(
          `[extensions] 无法加载 ${entry.name}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  }

  private extensionDirectory(id: string): string {
    return join(this.root, id)
  }

  private revisionDirectory(id: string, revision: string): string {
    return join(this.extensionDirectory(id), "revisions", revision)
  }

  private validationReportPath(sessionId: string): string {
    const key = createHash("sha256").update(sessionId).digest("hex")
    return join(this.root, VALIDATION_REPORTS_DIRECTORY, `${key}.json`)
  }

  private async readValidationReport(
    sessionId: string,
  ): Promise<PlatformValidationReport | undefined> {
    try {
      return JSON.parse(
        await readFile(this.validationReportPath(sessionId), "utf8"),
      ) as PlatformValidationReport
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw new Error("持久化 Validation Report 无效", { cause: error })
    }
  }
}

async function inspectCandidate(directory: string): Promise<{
  directory: string
  manifest: PlatformExtensionManifest
  contentHash: string
}> {
  const root = resolve(directory)
  const files: Array<{ path: string; content: Buffer }> = []
  await walk(root, "", files)
  if (files.length === 0) throw new Error("候选插件目录为空")
  if (files.length > MAX_EXTENSION_FILES) throw new Error("候选插件文件过多")
  const total = files.reduce((sum, file) => sum + file.content.byteLength, 0)
  if (total > MAX_EXTENSION_BYTES) throw new Error("候选插件超过 2 MiB")
  const manifestFile = files.find(({ path }) => path === "extension.json")
  if (!manifestFile) throw new Error("候选插件缺少 extension.json")
  const manifest = parseManifest(JSON.parse(manifestFile.content.toString("utf8")))
  if (!files.some(({ path }) => path === manifest.entry)) {
    throw new Error(`候选入口不存在: ${manifest.entry}`)
  }
  const hash = createHash("sha256")
  for (const file of files.sort((left, right) => left.path.localeCompare(right.path))) {
    hash.update(file.path)
    hash.update("\0")
    hash.update(file.content)
    hash.update("\0")
  }
  return { directory: root, manifest, contentHash: hash.digest("hex") }
}

async function walk(
  root: string,
  suffix: string,
  files: Array<{ path: string; content: Buffer }>,
): Promise<void> {
  const directory = suffix ? join(root, suffix) : root
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relativePath = suffix ? `${suffix.replaceAll("\\", "/")}/${entry.name}` : entry.name
    const target = join(root, relativePath)
    const stat = await lstat(target)
    if (stat.isSymbolicLink()) throw new Error(`候选插件禁止 symlink: ${relativePath}`)
    if (stat.isDirectory()) {
      await walk(root, relativePath, files)
    } else if (stat.isFile()) {
      files.push({
        path: relativePath.replaceAll("\\", "/"),
        content: await readFile(target),
      })
    } else {
      throw new Error(`候选插件包含不支持的文件: ${relativePath}`)
    }
  }
}

function parseManifest(value: unknown): PlatformExtensionManifest {
  if (!value || typeof value !== "object") throw new Error("extension.json 无效")
  const manifest = value as Record<string, unknown>
  const keys = Object.keys(manifest)
  const allowed = new Set(["schemaVersion", "id", "name", "version", "entry", "setup"])
  if (keys.some((key) => !allowed.has(key))) throw new Error("extension.json 包含未知字段")
  if (manifest.schemaVersion !== 2) throw new Error("只支持 extension schema v2")
  if (typeof manifest.id !== "string" || !/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(manifest.id)) {
    throw new Error("extension ID 无效")
  }
  if (RESERVED_IDS.has(manifest.id)) throw new Error("不能覆盖内置插件 ID")
  if (typeof manifest.name !== "string" || !manifest.name.trim())
    throw new Error("extension name 无效")
  if (typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+$/.test(manifest.version)) {
    throw new Error("extension version 必须使用 semver")
  }
  if (typeof manifest.entry !== "string") throw new Error("extension entry 无效")
  const normalizedEntry = manifest.entry.replaceAll("\\", "/")
  if (
    normalizedEntry.startsWith("/") ||
    normalizedEntry.split("/").some((segment) => !segment || segment === "." || segment === "..") ||
    !/\.(?:js|mjs|ts)$/.test(normalizedEntry)
  ) {
    throw new Error("extension entry 必须是目录内的 JS/TS 文件")
  }
  return {
    schemaVersion: manifest.schemaVersion,
    id: manifest.id,
    name: manifest.name.trim(),
    version: manifest.version,
    entry: normalizedEntry,
    setup: parsePlatformSetupDescriptor(manifest.setup),
  }
}

async function validateInSandbox(input: {
  sandbox: PlatformValidationSandboxOptions
  sessionId: string
  candidate: Awaited<ReturnType<typeof inspectCandidate>>
  profile: PlatformValidationProfile
}): Promise<PlatformValidationReport> {
  const workspace = dirname(input.candidate.directory)
  const runtime = join(workspace, ".father-runtime")
  await mkdir(runtime, { recursive: true })
  await Promise.all([
    cp(
      fileURLToPath(new URL("./validation-runner.ts", import.meta.url)),
      join(runtime, "validation-runner.ts"),
    ),
    cp(
      fileURLToPath(new URL("../../../platform/src/validation.ts", import.meta.url)),
      join(runtime, "platform-validation.ts"),
    ),
  ])
  const sandboxFactory =
    input.sandbox.sandboxFactory ?? ((sandboxOptions) => DockerSandbox.create(sandboxOptions))
  const sandbox = await sandboxFactory({
    projectId: "father-validation",
    runId: `${input.sessionId.slice("father-".length, 26)}-${Date.now()}`,
    image: input.sandbox.image,
    workspace,
    ...(input.sandbox.workspaceMount
      ? { workspaceMount: input.sandbox.workspaceMount(input.sessionId) }
      : {}),
    privileged: false,
    networkMode: "bridge",
    resources: {
      cpus: 2,
      memoryBytes: 1024 * 1024 * 1024,
      memorySwapBytes: 1024 * 1024 * 1024,
      pidsLimit: 256,
      storageBytes: 2 * 1024 * 1024 * 1024,
    },
  })
  try {
    const result = await sandbox.exec(
      ["node", "--experimental-strip-types", "/workspace/.father-runtime/validation-runner.ts"],
      {
        input: JSON.stringify({
          entry: `/workspace/output/${input.candidate.manifest.entry}`,
          pluginId: input.candidate.manifest.id,
          manifestSetup: input.candidate.manifest.setup,
          revision: input.candidate.contentHash.slice(0, 16),
          contentHash: input.candidate.contentHash,
          authorSessionId: input.sessionId,
          profile: input.profile,
        }),
        timeoutMs: 5 * 60_000,
      },
    )
    if (result.code !== 0) {
      throw new Error(`Docker validation failed with exit code ${result.code}`)
    }
    const marker = "__FATHER_REPORT__"
    const offset = result.stdout.lastIndexOf(marker)
    if (offset < 0) throw new Error("Docker validation did not return a report")
    return JSON.parse(result.stdout.slice(offset + marker.length)) as PlatformValidationReport
  } finally {
    await sandbox.close().catch(() => undefined)
  }
}

function redactReport(
  report: PlatformValidationReport,
  secrets: readonly (string | undefined)[],
): PlatformValidationReport {
  let serialized = JSON.stringify(report)
  for (const secret of secrets) {
    if (secret) serialized = serialized.replaceAll(secret, "[redacted]")
  }
  return JSON.parse(serialized) as PlatformValidationReport
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

async function loadPlugin(
  directory: string,
  manifest: PlatformExtensionManifest,
): Promise<PlatformPlugin> {
  const entry = resolve(directory, manifest.entry)
  const suffix = relative(resolve(directory), entry)
  if (suffix === ".." || suffix.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error("extension entry 逃逸候选目录")
  }
  const module = (await import(
    `${pathToFileURL(entry).href}?revision=${Date.now()}-${Math.random()}`
  )) as { default?: unknown; platformPlugin?: unknown }
  const plugin = module.platformPlugin ?? module.default
  if (!isPlatformPlugin(plugin)) throw new Error("入口未导出有效 PlatformPlugin")
  if (plugin.id !== manifest.id) throw new Error("manifest ID 与插件导出 ID 不一致")
  return plugin
}

function isPlatformPlugin(value: unknown): value is PlatformPlugin {
  if (!value || typeof value !== "object") return false
  const plugin = value as Partial<PlatformPlugin>
  return (
    typeof plugin.id === "string" &&
    typeof plugin.config?.parse === "function" &&
    typeof plugin.connect === "function"
  )
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`
  await writeFile(temporary, content)
  await rename(temporary, path)
}
