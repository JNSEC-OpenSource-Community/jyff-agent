import type { AuditStore, RunSessionExportMetadata } from "@ctf-agent/core"
import { ContestSchedulerError } from "@ctf-agent/core"
import {
  exportPiSessionHtml,
  piSessionHasConversation,
  readPiSessionConversation,
} from "../domain/html-export.ts"
import type { BuiltInPluginConfiguration } from "../domain/built-in-plugin-config.ts"
import type { WebAccessConfiguration } from "../domain/web-access-config.ts"
import type {
  DashboardControlPlane,
  DashboardConversation,
  DashboardFather,
  DashboardFatherValidationConfigs,
  DashboardModelAuthentication,
  DashboardModelConfiguration,
  DashboardPlatformExtensions,
  DashboardProject,
  DashboardProjectRuntimeConfiguration,
  DashboardScheduler,
  DashboardWebUiAuthentication,
  ModelConfigurationView,
} from "../types.ts"
import type { ProjectScope } from "./context.ts"
import { HttpError } from "./errors.ts"
import { SseHub } from "./sse/hub.ts"
import { SnapshotSync } from "./sync.ts"

export interface ServicesOptions {
  project?: DashboardProject
  controlPlane?: DashboardControlPlane
  scheduler?: DashboardScheduler
  modelConfiguration?: DashboardModelConfiguration
  modelAuthentication?: DashboardModelAuthentication
  authentication?: DashboardWebUiAuthentication
  father?: DashboardFather
  fatherValidationConfigs?: DashboardFatherValidationConfigs
  extensions?: DashboardPlatformExtensions
  builtInPluginConfiguration?: BuiltInPluginConfiguration
  webAccessConfiguration?: WebAccessConfiguration
  projectRuntimeConfiguration?: (
    projectId: string,
  ) => DashboardProjectRuntimeConfiguration | undefined
  /** 按需打开 Project 的独立审计数据库；调用方必须在回调结束后释放句柄。 */
  auditStore?: () => Promise<AuditStore>
  auditArchiveDirectory?: string
  auditWorkDirectory?: string
  preflightAudit?: () => Promise<void>
  validateAuditModel?: (modelId: string) => Promise<void>
  runAudit?: (
    run: import("@ctf-agent/core").CodeAuditRun,
    audit: import("@ctf-agent/core").CodeAuditProject,
  ) => Promise<void>
  cancelAudit?: (runId: string) => boolean
  pauseAudit?: (runId: string) => Promise<boolean>
  resumeAudit?: (runId: string) => Promise<boolean>
  onProjectDeleted?: (projectId: string) => void | Promise<void>
  /** 测试可替换 Pi 原生 HTML session 导出器。 */
  exportSessionHtml?: (sessionPath: string, metadata?: RunSessionExportMetadata) => Promise<Buffer>
  /** 测试可替换原生 Pi session 的对话可用性检查。 */
  sessionHasConversation?: (sessionPath: string) => Promise<boolean>
  /** 测试可替换原生 Pi session 的结构化对话读取器。 */
  readSessionConversation?: (sessionPath: string) => DashboardConversation
}

/** 按 Project ID 解析当前 project/scheduler/controlPlane 的视图快照服务。 */
export class Services {
  readonly sse = new SseHub()
  readonly sync: SnapshotSync
  readonly exporters: {
    exportSessionHtml: (sessionPath: string, metadata?: RunSessionExportMetadata) => Promise<Buffer>
    sessionHasConversation: (sessionPath: string) => Promise<boolean>
    readSessionConversation: (sessionPath: string) => DashboardConversation
  }
  private readonly options: ServicesOptions

  constructor(options: ServicesOptions, projectId?: string) {
    this.options = options
    this.exporters = {
      exportSessionHtml: options.exportSessionHtml ?? exportPiSessionHtml,
      sessionHasConversation: options.sessionHasConversation ?? piSessionHasConversation,
      readSessionConversation: options.readSessionConversation ?? readPiSessionConversation,
    }
    this.sync = new SnapshotSync({
      project: options.project,
      controlPlane: options.controlPlane,
      scheduler: options.scheduler,
      projectId,
      sse: this.sse,
    })
  }

  get controlPlane(): DashboardControlPlane | undefined {
    return this.options.controlPlane
  }

  get modelConfiguration(): DashboardModelConfiguration | undefined {
    return this.options.modelConfiguration
  }

  get modelAuthentication(): DashboardModelAuthentication | undefined {
    return this.options.modelAuthentication
  }

  get webAccessConfiguration(): WebAccessConfiguration | undefined {
    return this.options.webAccessConfiguration
  }

  get builtInPluginConfiguration(): BuiltInPluginConfiguration | undefined {
    return this.options.builtInPluginConfiguration
  }

