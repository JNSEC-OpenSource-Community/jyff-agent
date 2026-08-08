import { createHash } from "node:crypto"
import { join, resolve } from "node:path"
import type {
  PlatformPlugin,
  PlatformProject,
  PlatformSetupDescriptor,
} from "@ctf-agent/platform"
import { AnnouncementPoller } from "../orchestration/announcement-poller.ts"
import type { ContestScheduler } from "../orchestration/contest-scheduler.ts"
import { type ProjectConfig, parseProjectConfig } from "../project/config.ts"
import { type OpenProjectOptions, Project } from "../project/project.ts"
import {
  ProjectConfigStore,
  projectStorageKey,
  type StoredProjectConfig,
} from "./config-store.ts"
import { FileSecretStore, type SecretStore } from "./secret-store.ts"

export type ControlPlanePhase =
  | "unconfigured"
  | "disconnected"
  | "connecting"
  | "ready"
  | "degraded"
  | "closing"

export interface ControlPlaneProjectSnapshot {
  id: string
  name: string
  platformId: string
  phase: Exclude<ControlPlanePhase, "unconfigured">
  lastError: string | null
  createdAt: string
  updatedAt: string
  archived: boolean
}

export interface ControlPlaneSnapshot {
  phase: ControlPlanePhase
  configured: boolean
  projectId: string | null
  projectName: string | null
  platformId: string | null
  lastError: string | null
  updatedAt: string
  selectedProjectId: string | null
  projects: ControlPlaneProjectSnapshot[]
}

export interface PlatformConnectionTest {
  ok: true
  overview: {
    id: string
    name: string
    challenges: number
    announcements: number
  }
}

export interface ControlPlaneSetupSnapshot {
  state: ControlPlaneSnapshot
  config: ProjectConfig | null
  platforms: Array<{ id: string; setup: PlatformSetupDescriptor }>
  secrets: Record<string, { configured: boolean; source: "store" | "none" }>
}

export interface ApplyControlPlaneSetup {
  config: ProjectConfig
  secrets?: Readonly<Record<string, string | undefined>>
}

export interface ControlPlaneOptions {
  root: string
  platforms: readonly PlatformPlugin[]
  secretStore?: SecretStore
  project?: Omit<
    OpenProjectOptions,
    | "root"
    | "config"
    | "stateDirectory"
    | "workspaceNamespace"
    | "platforms"
    | "resolveSecret"
  >
  createProjectOptions?: (context: {
    projectId: string
    stateDirectory: string
  }) =>
    | Omit<
        OpenProjectOptions,
        | "root"
        | "config"
        | "stateDirectory"
        | "workspaceNamespace"
        | "platforms"
        | "resolveSecret"
      >
    | Promise<
        Omit<
          OpenProjectOptions,
          | "root"
          | "config"
          | "stateDirectory"
          | "workspaceNamespace"
          | "platforms"
          | "resolveSecret"
        >
      >
  createScheduler?: (
    project: Project,
    context: { projectId: string; stateDirectory: string },
  ) => ContestScheduler | undefined | Promise<ContestScheduler | undefined>
  announcementPollIntervalMs?: number
}

interface ManagedProjectRuntime {
  record: StoredProjectConfig
  phase: Exclude<ControlPlanePhase, "unconfigured">
  lastError: string | null
  updatedAt: string
  project?: Project
  scheduler?: ContestScheduler
  announcementPoller?: AnnouncementPoller
}

/** Owns the global Project registry and one isolated runtime per configured Project. */
export class ControlPlane {
  readonly root: string
  private readonly platforms: readonly PlatformPlugin[]
  private readonly configStore: ProjectConfigStore
  private readonly secretStore: SecretStore
  private readonly options: ControlPlaneOptions
  private readonly runtimes = new Map<string, ManagedProjectRuntime>()
  private selectedProjectId?: string
  private loadError: string | null = null
  private closing = false
  private transitionTail: Promise<void> = Promise.resolve()

  private constructor(options: ControlPlaneOptions, secretStore: SecretStore) {
    this.options = options
    this.root = resolve(options.root)
    this.platforms = options.platforms
    this.configStore = new ProjectConfigStore(this.root)
    this.secretStore = secretStore
  }

  static async create(options: ControlPlaneOptions): Promise<ControlPlane> {
    const root = resolve(options.root)
    const secretStore =
      options.secretStore ??
      (await FileSecretStore.open(join(root, ".ctf-agent", "secrets.json")))
    const control = new ControlPlane(options, secretStore)
    try {
      const records = await control.configStore.list()
      for (const record of records) {
        control.runtimes.set(record.config.project.id, {
          record,
          phase: "disconnected",
          lastError: null,
          updatedAt: record.updatedAt,
        })
      }
      control.selectedProjectId = records[0]?.config.project.id
    } catch (error) {
      control.loadError = errorText(error)
    }
    return control
  }

