import { createHash } from "node:crypto"
import { join, resolve } from "node:path"
import {
  type PlatformPlugin,
  PlatformPluginRegistry,
  type PlatformProject,
  type PlatformSetupDescriptor,
} from "@ctf-agent/platform"
import { AnnouncementPoller } from "../orchestration/announcement-poller.ts"
import type { ContestScheduler } from "../orchestration/contest-scheduler.ts"
import { type ProjectConfig, parseProjectConfig } from "../project/config.ts"
import { type OpenProjectOptions, Project } from "../project/project.ts"
import {
  ProjectConfigStore,
  projectStorageKey,
  type ProjectActivation,
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
  /** 旧 WebUI 适配器可省略；ControlPlane 实例始终返回此字段。 */
  activation?: ProjectActivation
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
  /** 当前选中 Project 的开始状态；旧适配器可以省略。 */
  activation?: ProjectActivation
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

export type ProjectStartOptions =
  | { mode: "now" }
  | { mode: "manual" }
  | { mode: "scheduled"; scheduledStartAt: string }

export interface ApplyControlPlaneSetup {
  config: ProjectConfig
  secrets?: Readonly<Record<string, string | undefined>>
  /** 省略时，新 Project 立即连接；已有 Project 保留当前开始状态。 */
  start?: ProjectStartOptions
}

/** 试图在比赛开始前连接平台时抛出，避免任何意外上游请求。 */
export class ProjectNotStartedError extends Error {
  readonly code = "project_not_started"

  constructor(message: string) {
    super(message)
    this.name = "ProjectNotStartedError"
  }
}

export interface ControlPlaneOptions {
  root: string
  platforms: readonly PlatformPlugin[] | PlatformPluginRegistry
  secretStore?: SecretStore
  project?: Omit<
    OpenProjectOptions,
    "root" | "config" | "stateDirectory" | "workspaceNamespace" | "platforms" | "resolveSecret"
  >
  createProjectOptions?: (context: {
    projectId: string
    stateDirectory: string
  }) =>
    | Omit<
        OpenProjectOptions,
        "root" | "config" | "stateDirectory" | "workspaceNamespace" | "platforms" | "resolveSecret"
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
  localOnly?: boolean
  scheduler?: ContestScheduler
  announcementPoller?: AnnouncementPoller
}

/** Owns the global Project registry and one isolated runtime per configured Project. */
export class ControlPlane {
  readonly root: string
  private readonly platformSource: readonly PlatformPlugin[] | PlatformPluginRegistry
  private readonly configStore: ProjectConfigStore
  private readonly secretStore: SecretStore
  private readonly options: ControlPlaneOptions
  private readonly runtimes = new Map<string, ManagedProjectRuntime>()
  private selectedProjectId?: string
  private loadError: string | null = null
  private closing = false
  private transitionTail: Promise<void> = Promise.resolve()
  private pendingStartTimer?: NodeJS.Timeout

  private constructor(options: ControlPlaneOptions, secretStore: SecretStore) {
    this.options = options
    this.root = resolve(options.root)
    this.platformSource = options.platforms
    this.configStore = new ProjectConfigStore(this.root)
    this.secretStore = secretStore
  }

  static async create(options: ControlPlaneOptions): Promise<ControlPlane> {
    const root = resolve(options.root)
    const secretStore =
      options.secretStore ?? (await FileSecretStore.open(join(root, ".ctf-agent", "secrets.json")))
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
        phase: this.closing ? "closing" : this.loadError ? "degraded" : "unconfigured",
        configured: projects.length > 0,
        projectId: null,
        projectName: null,
        platformId: null,
        lastError: this.loadError,
        updatedAt:
          projects.reduce<string | undefined>(
            (latest, item) =>
              !latest || item.updatedAt.localeCompare(latest) > 0 ? item.updatedAt : latest,
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
      activation: state.activation,
      projects,
    }
  }

  projectSnapshots(): ControlPlaneProjectSnapshot[] {
    return [...this.runtimes.values()].map((runtime) => this.runtimeSnapshot(runtime))
  }

  configuration(projectId?: string): ProjectConfig | undefined {
    const runtime = this.resolveRuntime(projectId)
    return runtime ? structuredClone(runtime.record.config) : undefined
  }

  setupSnapshot(projectId?: string): ControlPlaneSetupSnapshot {
    const platforms = this.platforms().flatMap((plugin) =>
      plugin.setup ? [{ id: plugin.id, setup: plugin.setup }] : [],
    )
    const names = new Set(
      platforms.flatMap(({ setup }) =>
        setup.authStrategies.flatMap((strategy) => strategy.secrets.map((secret) => secret.name)),
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
            source: this.hasProjectSecret(resolvedProjectId, name) ? "store" : "none",
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

  /** 只有活跃 Solver 或未归档且已启动的手动/自动调度需要后台访问比赛平台。 */
  shouldPollProject(projectId?: string): boolean {
    const runtime = this.resolveRuntime(projectId)
    const scheduler = runtime?.scheduler?.snapshot()
    if (!runtime || !scheduler) return false
    return scheduler.active.length > 0 || (!runtime.record.archived && scheduler.autoEnabled)
  }

  canStartSolver(projectId?: string): boolean {
    const runtime = this.resolveRuntime(projectId)
    return Boolean(
      runtime &&
      !runtime.record.archived &&
      !runtime.localOnly &&
      runtime.phase === "ready" &&
      runtime.scheduler,
    )
  }

  reportPlatformFailure(projectId: string | undefined, error: unknown): void {
    const runtime = this.resolveRuntime(projectId)
    if (!runtime || runtime.localOnly) return
    runtime.lastError = `平台同步失败: ${errorText(error)}`
    runtime.scheduler?.suspend(runtime.lastError)
    this.setRuntimePhase(runtime, "degraded")
  }

  reportPlatformSuccess(projectId?: string): void {
    const runtime = this.resolveRuntime(projectId)
    if (!runtime || runtime.localOnly || runtime.record.archived || runtime.phase !== "degraded") {
      return
    }
    runtime.lastError = null
    runtime.scheduler?.resume()
    this.setRuntimePhase(runtime, "ready")
  }

  async start(): Promise<ControlPlaneSnapshot> {
    return await this.enqueueTransition(async () => {
      for (const [projectId, runtime] of this.runtimes) {
        try {
          await this.initializeRuntime(projectId)
        } catch (error) {
          // 单个 Project 降级不阻塞其他 Project 启动。
          if (runtime.phase !== "degraded") {
            runtime.lastError = errorText(error)
            this.setRuntimePhase(runtime, "degraded")
          }
        }
      }
      this.schedulePendingStarts()
      return this.snapshot()
    })
  }

  /** 触发所有已到达计划时间的比赛；可安全由定时器或宿主再次调用。 */
  async startDueProjects(): Promise<ControlPlaneSnapshot> {
    return await this.enqueueTransition(async () => {
      for (const [projectId, runtime] of this.runtimes) {
        if (
          runtime.record.archived ||
          !isPendingActivation(runtime.record.activation) ||
          !isActivationDue(runtime.record.activation)
        ) {
          continue
        }
        try {
          await this.activateProject(projectId)
        } catch {
          // performConnect 已保留 degraded 状态和诊断；其他比赛继续开始。
        }
      }
      this.schedulePendingStarts()
      return this.snapshot()
    })
  }

  async startProject(projectId: string): Promise<ControlPlaneSnapshot> {
    return await this.enqueueTransition(async () => {
      const runtime = this.runtimes.get(projectId)
      if (!runtime) throw new Error(`Project 不存在: ${projectId}`)
      if (runtime.record.archived) throw new Error("已归档比赛不能开始")
      this.selectedProjectId = projectId
      if (isPendingActivation(runtime.record.activation)) {
        if (!canActivateProject(runtime.record.activation)) {
          throw notStartedError(runtime.record.activation)
        }
        await this.activateProject(projectId)
      } else {
        await this.performConnect(projectId)
      }
      this.schedulePendingStarts()
      return this.snapshot(projectId)
    })
  }

  async connect(projectId?: string): Promise<ControlPlaneSnapshot> {
    return await this.enqueueTransition(async () => {
      const id = this.resolveProjectId(projectId)
      if (!id) return this.snapshot()
      this.selectedProjectId = id
      const runtime = this.runtimes.get(id)
      if (!runtime) return this.snapshot()
      if (runtime.record.archived) {
        await this.performOpenLocal(id)
        return this.snapshot(id)
      }
      if (isPendingActivation(runtime.record.activation)) {
        if (!canActivateProject(runtime.record.activation)) {
          throw notStartedError(runtime.record.activation)
        }
        await this.activateProject(id)
      } else {
        await this.initializeRuntime(id)
      }
      this.schedulePendingStarts()
      return this.snapshot(id)
    })
  }

  async testConnection(input: ApplyControlPlaneSetup): Promise<PlatformConnectionTest> {
    const config = this.validateConfig(input.config)
    const existing = this.runtimes.get(config.project.id)
    if (
      isDeferredStart(input.start) ||
      (!input.start && existing && isPendingActivation(existing.record.activation))
    ) {
      throw notStartedError(existing?.record.activation ?? pendingActivation(input.start))
    }
    const plugin = this.plugin(config.platform.plugin)
    const platform = await plugin.connect({
      project: config.project,
      config: plugin.config.parse(config.platform.config),
      resolveSecret: this.secretResolver(config.project.id, input.secrets),
    })
    return await inspectAndClose(platform)
  }

  async applySetup(input: ApplyControlPlaneSetup): Promise<ControlPlaneSnapshot> {
    return await this.enqueueTransition(async () => {
      const config = this.validateConfig(input.config)
      const existing = this.runtimes.get(config.project.id)
      const activation = activationForSetup(existing?.record.activation, input.start)
      // 尚未开始的比赛只保存本地配置；连接测试本身也会请求平台。
      if (!isPendingActivation(activation)) {
        await this.testConnection({ config, secrets: input.secrets, start: { mode: "now" } })
      }
      if (existing) await this.performDisconnect(config.project.id)
      if (input.secrets) {
        await this.secretStore.set(namespaceProjectSecrets(config.project.id, input.secrets))
      }
      const record = await this.configStore.saveProject(config, activation)
      this.runtimes.set(config.project.id, {
        record,
        phase: "disconnected",
        lastError: null,
        updatedAt: record.updatedAt,
      })
      this.selectedProjectId = config.project.id
      await this.initializeRuntime(config.project.id)
      this.schedulePendingStarts()
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
        this.platforms().flatMap(
          (plugin) =>
            plugin.setup?.authStrategies.flatMap((strategy) =>
              strategy.secrets.map((secret) => secret.name),
            ) ?? [],
        ),
      )
      await this.secretStore.set(
        Object.fromEntries(
          [...secretNames].map((name) => [projectSecretName(projectId, name), undefined]),
        ),
      )
      this.runtimes.delete(projectId)
      if (this.selectedProjectId === projectId) {
        this.selectedProjectId = this.runtimes.keys().next().value
      }
      this.schedulePendingStarts()
      return this.snapshot()
    })
  }

  async resetProject(projectId: string): Promise<ControlPlaneSnapshot> {
    return await this.enqueueTransition(async () => {
      const runtime = this.runtimes.get(projectId)
      if (!runtime) throw new Error(`Project 不存在: ${projectId}`)
      await this.performDisconnect(projectId)
      runtime.record = await this.configStore.resetProjectData(projectId)
      runtime.updatedAt = runtime.record.updatedAt
      await this.initializeRuntime(projectId)
      this.schedulePendingStarts()
      return this.snapshot(projectId)
    })
  }

  async archiveProject(projectId: string, archived: boolean): Promise<ControlPlaneSnapshot> {
    return await this.enqueueTransition(async () => {
      const runtime = this.runtimes.get(projectId)
      if (!runtime) throw new Error(`Project 不存在: ${projectId}`)
      runtime.record = await this.configStore.setArchived(projectId, archived)
      runtime.updatedAt = runtime.record.updatedAt
      if (archived) {
        runtime.scheduler?.pauseAuto()
        if ((runtime.scheduler?.snapshot().active.length ?? 0) === 0) {
          await this.performDisconnect(projectId)
          await this.performOpenLocal(projectId)
        }
      } else {
        await this.initializeRuntime(projectId)
      }
      this.schedulePendingStarts()
      return this.snapshot(projectId)
    })
  }

  /** 归档不打断活跃 Solver；最后一个 Solver 结束后再释放平台连接。 */
  async disconnectArchivedIdleProjects(): Promise<ControlPlaneSnapshot> {
    return await this.enqueueTransition(async () => {
      for (const [projectId, runtime] of this.runtimes) {
        if (
          runtime.record.archived &&
          runtime.project &&
          !runtime.localOnly &&
          (runtime.scheduler?.snapshot().active.length ?? 0) === 0
        ) {
          await this.performDisconnect(projectId)
          await this.performOpenLocal(projectId)
        }
      }
      return this.snapshot()
    })
  }

  async close(): Promise<void> {
    await this.enqueueTransition(async () => {
      this.closing = true
      this.clearPendingStartTimer()
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

  /** 根据归档和开始状态构造安全运行时；未到时的 pending 只打开本地数据。 */
  private async initializeRuntime(projectId: string): Promise<void> {
    const runtime = this.runtimes.get(projectId)
    if (!runtime) throw new Error(`Project 不存在: ${projectId}`)
    if (runtime.record.archived) {
      if (runtime.project && !runtime.localOnly) await this.performDisconnect(projectId)
      await this.performOpenLocal(projectId)
      return
    }
    if (isPendingActivation(runtime.record.activation)) {
      if (isActivationDue(runtime.record.activation)) {
        await this.activateProject(projectId)
        return
      }
      if (runtime.project && !runtime.localOnly) await this.performDisconnect(projectId)
      await this.performOpenLocal(projectId)
      return
    }
    await this.performConnect(projectId)
  }

  /** 在持久化 started 状态后才允许任何 live 平台连接。 */
  private async activateProject(projectId: string): Promise<void> {
    const runtime = this.runtimes.get(projectId)
    if (!runtime) throw new Error(`Project 不存在: ${projectId}`)
    if (!isPendingActivation(runtime.record.activation)) {
      await this.performConnect(projectId)
      return
    }
    runtime.record = await this.configStore.setActivation(projectId, startedActivation())
    runtime.updatedAt = runtime.record.updatedAt
    if (runtime.record.archived) {
      if (runtime.project && !runtime.localOnly) await this.performDisconnect(projectId)
      await this.performOpenLocal(projectId)
      return
    }
    await this.performConnect(projectId)
  }

  private schedulePendingStarts(): void {
    this.clearPendingStartTimer()
    if (this.closing) return
    const nextStartAt = [...this.runtimes.values()]
      .filter(
        (runtime) =>
          !runtime.record.archived &&
          isPendingActivation(runtime.record.activation) &&
          runtime.record.activation.scheduledStartAt !== null,
      )
      .map((runtime) => Date.parse(runtime.record.activation.scheduledStartAt ?? ""))
      .filter((timestamp) => Number.isFinite(timestamp))
      .sort((left, right) => left - right)[0]
    if (nextStartAt === undefined) return
    const delay = Math.max(0, Math.min(nextStartAt - Date.now(), MAX_TIMER_DELAY_MS))
    this.pendingStartTimer = setTimeout(() => {
      this.pendingStartTimer = undefined
      void this.startDueProjects().catch(() => undefined)
    }, delay)
    this.pendingStartTimer.unref()
  }

  private clearPendingStartTimer(): void {
    if (!this.pendingStartTimer) return
    clearTimeout(this.pendingStartTimer)
    this.pendingStartTimer = undefined
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
    runtime.localOnly = undefined
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
      throw new AggregateError(failures, `Project ${projectId} 断开时资源清理失败`)
    }
  }

  private async performConnect(projectId: string): Promise<void> {
    const runtime = this.runtimes.get(projectId)
    if (!runtime) throw new Error(`Project 不存在: ${projectId}`)
    if (runtime.project && !runtime.localOnly) return
    if (runtime.localOnly) await this.performDisconnect(projectId)
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
        workspaceNamespace: runtime.record.rootProject
          ? undefined
          : `projects/${projectStorageKey(projectId)}`,
        config: runtime.record.config,
        platforms: this.platforms(),
        resolveSecret: this.secretResolver(projectId),
      })
      runtime.project = project
      runtime.localOnly = false
      let baselineSucceeded = true
      try {
        await project.syncAnnouncements({ steerActive: false })
      } catch (error) {
        // 公告 baseline 降级不阻塞 Solver；后续 poll 可以恢复。
        baselineSucceeded = false
        runtime.lastError = `公告 baseline 失败: ${errorText(error)}`
      }
      runtime.scheduler = await this.options.createScheduler?.(project, context)
      runtime.announcementPoller = new AnnouncementPoller({
        intervalMs: this.options.announcementPollIntervalMs ?? 30_000,
        poll: async () => {
          if ((runtime.scheduler?.snapshot().active.length ?? 0) === 0) {
            return
          }
          await project.syncAnnouncements()
          if (runtime.phase === "degraded") {
            runtime.lastError = null
            runtime.scheduler?.resume()
            this.setRuntimePhase(runtime, "ready")
          }
        },
        onError: (error) => {
          runtime.lastError = `公告轮询失败: ${errorText(error)}`
          runtime.scheduler?.suspend(runtime.lastError)
          this.setRuntimePhase(runtime, "degraded")
        },
      })
      runtime.announcementPoller.start()
      this.setRuntimePhase(runtime, baselineSucceeded ? "ready" : "degraded")
    } catch (error) {
      runtime.lastError = errorText(error)
      try {
        if (runtime.project) await this.performDisconnect(projectId)
        await this.performOpenLocal(projectId)
      } catch (localError) {
        runtime.lastError = `${runtime.lastError}\n本地记录打开失败: ${errorText(localError)}`
      }
      this.setRuntimePhase(runtime, "degraded")
      throw error
    }
  }

  private async performOpenLocal(projectId: string): Promise<void> {
    const runtime = this.runtimes.get(projectId)
    if (!runtime) throw new Error(`Project 不存在: ${projectId}`)
    if (runtime.project) return
    const context = {
      projectId,
      stateDirectory: runtime.record.stateDirectory,
    }
    const projectOptions = await this.options.createProjectOptions?.(context)
    runtime.project = await Project.openLocal({
      ...this.options.project,
      ...projectOptions,
      root: this.root,
      stateDirectory: runtime.record.stateDirectory,
      workspaceNamespace: runtime.record.rootProject
        ? undefined
        : `projects/${projectStorageKey(projectId)}`,
      config: runtime.record.config,
      platforms: this.platforms(),
      resolveSecret: this.secretResolver(projectId),
    })
    runtime.localOnly = true
    this.setRuntimePhase(runtime, "disconnected")
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
    const plugin = this.platforms().find((candidate) => candidate.id === id)
    if (!plugin) throw new Error(`未注册平台插件: ${id}`)
    return plugin
  }

  private platforms(): PlatformPlugin[] {
    return this.platformSource instanceof PlatformPluginRegistry
      ? this.platformSource.plugins()
      : [...this.platformSource]
  }

  private secretResolver(
    projectId: string,
    overrides: Readonly<Record<string, string | undefined>> = {},
  ): (name: string) => string | undefined {
    return (name) => overrides[name] ?? this.secretStore.get(projectSecretName(projectId, name))
  }

  private hasProjectSecret(projectId: string | undefined, name: string): boolean {
    return Boolean(projectId && this.secretStore.has(projectSecretName(projectId, name)))
  }

  private resolveProjectId(projectId?: string): string | undefined {
    return projectId ?? this.selectedProjectId
  }

  private resolveRuntime(projectId?: string): ManagedProjectRuntime | undefined {
    const id = this.resolveProjectId(projectId)
    return id ? this.runtimes.get(id) : undefined
  }

  private runtimeSnapshot(runtime: ManagedProjectRuntime): ControlPlaneProjectSnapshot {
    return {
      id: runtime.record.config.project.id,
      name: runtime.record.config.project.name,
      platformId: runtime.record.config.platform.plugin,
      phase: runtime.phase,
      lastError: runtime.lastError,
      createdAt: runtime.record.createdAt,
      updatedAt: runtime.updatedAt,
      archived: runtime.record.archived,
      activation: { ...runtime.record.activation },
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
    Object.entries(values).map(([name, value]) => [projectSecretName(projectId, name), value]),
  )
}

const MAX_TIMER_DELAY_MS = 2_147_483_647

function activationForSetup(
  existing: ProjectActivation | undefined,
  start: ProjectStartOptions | undefined,
): ProjectActivation {
  if (!start) return existing ? { ...existing } : startedActivation()
  if (start.mode === "now") return startedActivation()
  return pendingActivation(start)
}

function startedActivation(): ProjectActivation {
  return { state: "started", scheduledStartAt: null }
}

function pendingActivation(start: ProjectStartOptions | undefined): ProjectActivation {
  if (start?.mode !== "scheduled") {
    return { state: "pending", scheduledStartAt: null }
  }
  const timestamp = Date.parse(start.scheduledStartAt)
  if (Number.isNaN(timestamp)) throw new Error("scheduledStartAt 必须是有效时间")
  return {
    state: "pending",
    scheduledStartAt: new Date(timestamp).toISOString(),
  }
}

function isDeferredStart(start: ProjectStartOptions | undefined): boolean {
  return start?.mode === "manual" || start?.mode === "scheduled"
}

function isPendingActivation(activation: ProjectActivation): boolean {
  return activation.state === "pending"
}

/** 仅计划开始的比赛会自动到期；手动比赛只能由 startProject 激活。 */
function isActivationDue(activation: ProjectActivation): boolean {
  return (
    activation.state === "pending" &&
    activation.scheduledStartAt !== null &&
    Date.parse(activation.scheduledStartAt) <= Date.now()
  )
}

function canActivateProject(activation: ProjectActivation): boolean {
  return activation.scheduledStartAt === null || isActivationDue(activation)
}

function notStartedError(activation: ProjectActivation): ProjectNotStartedError {
  if (activation.scheduledStartAt) {
    return new ProjectNotStartedError(
      `比赛将在 ${activation.scheduledStartAt} 开始，开始前不会请求平台`,
    )
  }
  return new ProjectNotStartedError("比赛尚未开始，请使用“开始比赛”后再连接平台")
}

async function inspectAndClose(platform: PlatformProject): Promise<PlatformConnectionTest> {
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
