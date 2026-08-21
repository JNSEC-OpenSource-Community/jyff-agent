import { createHash } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { type ProjectConfig, parseProjectConfig } from "../project/config.ts"

export interface ProjectActivation {
  /** 尚未开始时绝不连接平台；开始状态会在首次连接前落盘。 */
  state: "pending" | "started"
  /** null 表示由用户手动开始。 */
  scheduledStartAt: string | null
}

interface ProjectRegistryEntry {
  id: string
  directory: string
  createdAt: string
  updatedAt: string
  archived: boolean
  activation: ProjectActivation
}

interface ProjectRegistryFile {
  version: 1
  projects: ProjectRegistryEntry[]
}

export interface StoredProjectConfig {
  config: ProjectConfig
  stateDirectory: string
  createdAt: string
  updatedAt: string
  archived: boolean
  activation: ProjectActivation
  rootProject: boolean
}

/**
 * 持久化全局控制面下的 Project 注册表。
 *
 * 新 Project 使用哈希目录隔离状态；旧单 Project 文件继续映射到全局
 * `.ctf-agent` 目录，避免升级时丢失 runs.sqlite 和 workspace。
 */
export class ProjectConfigStore {
  readonly stateDirectory: string
  readonly path: string
  readonly registryPath: string

  constructor(readonly root: string) {
    this.stateDirectory = join(root, ".ctf-agent")
    this.path = join(this.stateDirectory, "project-config.json")
    this.registryPath = join(this.stateDirectory, "project-registry.json")
  }

  async list(): Promise<StoredProjectConfig[]> {
    const registry = await this.readRegistry()
    const records: StoredProjectConfig[] = []
    const ids = new Set<string>()
    for (const entry of registry.projects) {
      const stateDirectory = this.resolveStateDirectory(entry.directory)
      const config = await readConfig(join(stateDirectory, "project-config.json"))
      if (!config) {
        throw new Error(`Project 注册项缺少配置: ${entry.id}`)
      }
      if (config.project.id !== entry.id) {
        throw new Error(`Project 注册项与配置 ID 不一致: ${entry.id}`)
      }
      if (ids.has(entry.id)) throw new Error(`Project ID 重复: ${entry.id}`)
      ids.add(entry.id)
      records.push({
        config,
        stateDirectory,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        archived: entry.archived,
        activation: cloneActivation(entry.activation),
        rootProject: entry.directory === ".",
      })
    }

    return records
  }

  async load(projectId?: string): Promise<ProjectConfig | undefined> {
    const records = await this.list()
    const record = projectId
      ? records.find((candidate) => candidate.config.project.id === projectId)
      : records[0]
    return record ? structuredClone(record.config) : undefined
  }

  async loadProject(projectId: string): Promise<StoredProjectConfig | undefined> {
    const record = (await this.list()).find(
      (candidate) => candidate.config.project.id === projectId,
    )
    return record ? cloneRecord(record) : undefined
  }

  async save(config: ProjectConfig): Promise<ProjectConfig> {
    return (await this.saveProject(config)).config
  }

  async saveProject(
    config: ProjectConfig,
    activation?: ProjectActivation,
  ): Promise<StoredProjectConfig> {
    const validated = parseProjectConfig(config)
    const normalizedActivation = activation ? parseActivation(activation) : undefined
    const registry = await this.readRegistry()
    const records = await this.list()
    const existing = records.find(
      (candidate) => candidate.config.project.id === validated.project.id,
    )
    const now = new Date().toISOString()
    let entry = registry.projects.find((candidate) => candidate.id === validated.project.id)
    if (!entry) {
      entry = {
        id: validated.project.id,
        directory:
          existing?.rootProject || records.length === 0
            ? "."
            : `projects/${projectStorageKey(validated.project.id)}`,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        archived: existing?.archived ?? false,
        activation: cloneActivation(
          normalizedActivation ?? existing?.activation ?? startedActivation(),
        ),
      }
      registry.projects.push(entry)
    } else {
      entry.updatedAt = now
      if (normalizedActivation) entry.activation = cloneActivation(normalizedActivation)
    }

    const stateDirectory = this.resolveStateDirectory(entry.directory)
    await writeJsonAtomic(join(stateDirectory, "project-config.json"), validated)
    await writeJsonAtomic(this.registryPath, registry)
    return {
      config: validated,
      stateDirectory,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      archived: entry.archived,
      activation: cloneActivation(entry.activation),
      rootProject: entry.directory === ".",
    }
  }