  snapshot(projectId?: string): ControlPlaneSnapshot {
    const selectedId = projectId ?? this.selectedProjectId
    const runtime = selectedId ? this.runtimes.get(selectedId) : undefined
    const projects = this.projectSnapshots()
    if (!runtime) {
      return {
        phase: this.closing
          ? "closing"
          : this.loadError
            ? "degraded"
            : "unconfigured",
        configured: projects.length > 0,
        projectId: null,
        projectName: null,
        platformId: null,
        lastError: this.loadError,
        updatedAt:
          projects.reduce<string | undefined>(
            (latest, item) =>
              !latest || item.updatedAt.localeCompare(latest) > 0
                ? item.updatedAt
                : latest,
            undefined,
          ) ?? new Date().toISOString(),
        selectedProjectId: this.selectedProjectId ?? null,
        projects,
      }
    }
    const state = this.runtimeSnapshot(runtime)
    return {
      phase: this.closing ? "closing" : state.phase,
      configured: true,
      projectId: state.id,
      projectName: state.name,
      platformId: state.platformId,
      lastError: state.lastError,
      updatedAt: state.updatedAt,
      selectedProjectId: this.selectedProjectId ?? null,
      projects,
    }
  }

  projectSnapshots(): ControlPlaneProjectSnapshot[] {
    return [...this.runtimes.values()].map((runtime) =>
      this.runtimeSnapshot(runtime),
    )
  }

  configuration(projectId?: string): ProjectConfig | undefined {
    const runtime = this.resolveRuntime(projectId)
    return runtime ? structuredClone(runtime.record.config) : undefined
  }

  setupSnapshot(projectId?: string): ControlPlaneSetupSnapshot {
    const platforms = this.platforms.flatMap((plugin) =>
      plugin.setup ? [{ id: plugin.id, setup: plugin.setup }] : [],
    )
    const names = new Set(
      platforms.flatMap(({ setup }) =>
        setup.authStrategies.flatMap((strategy) =>
          strategy.secrets.map((secret) => secret.name),
        ),
      ),
    )
    const resolvedProjectId = this.resolveProjectId(projectId)
    return {
      state: this.snapshot(projectId),
      config: this.configuration(projectId) ?? null,
      platforms,
      secrets: Object.fromEntries(
        [...names].map((name) => [
          name,
          {
            configured: this.hasProjectSecret(resolvedProjectId, name),
            source: this.hasProjectSecret(resolvedProjectId, name)
              ? "store"
              : "none",
          },
        ]),
      ),
    }
  }

  selectProject(projectId: string): ControlPlaneSnapshot {
    if (!this.runtimes.has(projectId)) {
      throw new Error(`Project 不存在: ${projectId}`)
    }
    this.selectedProjectId = projectId
    return this.snapshot(projectId)
  }

  currentProject(projectId?: string): Project | undefined {
    return this.resolveRuntime(projectId)?.project
  }

  currentScheduler(projectId?: string): ContestScheduler | undefined {
    return this.resolveRuntime(projectId)?.scheduler
  }

  async start(): Promise<ControlPlaneSnapshot> {
    return await this.enqueueTransition(async () => {
      for (const projectId of this.runtimes.keys()) {
        try {
          await this.performConnect(projectId)
        } catch {
          // 单个 Project 降级不阻塞其他 Project 启动。
        }
      }
      return this.snapshot()
    })
  }

  async connect(projectId?: string): Promise<ControlPlaneSnapshot> {
    return await this.enqueueTransition(async () => {
      const id = this.resolveProjectId(projectId)
      if (!id) return this.snapshot()
      this.selectedProjectId = id
      await this.performConnect(id)
      return this.snapshot(id)
    })
  }

  async testConnection(
    input: ApplyControlPlaneSetup,
  ): Promise<PlatformConnectionTest> {
    const config = this.validateConfig(input.config)
    const plugin = this.plugin(config.platform.plugin)
    const platform = await plugin.connect({
      project: config.project,
      config: plugin.config.parse(config.platform.config),
      resolveSecret: this.secretResolver(config.project.id, input.secrets),
    })
    return await inspectAndClose(platform)
  }

