import type { RunSessionExportMetadata } from "@ctf-agent/core"
import { ContestSchedulerError } from "@ctf-agent/core"
import {
  exportPiSessionHtml,
  piSessionHasConversation,
  readPiSessionConversation,
} from "../domain/html-export.ts"
import type {
  DashboardControlPlane,
  DashboardConversation,
  DashboardModelAuthentication,
  DashboardModelConfiguration,
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
  projectRuntimeConfiguration?: (
    projectId: string,
  ) => DashboardProjectRuntimeConfiguration | undefined
  onProjectDeleted?: (projectId: string) => void | Promise<void>
  /** 测试可替换 Pi 原生 HTML session 导出器。 */
  exportSessionHtml?: (
    sessionPath: string,
    metadata?: RunSessionExportMetadata,
  ) => Promise<Buffer>
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
    exportSessionHtml: (
      sessionPath: string,
      metadata?: RunSessionExportMetadata,
    ) => Promise<Buffer>
    sessionHasConversation: (sessionPath: string) => Promise<boolean>
    readSessionConversation: (sessionPath: string) => DashboardConversation
  }
  private readonly options: ServicesOptions

  constructor(options: ServicesOptions, projectId?: string) {
    this.options = options
    this.exporters = {
      exportSessionHtml: options.exportSessionHtml ?? exportPiSessionHtml,
      sessionHasConversation:
        options.sessionHasConversation ?? piSessionHasConversation,
      readSessionConversation:
        options.readSessionConversation ?? readPiSessionConversation,
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

  get authentication(): DashboardWebUiAuthentication | undefined {
    return this.options.authentication
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

  runtime(
    projectId?: string,
  ): DashboardProjectRuntimeConfiguration | undefined {
    return projectId
      ? this.options.projectRuntimeConfiguration?.(projectId)
      : undefined
  }

  /** 旧版 GlobalRouter 的 currentProject 语义：单 project 模式下忽略 projectId。 */
  requireProject(projectId?: string): DashboardProject {
    const project = this.currentProject(projectId)
    if (!project) {
      throw new HttpError(
        503,
        "project_unavailable",
        "比赛尚未配置或平台当前未连接",
      )
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
      throw new HttpError(
        404,
        "control_plane_unavailable",
        "当前 WebUI 未启用动态控制面",
      )
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
      throw new HttpError(
        404,
        "model_configuration_unavailable",
        "当前控制面不支持模型配置",
      )
    }
    return configuration
  }

  requireModelAuthentication(): DashboardModelAuthentication {
    const authentication = this.options.modelAuthentication
    if (!authentication) {
      throw new HttpError(
        404,
        "model_authentication_unavailable",
        "当前控制面不支持模型凭据管理",
      )
    }
    return authentication
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
    if (current.configured) await scheduler?.reconcile()
    else scheduler?.pauseAuto()
    return current
  }

  close(): void {
    this.sse.close()
  }
}
