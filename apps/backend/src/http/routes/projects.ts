import { Hono } from "hono"
import {
  defaultBuiltInPluginConfigurationView,
  TOKEN_USAGE_PLUGIN_ID,
} from "../../domain/built-in-plugin-config.ts"
import type { App, AppContext, AppEnv, ProjectScope } from "../context.ts"
import { errorText, HttpError } from "../errors.ts"
import {
  parseJsonBody,
  parseProjectSetup,
  projectArchiveSchema,
  projectRuntimeConfigurationSchema,
  projectSetupSchema,
  readJsonBody,
} from "../schema.ts"
import type { Services } from "../services.ts"

function isProjectNotStarted(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "project_not_started"
  )
}

/** 全局项目管理：列表、创建、连接测试。 */
export function projectsRoutes(services: Services): App {
  const app = new Hono<AppEnv>()

  app.get("/projects", async (c) => {
    const controlPlane = services.requireControlPlane()
    const projects = await Promise.all(
      controlPlane.projectSnapshots().map(async (project) => {
        try {
          const snapshot = await services.sync.refreshProject(project.id)
          return {
            ...project,
            solved: snapshot.stats.solved,
            total: snapshot.stats.total,
          }
        } catch {
          return { ...project, solved: 0, total: 0 }
        }
      }),
    )
    return c.json({
      projects,
      selectedProjectId: controlPlane.snapshot().selectedProjectId,
      plugins:
        services.builtInPluginConfiguration?.snapshot() ?? defaultBuiltInPluginConfigurationView(),
    })
  })

  app.post("/projects/test", async (c) => {
    const controlPlane = services.requireControlPlane()
    const body = await parseJsonBody(c, projectSetupSchema, {
      code: "invalid_project_config",
    })
    const input = parseProjectSetup(body)
    try {
      return c.json(await controlPlane.testConnection(input))
    } catch (error) {
      if (isProjectNotStarted(error)) {
        throw new HttpError(409, "project_not_started", errorText(error))
      }
      throw new HttpError(422, "platform_connection_failed", errorText(error))
    }
  })

  app.post("/projects", async (c) => {
    const controlPlane = services.requireControlPlane()
    const body = await parseJsonBody(c, projectSetupSchema, {
      code: "invalid_project_config",
    })
    const input = parseProjectSetup(body)
    try {
      await controlPlane.applySetup(input)
    } catch (error) {
      if (isProjectNotStarted(error)) {
        throw new HttpError(409, "project_not_started", errorText(error))
      }
      throw new HttpError(422, "platform_setup_failed", errorText(error))
    }
    return c.json(
      {
        project: controlPlane.snapshot(input.config.project.id),
        snapshot: await services.sync.refreshProject(input.config.project.id),
      },
      201,
    )
  })

  return app
}