  async applySetup(
    input: ApplyControlPlaneSetup,
  ): Promise<ControlPlaneSnapshot> {
    return await this.enqueueTransition(async () => {
      const config = this.validateConfig(input.config)
      await this.testConnection({ config, secrets: input.secrets })
      if (this.runtimes.has(config.project.id)) {
        await this.performDisconnect(config.project.id)
      }
      if (input.secrets) {
        await this.secretStore.set(
          namespaceProjectSecrets(config.project.id, input.secrets),
        )
      }
      const record = await this.configStore.saveProject(config)
      this.runtimes.set(config.project.id, {
        record,
        phase: "disconnected",
        lastError: null,
        updatedAt: record.updatedAt,
      })
      this.selectedProjectId = config.project.id
      await this.performConnect(config.project.id)
      return this.snapshot(config.project.id)
    })
  }

  async disconnect(projectId?: string): Promise<ControlPlaneSnapshot> {
    return await this.enqueueTransition(async () => {
      const id = this.resolveProjectId(projectId)
      if (!id) return this.snapshot()
      await this.performDisconnect(id)
      return this.snapshot(id)
    })
  }

  async deleteProject(projectId: string): Promise<ControlPlaneSnapshot> {
    return await this.enqueueTransition(async () => {
      if (!this.runtimes.has(projectId)) {
        throw new Error(`Project 不存在: ${projectId}`)
      }
      await this.performDisconnect(projectId)
      const deleted = await this.configStore.deleteProject(projectId)
      if (!deleted) throw new Error(`Project 不存在: ${projectId}`)

      const secretNames = new Set(
        this.platforms.flatMap(
          (plugin) =>
            plugin.setup?.authStrategies.flatMap((strategy) =>
              strategy.secrets.map((secret) => secret.name),
            ) ?? [],
        ),
      )
      await this.secretStore.set(
        Object.fromEntries(
          [...secretNames].map((name) => [
            projectSecretName(projectId, name),
            undefined,
          ]),
        ),
      )
      this.runtimes.delete(projectId)
      if (this.selectedProjectId === projectId) {
        this.selectedProjectId = this.runtimes.keys().next().value
      }
      return this.snapshot()
    })
  }

  async archiveProject(
    projectId: string,
    archived: boolean,
  ): Promise<ControlPlaneSnapshot> {
    return await this.enqueueTransition(async () => {
      const runtime = this.runtimes.get(projectId)
      if (!runtime) throw new Error(`Project 不存在: ${projectId}`)
      runtime.record = await this.configStore.setArchived(projectId, archived)
      runtime.updatedAt = runtime.record.updatedAt
      return this.snapshot(projectId)
    })
  }

  async close(): Promise<void> {
    await this.enqueueTransition(async () => {
      this.closing = true
      const failures: unknown[] = []
      for (const projectId of this.runtimes.keys()) {
        try {
          await this.performDisconnect(projectId)
        } catch (error) {
          failures.push(error)
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, "ControlPlane 关闭时资源清理失败")
      }
      return this.snapshot()
    })
  }

  private async performDisconnect(projectId: string): Promise<void> {
    const runtime = this.runtimes.get(projectId)
    if (!runtime) return
    const failures: unknown[] = []
    const scheduler = runtime.scheduler
    const project = runtime.project
    runtime.announcementPoller?.stop()
    runtime.announcementPoller = undefined
    runtime.scheduler = undefined
    runtime.project = undefined
    if (scheduler) {
      try {
        await scheduler.shutdown()
      } catch (error) {
        failures.push(error)
      }
    }
    if (project) {
      try {
        await project.close()
      } catch (error) {
        failures.push(error)
      }
    }
    this.setRuntimePhase(runtime, "disconnected")
    if (failures.length > 0) {
      runtime.lastError = failures.map(errorText).join("\n")
      this.setRuntimePhase(runtime, "degraded")
      throw new AggregateError(
        failures,
        `Project ${projectId} 断开时资源清理失败`,
      )
    }
  }