  get authentication(): DashboardWebUiAuthentication | undefined {
    return this.options.authentication
  }

  get father(): DashboardFather | undefined {
    return this.options.father
  }

  get extensions(): DashboardPlatformExtensions | undefined {
    return this.options.extensions
  }

  requireFather(): DashboardFather {
    if (!this.options.father) {
      throw new HttpError(503, "father_unavailable", "Clanker Father 尚未启用")
    }
    return this.options.father
  }

  requireExtensions(): DashboardPlatformExtensions {
    if (!this.options.extensions) {
      throw new HttpError(503, "extensions_unavailable", "平台扩展服务尚未启用")
    }
    return this.options.extensions
  }

  requireFatherValidationConfigs(): DashboardFatherValidationConfigs {
    if (!this.options.fatherValidationConfigs)
      throw new HttpError(
        503,
        "father_validation_config_unavailable",
        "Father 测试配置服务尚未启用",
      )
    return this.options.fatherValidationConfigs
  }

  currentProject(projectId?: string): DashboardProject | undefined {
    return this.options.controlPlane
      ? this.options.controlPlane.currentProject(projectId)
      : this.options.project
  }

  currentScheduler(projectId?: string): DashboardScheduler | undefined {
    return this.options.controlPlane
      ? this.options.controlPlane.currentScheduler(projectId)
      : this.options.scheduler
  }

  runtime(projectId?: string): DashboardProjectRuntimeConfiguration | undefined {
    return projectId ? this.options.projectRuntimeConfiguration?.(projectId) : undefined
  }

  /** 旧版 GlobalRouter 的 currentProject 语义：单 project 模式下忽略 projectId。 */
  requireProject(projectId?: string): DashboardProject {
    const project = this.currentProject(projectId)
    if (!project) {
      throw new HttpError(503, "project_unavailable", "比赛尚未配置或平台当前未连接")
    }
    return project
  }

  requireScheduler(projectId?: string): DashboardScheduler {
    const scheduler = this.currentScheduler(projectId)
    if (!scheduler) {
      throw new ContestSchedulerError("unavailable", "当前控制面没有配置调度器")
    }
    return scheduler
  }

  requireSolverScheduler(projectId?: string): DashboardScheduler {
    this.assertSolverOperationsAvailable(projectId)
    return this.requireScheduler(projectId)
  }

  assertSolverOperationsAvailable(projectId?: string): void {
    if (this.options.controlPlane?.canStartSolver?.(projectId) !== false) return
    throw new HttpError(
      409,
      "solver_unavailable",
      "平台故障或 Project 已归档，当前只能查看本地记录",
    )
  }

  canStartSolver(projectId?: string): boolean {
    return (
      this.options.controlPlane?.canStartSolver?.(projectId) ??
      this.currentScheduler(projectId) !== undefined
    )
  }

  async auditAdapterStatus() {
    if (!this.options.runAudit || !this.options.preflightAudit) {
      return {
        id: "codex-security" as const,
        available: false,
        reason: "Codex Security worker 尚未配置；运行已被安全阻止。",
      }
    }
    try {
      await this.options.preflightAudit()
      return {
        id: "codex-security" as const,
        available: true,
        reason: "审计会在隔离容器中运行。",
      }
    } catch (error) {
      return {
        id: "codex-security" as const,
        available: false,
        reason: error instanceof Error ? error.message : "审计 Worker 不可用",
      }
    }
  }

  async validateAuditModel(modelId: string): Promise<void> {
    if (!this.options.validateAuditModel) {
      throw new HttpError(503, "code_audit_unavailable", "审计模型校验服务尚未启用")
    }
    try {
      await this.options.validateAuditModel(modelId)
    } catch (error) {
      throw new HttpError(
        400,
        "audit_model_invalid",
        error instanceof Error ? error.message : "审计模型不可用",
      )
    }
  }

  async preflightAudit(): Promise<void> {
    if (!this.options.preflightAudit) {
      throw new HttpError(503, "code_audit_unavailable", "Codex Security worker 尚未启用")
    }
    try {
      await this.options.preflightAudit()
    } catch (error) {
      throw new HttpError(
        503,
        "code_audit_worker_unavailable",
        error instanceof Error ? error.message : "审计 Worker 不可用",
      )
    }
  }

  startAudit(
    run: import("@ctf-agent/core").CodeAuditRun,
    audit: import("@ctf-agent/core").CodeAuditProject,
  ): void {
    if (!this.options.runAudit) {
      throw new HttpError(503, "code_audit_unavailable", "Codex Security worker 尚未启用")
    }
    void this.options.runAudit(run, audit)
  }