  async deleteProject(projectId: string): Promise<StoredProjectConfig | undefined> {
    const registry = await this.readRegistry()
    const record = (await this.list()).find(
      (candidate) => candidate.config.project.id === projectId,
    )
    if (!record) return undefined

    await writeJsonAtomic(this.registryPath, {
      ...registry,
      projects: registry.projects.filter((entry) => entry.id !== projectId),
    })

    if (!record.rootProject) {
      const expectedDirectory = resolve(
        this.stateDirectory,
        "projects",
        projectStorageKey(projectId),
      )
      if (record.stateDirectory !== expectedDirectory) {
        throw new Error(`Project 状态目录与 ID 不匹配: ${projectId}`)
      }
      await rm(expectedDirectory, { recursive: true, force: true })
      return cloneRecord(record)
    }

    const projectArtifacts = [
      this.path,
      join(this.stateDirectory, "runtime-config.json"),
      join(this.stateDirectory, "runs.sqlite"),
      join(this.stateDirectory, "runs.sqlite-shm"),
      join(this.stateDirectory, "runs.sqlite-wal"),
      join(this.stateDirectory, "runs.sqlite-journal"),
      join(this.stateDirectory, "runs"),
      join(this.stateDirectory, "challenges"),
    ]
    await Promise.all(projectArtifacts.map((path) => rm(path, { recursive: true, force: true })))
    return cloneRecord(record)
  }

  /** 保留 Project 配置与运行配置，仅清除 Solver 产生的持久化状态。 */
  async resetProjectData(projectId: string): Promise<StoredProjectConfig> {
    const record = (await this.list()).find(
      (candidate) => candidate.config.project.id === projectId,
    )
    if (!record) throw new Error(`Project 不存在: ${projectId}`)

    if (!record.rootProject) {
      const expectedDirectory = resolve(
        this.stateDirectory,
        "projects",
        projectStorageKey(projectId),
      )
      if (record.stateDirectory !== expectedDirectory) {
        throw new Error(`Project 状态目录与 ID 不匹配: ${projectId}`)
      }
    }

    const solverArtifacts = [
      join(record.stateDirectory, "runs.sqlite"),
      join(record.stateDirectory, "runs.sqlite-shm"),
      join(record.stateDirectory, "runs.sqlite-wal"),
      join(record.stateDirectory, "runs.sqlite-journal"),
      join(record.stateDirectory, "runs"),
      join(record.stateDirectory, "challenges"),
    ]
    await Promise.all(solverArtifacts.map((path) => rm(path, { recursive: true, force: true })))
    return cloneRecord(record)
  }

  async setActivation(
    projectId: string,
    activation: ProjectActivation,
  ): Promise<StoredProjectConfig> {
    const registry = await this.readRegistry()
    const record = (await this.list()).find(
      (candidate) => candidate.config.project.id === projectId,
    )
    if (!record) throw new Error(`Project 不存在: ${projectId}`)
    const entry = registry.projects.find((candidate) => candidate.id === projectId)
    if (!entry) throw new Error(`Project 注册项不存在: ${projectId}`)
    const now = new Date().toISOString()
    entry.activation = parseActivation(activation)
    entry.updatedAt = now
    await writeJsonAtomic(this.registryPath, registry)
    return {
      ...record,
      updatedAt: now,
      activation: cloneActivation(entry.activation),
    }
  }