  private async performConnect(projectId: string): Promise<void> {
    const runtime = this.runtimes.get(projectId)
    if (!runtime) throw new Error(`Project 不存在: ${projectId}`)
    if (runtime.project) return
    runtime.lastError = null
    this.setRuntimePhase(runtime, "connecting")
    try {
      const context = {
        projectId,
        stateDirectory: runtime.record.stateDirectory,
      }
      const projectOptions = await this.options.createProjectOptions?.(context)
      const project = await Project.open({
        ...this.options.project,
        ...projectOptions,
        root: this.root,
        stateDirectory: runtime.record.stateDirectory,
        workspaceNamespace: runtime.record.legacy
          ? undefined
          : `projects/${projectStorageKey(projectId)}`,
        config: runtime.record.config,
        platforms: this.platforms,
        resolveSecret: this.secretResolver(projectId),
      })
      runtime.project = project
      try {
        await project.syncAnnouncements({ steerActive: false })
      } catch (error) {
        // 公告 baseline 降级不阻塞 Solver；后续 poll 可以恢复。
        runtime.lastError = `公告 baseline 失败: ${errorText(error)}`
      }
      runtime.scheduler = await this.options.createScheduler?.(project, context)
      runtime.announcementPoller = new AnnouncementPoller({
        intervalMs: this.options.announcementPollIntervalMs ?? 30_000,
        poll: async () => {
          await project.syncAnnouncements()
        },
        onError: (error) => {
          runtime.lastError = `公告轮询失败: ${errorText(error)}`
          runtime.updatedAt = new Date().toISOString()
        },
      })
      runtime.announcementPoller.start()
      this.setRuntimePhase(runtime, "ready")
    } catch (error) {
      runtime.lastError = errorText(error)
      this.setRuntimePhase(runtime, "degraded")
      throw error
    }
  }

  private validateConfig(config: ProjectConfig): ProjectConfig {
    const projectConfig = parseProjectConfig(config)
    const validated = this.plugin(projectConfig.platform.plugin).config.parse(
      projectConfig.platform.config,
    )
    return {
      ...projectConfig,
      platform: { ...projectConfig.platform, config: validated },
    }
  }

  private plugin(id: string): PlatformPlugin {
    const plugin = this.platforms.find((candidate) => candidate.id === id)
    if (!plugin) throw new Error(`未注册平台插件: ${id}`)
    return plugin
  }

  private secretResolver(
    projectId: string,
    overrides: Readonly<Record<string, string | undefined>> = {},
  ): (name: string) => string | undefined {
    return (name) =>
      overrides[name] ??
      this.secretStore.get(projectSecretName(projectId, name)) ??
      this.secretStore.get(name)
  }

  private hasProjectSecret(
    projectId: string | undefined,
    name: string,
  ): boolean {
    return Boolean(
      (projectId && this.secretStore.has(projectSecretName(projectId, name))) ||
        this.secretStore.has(name),
    )
  }

  private resolveProjectId(projectId?: string): string | undefined {
    return projectId ?? this.selectedProjectId
  }

  private resolveRuntime(
    projectId?: string,
  ): ManagedProjectRuntime | undefined {
    const id = this.resolveProjectId(projectId)
    return id ? this.runtimes.get(id) : undefined
  }

  private runtimeSnapshot(
    runtime: ManagedProjectRuntime,
  ): ControlPlaneProjectSnapshot {
    return {
      id: runtime.record.config.project.id,
      name: runtime.record.config.project.name,
      platformId: runtime.record.config.platform.plugin,
      phase: runtime.phase,
      lastError: runtime.lastError,
      createdAt: runtime.record.createdAt,
      updatedAt: runtime.updatedAt,
      archived: runtime.record.archived,
    }
  }

  private setRuntimePhase(
    runtime: ManagedProjectRuntime,
    phase: ManagedProjectRuntime["phase"],
  ): void {
    runtime.phase = phase
    runtime.updatedAt = new Date().toISOString()
  }

  private enqueueTransition(
    operation: () => Promise<ControlPlaneSnapshot>,
  ): Promise<ControlPlaneSnapshot> {
    const result = this.transitionTail.then(operation, operation)
    this.transitionTail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}

/** Project 平台凭据使用不可逆稳定键隔离，避免同名插件 Secret 跨比赛覆盖。 */
export function projectSecretName(projectId: string, name: string): string {
  const projectKey = projectStorageKey(projectId).slice(0, 16).toUpperCase()
  const secretKey = createHash("sha256")
    .update(name, "utf8")
    .digest("hex")
    .slice(0, 16)
    .toUpperCase()
  return `PROJECT_${projectKey}_${secretKey}`
}

function namespaceProjectSecrets(
  projectId: string,
  values: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(values).map(([name, value]) => [
      projectSecretName(projectId, name),
      value,
    ]),
  )
}

async function inspectAndClose(
  platform: PlatformProject,
): Promise<PlatformConnectionTest> {
  let result: PlatformConnectionTest | undefined
  let failure: unknown
  try {
    result = { ok: true, overview: await platform.getOverview() }
  } catch (error) {
    failure = error
  }
  try {
    await platform.close()
  } catch (error) {
    if (failure) {
      throw new AggregateError([failure, error], "平台连接测试和关闭均失败")
    }
    throw error
  }
  if (failure) throw failure
  if (!result) throw new Error("平台连接测试未返回结果")
  return result
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