  cancelAudit(runId: string): void {
    if (!this.options.cancelAudit?.(runId)) {
      throw new HttpError(409, "audit_run_not_active", "审计运行当前不可取消")
    }
  }

  async pauseAudit(runId: string): Promise<void> {
    if (!(await this.options.pauseAudit?.(runId))) {
      throw new HttpError(409, "audit_run_not_active", "审计运行当前不可暂停")
    }
  }

  async resumeAudit(runId: string): Promise<void> {
    if (!(await this.options.resumeAudit?.(runId))) {
      throw new HttpError(409, "audit_run_not_active", "审计运行当前不可恢复")
    }
  }

  get auditArchiveDirectory(): string {
    if (!this.options.auditArchiveDirectory) {
      throw new HttpError(503, "code_audit_unavailable", "代码审计归档服务尚未启用")
    }
    return this.options.auditArchiveDirectory
  }

  get auditWorkDirectory(): string {
    if (!this.options.auditWorkDirectory) {
      throw new HttpError(503, "code_audit_unavailable", "代码审计运行目录尚未启用")
    }
    return this.options.auditWorkDirectory
  }

  async withAuditStore<T>(operation: (store: AuditStore) => Promise<T> | T): Promise<T> {
    if (!this.options.auditStore) {
      throw new HttpError(503, "code_audit_unavailable", "代码审计服务尚未启用")
    }
    const store = await this.options.auditStore()
    try {
      return await operation(store)
    } finally {
      store.close()
    }
  }

  requireRuntime(projectId: string): DashboardProjectRuntimeConfiguration {
    const runtime = this.runtime(projectId)
    if (!runtime) {
      throw new HttpError(
        503,
        "project_runtime_configuration_unavailable",
        "Project 运行配置尚不可用",
      )
    }
    return runtime
  }

  requireControlPlane(): DashboardControlPlane {
    const controlPlane = this.options.controlPlane
    if (!controlPlane) {
      throw new HttpError(404, "control_plane_unavailable", "当前 WebUI 未启用动态控制面")
    }
    return controlPlane
  }

  async deleteProject(projectId: string): Promise<void> {
    const controlPlane = this.requireControlPlane()
    await controlPlane.deleteProject(projectId)
    await this.options.onProjectDeleted?.(projectId)
  }

  async resetProject(projectId: string): Promise<void> {
    await this.requireControlPlane().resetProject(projectId)
  }

  requireModelConfiguration(): DashboardModelConfiguration {
    const configuration = this.options.modelConfiguration
    if (!configuration) {
      throw new HttpError(404, "model_configuration_unavailable", "当前控制面不支持模型配置")
    }
    return configuration
  }

  requireModelAuthentication(): DashboardModelAuthentication {
    const authentication = this.options.modelAuthentication
    if (!authentication) {
      throw new HttpError(404, "model_authentication_unavailable", "当前控制面不支持模型凭据管理")
    }
    return authentication
  }

  requireWebAccess(): WebAccessConfiguration {
    const configuration = this.options.webAccessConfiguration
    if (!configuration) {
      throw new HttpError(404, "web_access_unavailable", "当前控制面不支持 web-access 插件配置")
    }
    return configuration
  }

  /** 全局路由（无 project 上下文）的作用域视图。 */
  globalScope(): { projectId: string | undefined } {
    return { projectId: undefined }
  }

  /** 根据 c.set 注入的 scope 解析出断言后的对象。 */
  resolve(scope: ProjectScope | undefined): {
    projectId?: string
    project: DashboardProject
    scheduler: DashboardScheduler
  } {
    const projectId = scope?.projectId
    return {
      projectId,
      project: this.requireProject(projectId),
      scheduler: this.requireScheduler(projectId),
    }
  }

  /** 模型配置视图（含 subagent 角色列表）。 */
  modelView(projectId?: string): ModelConfigurationView {
    const configuration = this.requireModelConfiguration()
    return {
      ...configuration.snapshot(this.runtime(projectId)?.snapshot()),
      subagentRoles:
        this.currentProject(projectId)
          ?.availableSubagents()
          .map(({ name, displayName }) => ({ name, displayName })) ?? [],
    }
  }

  /** 模型可用性联动：configured 则恢复调度，否则暂停自动调度。 */
  async reconcileModelAvailability(
    scheduler: DashboardScheduler | undefined,
  ): Promise<ReturnType<DashboardModelConfiguration["snapshot"]> | null> {
    const configuration = this.options.modelConfiguration
    if (!configuration) return null
    const current = configuration.snapshot()
    if (current.configured) {
      scheduler?.resume()
      await scheduler?.reconcile()
    } else scheduler?.pauseAuto()
    return current
  }

  close(): void {
    this.sse.close()
  }
}