  async setArchived(projectId: string, archived: boolean): Promise<StoredProjectConfig> {
    const registry = await this.readRegistry()
    const record = (await this.list()).find(
      (candidate) => candidate.config.project.id === projectId,
    )
    if (!record) throw new Error(`Project 不存在: ${projectId}`)
    const now = new Date().toISOString()
    let entry = registry.projects.find((candidate) => candidate.id === projectId)
    if (!entry) {
      entry = {
        id: projectId,
        directory: record.rootProject ? "." : `projects/${projectStorageKey(projectId)}`,
        createdAt: record.createdAt,
        updatedAt: now,
        archived,
        activation: cloneActivation(record.activation),
      }
      registry.projects.push(entry)
    } else {
      entry.archived = archived
      entry.updatedAt = now
    }
    await writeJsonAtomic(this.registryPath, registry)
    return {
      ...record,
      updatedAt: now,
      archived,
      activation: cloneActivation(entry.activation),
    }
  }

  private async readRegistry(): Promise<ProjectRegistryFile> {
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(this.registryPath, "utf8"))
    } catch (error) {
      if (hasCode(error, "ENOENT")) return { version: 1, projects: [] }
      throw new Error(`无法读取 Project 注册表: ${this.registryPath}`, {
        cause: error,
      })
    }
    return parseRegistry(parsed)
  }

  private resolveStateDirectory(directory: string): string {
    if (directory !== "." && !/^projects\/[a-f0-9]{32}$/.test(directory)) {
      throw new Error(`Project 状态目录无效: ${directory}`)
    }
    return resolve(this.stateDirectory, directory)
  }
}

export function projectStorageKey(projectId: string): string {
  return createHash("sha256").update(projectId, "utf8").digest("hex").slice(0, 32)
}

function parseRegistry(value: unknown): ProjectRegistryFile {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.projects)) {
    throw new Error("Project 注册表格式无效")
  }
  const ids = new Set<string>()
  const directories = new Set<string>()
  const projects = value.projects.map((candidate, index) => {
    if (!isRecord(candidate)) {
      throw new Error(`Project 注册项 ${index} 格式无效`)
    }
    const id = requiredText(candidate.id, `projects[${index}].id`)
    const directory = requiredText(candidate.directory, `projects[${index}].directory`)
    const createdAt = requiredText(candidate.createdAt, `projects[${index}].createdAt`)
    const updatedAt = requiredText(candidate.updatedAt, `projects[${index}].updatedAt`)
    if (ids.has(id)) throw new Error(`Project ID 重复: ${id}`)
    if (directories.has(directory)) {
      throw new Error(`Project 状态目录重复: ${directory}`)
    }
    ids.add(id)
    directories.add(directory)
    const archived = candidate.archived === true
    const activation = parseActivation(candidate.activation)
    return { id, directory, createdAt, updatedAt, archived, activation }
  })
  return { version: 1, projects }
}

async function readConfig(path: string): Promise<ProjectConfig | undefined> {
  try {
    return parseProjectConfig(JSON.parse(await readFile(path, "utf8")))
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined
    throw new Error(`无法读取项目配置: ${path}`, { cause: error })
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8")
  await rename(temporary, path)
}

function cloneRecord(record: StoredProjectConfig): StoredProjectConfig {
  return {
    ...record,
    config: structuredClone(record.config),
    activation: cloneActivation(record.activation),
  }
}

function startedActivation(): ProjectActivation {
  return { state: "started", scheduledStartAt: null }
}

function parseActivation(value: unknown): ProjectActivation {
  // 旧注册表未记录比赛开始状态，升级后按已开始处理以保持原有启动语义。
  if (value === undefined) return startedActivation()
  if (!isRecord(value)) throw new Error("Project activation 格式无效")
  if (value.state !== "pending" && value.state !== "started") {
    throw new Error("Project activation state 无效")
  }
  const scheduledStartAt = optionalTimestamp(value.scheduledStartAt, "activation.scheduledStartAt")
  if (value.state === "started" && scheduledStartAt !== null) {
    throw new Error("已开始比赛不能保留 scheduledStartAt")
  }
  return { state: value.state, scheduledStartAt }
}

function cloneActivation(activation: ProjectActivation): ProjectActivation {
  return { ...activation }
}

function optionalTimestamp(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null
  const text = requiredText(value, label)
  const timestamp = Date.parse(text)
  if (Number.isNaN(timestamp)) throw new Error(`${label} 必须是有效时间`)
  return new Date(timestamp).toISOString()
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} 必须是非空字符串`)
  }
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code
}