/** 项目级路由：状态根节点、删除、控制面连接、运行配置。 */
export function scopedProjectRoutes(services: Services): App {
  const app = new Hono<AppEnv>()

  const projectIdOf = (c: AppContext): string => {
    const scope = c.get("scope") as ProjectScope | undefined
    return scope?.projectId ?? ""
  }

  app.get("/", (c) => {
    const controlPlane = services.requireControlPlane()
    const projectId = projectIdOf(c)
    const snapshot = controlPlane.snapshot(projectId)
    if (snapshot.projectId !== projectId) {
      throw new HttpError(404, "project_not_found", "Project 不存在")
    }
    return c.json(snapshot)
  })

  app.delete("/", async (c) => {
    const projectId = projectIdOf(c)
    try {
      await services.deleteProject(projectId)
    } catch (error) {
      const message = errorText(error)
      if (message.includes("Project 不存在")) {
        throw new HttpError(404, "project_not_found", message)
      }
      throw error
    }
    return c.json({
      controlPlane: services.requireControlPlane().snapshot(),
      snapshot: await services.sync.refresh(),
    })
  })

  app.post("/archive", async (c) => {
    const projectId = projectIdOf(c)
    const body = await parseJsonBody(c, projectArchiveSchema, {
      code: "invalid_project_archive_state",
    })
    try {
      const controlPlane = await services
        .requireControlPlane()
        .archiveProject(projectId, body.archived)
      return c.json({ controlPlane })
    } catch (error) {
      const message = errorText(error)
      if (message.includes("Project 不存在")) {
        throw new HttpError(404, "project_not_found", message)
      }
      throw error
    }
  })

  app.post("/start", async (c) => {
    const projectId = projectIdOf(c)
    await readJsonBody(c)
    try {
      const controlPlaneService = services.requireControlPlane()
      if (!controlPlaneService.startProject) {
        throw new HttpError(501, "project_start_unavailable", "当前控制面不支持手动开始比赛")
      }
      const controlPlane = await controlPlaneService.startProject(projectId)
      return c.json({
        controlPlane,
        snapshot: await services.sync.refreshProject(projectId),
      })
    } catch (error) {
      if (error instanceof HttpError) throw error
      const message = errorText(error)
      if (message.includes("Project 不存在")) {
        throw new HttpError(404, "project_not_found", message)
      }
      if (isProjectNotStarted(error)) {
        throw new HttpError(409, "project_not_started", message)
      }
      throw new HttpError(503, "platform_connection_failed", message)
    }
  })

  app.post("/reset-solvers", async (c) => {
    const projectId = projectIdOf(c)
    await readJsonBody(c)
    try {
      await services.resetProject(projectId)
    } catch (error) {
      const message = errorText(error)
      if (message.includes("Project 不存在")) {
        throw new HttpError(404, "project_not_found", message)
      }
      throw error
    }
    return c.json({
      controlPlane: services.requireControlPlane().snapshot(projectId),
      snapshot: await services.sync.refreshProject(projectId),
    })
  })

  app.get("/control-plane", (c) => {
    const controlPlane = services.requireControlPlane()
    return c.json(controlPlane.setupSnapshot(projectIdOf(c)))
  })

  app.post("/control-plane/connect", async (c) => {
    const controlPlane = services.requireControlPlane()
    const projectId = projectIdOf(c)
    await readJsonBody(c)
    try {
      await controlPlane.connect(projectId)
    } catch (error) {
      if (isProjectNotStarted(error)) {
        throw new HttpError(409, "project_not_started", errorText(error))
      }
      throw new HttpError(503, "platform_connection_failed", errorText(error))
    }
    return c.json(await services.sync.refreshProject(projectId))
  })

  app.get("/runtime-config", (c) => {
    const runtime = services.requireRuntime(projectIdOf(c))
    services.requireModelConfiguration()
    return c.json({
      runtime: runtime.snapshot(),
      models: services.modelView(projectIdOf(c)),
    })
  })

  app.get("/token-usage", (c) => {
    if (services.builtInPluginConfiguration?.isEnabled(TOKEN_USAGE_PLUGIN_ID) === false) {
      throw new HttpError(404, "plugin_disabled", "Token 消耗插件已关闭")
    }
    c.header("Cache-Control", "no-store")
    return c.json(services.requireProject(projectIdOf(c)).tokenUsage())
  })

  app.post("/runtime-config", async (c) => {
    const projectId = projectIdOf(c)
    const runtime = services.requireRuntime(projectId)
    const modelConfiguration = services.requireModelConfiguration()
    const body = await parseJsonBody(c, projectRuntimeConfigurationSchema, {
      code: "invalid_project_runtime_configuration",
    })
    let configuration: import("../../types.ts").ProjectRuntimeConfigurationView
    try {
      configuration = await runtime.update(body)
    } catch (error) {
      throw new HttpError(400, "invalid_project_runtime_configuration", errorText(error))
    }
    const scheduler = services.currentScheduler(projectId)
    await scheduler?.setMaxConcurrent(configuration.maxConcurrent)
    await services
      .currentProject(projectId)
      ?.setMaxRemoteEnvironments(configuration.maxRemoteEnvironments)
    const model = modelConfiguration.snapshot(configuration)
    if (!model.configured) scheduler?.pauseAuto()
    else {
      scheduler?.resume()
      await scheduler?.reconcile()
    }
    return c.json({
      runtime: configuration,
      models: services.modelView(projectId),
      snapshot: await services.sync.refreshProject(projectId),
    })
  })

  return app
}
