import { Hono } from "hono"
import { errorText, HttpError } from "../http/errors.ts"
import type { Services } from "../http/services.ts"
import type { App, AppContext, AppEnv, ProjectScope } from "../http/types.ts"
import {
  parseJsonBody,
  parseProjectSetup,
  projectRuntimeConfigurationSchema,
  projectSetupSchema,
  readJsonBody,
} from "../http/validation.ts"

/** 全局项目管理：列表、创建、连接测试。 */
export function projectsRoutes(services: Services): App {
  const app = new Hono<AppEnv>()

  app.get("/projects", (c) => {
    const controlPlane = services.requireControlPlane()
    return c.json({
      projects: controlPlane.projectSnapshots(),
      selectedProjectId: controlPlane.snapshot().selectedProjectId,
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

  app.get("/control-plane", (c) => {
    const controlPlane = services.requireControlPlane()
    return c.json(controlPlane.setupSnapshot(projectIdOf(c)))
  })

  app.post("/control-plane/connect", async (c) => {
    const controlPlane = services.requireControlPlane()
    await readJsonBody(c)
    await controlPlane.connect(projectIdOf(c))
    return c.json(await services.sync.refreshProject(projectIdOf(c)))
  })

  app.get("/runtime-config", (c) => {
    const runtime = services.requireRuntime(projectIdOf(c))
    services.requireModelConfiguration()
    return c.json({
      runtime: runtime.snapshot(),
      models: services.modelView(projectIdOf(c)),
    })
  })

  app.post("/runtime-config", async (c) => {
    const projectId = projectIdOf(c)
    const runtime = services.requireRuntime(projectId)
    const modelConfiguration = services.requireModelConfiguration()
    const body = await parseJsonBody(c, projectRuntimeConfigurationSchema, {
      code: "invalid_project_runtime_configuration",
    })
    let configuration: import("../types.ts").ProjectRuntimeConfigurationView
    try {
      configuration = await runtime.update(body)
    } catch (error) {
      throw new HttpError(
        400,
        "invalid_project_runtime_configuration",
        errorText(error),
      )
    }
    const scheduler = services.currentScheduler(projectId)
    await scheduler?.setMaxConcurrent(configuration.maxConcurrent)
    const model = modelConfiguration.snapshot(configuration)
    if (!model.configured) scheduler?.pauseAuto()
    else await scheduler?.reconcile()
    return c.json({
      runtime: configuration,
      models: services.modelView(projectId),
      snapshot: await services.sync.refreshProject(projectId),
    })
  })

  return app
}
