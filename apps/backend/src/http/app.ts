import type { RunSessionExportMetadata } from "@ctf-agent/core"
import { type Context, Hono } from "hono"
import type {
  DashboardControlPlane,
  DashboardConversation,
  DashboardModelAuthentication,
  DashboardModelConfiguration,
  DashboardProject,
  DashboardProjectRuntimeConfiguration,
  DashboardScheduler,
  DashboardSnapshot,
  DashboardWebUiAuthentication,
} from "../types.ts"
import { loadStaticAssets } from "./assets.ts"
import type { App, AppEnv, ProjectScope } from "./context.ts"
import { errorHandler } from "./errors.ts"
import { authenticationGate } from "./middleware/auth.ts"
import { challengeRoutes } from "./routes/challenges.ts"
import { modelsRoutes, scopedModelsRoutes } from "./routes/models.ts"
import { projectsRoutes, scopedProjectRoutes } from "./routes/projects.ts"
import { runRoutes } from "./routes/runs.ts"
import { schedulerRoutes } from "./routes/scheduler.ts"
import {
  healthRoutes,
  scopedSystemRoutes,
  systemRoutes,
} from "./routes/system.ts"
import { Services } from "./services.ts"
import type { SseHub } from "./sse/hub.ts"
import type { SnapshotSync } from "./sync.ts"

export interface WebUiOptions {
  project?: DashboardProject
  controlPlane?: DashboardControlPlane
  host?: string
  port?: number
  pollIntervalMs?: number
  scheduler?: DashboardScheduler
  schedulerReconcileIntervalMs?: number
  modelConfiguration?: DashboardModelConfiguration
  modelAuthentication?: DashboardModelAuthentication
  authentication?: DashboardWebUiAuthentication
  secureCookies?: boolean
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
  /** 前端构建产物目录（默认 apps/frontend/dist）。 */
  frontendDist?: string
}

export interface WebUiApp {
  app: App
  services: Services
  sync: SnapshotSync
  sse: SseHub
}

/** 仅用于 app.request() 内存测试的构建入口：不监听端口、不启动定时器。 */
export function createWebUiApp(options: WebUiOptions): WebUiApp {
  if (!options.project && !options.controlPlane) {
    throw new Error("WebUI 至少需要 project 或 controlPlane")
  }
  const services = new Services(options)
  return {
    app: buildRouter(services, options),
    services,
    sync: services.sync,
    sse: services.sse,
  }
}

/** 组装路由树（全局 /api + 项目级两种挂载形态 + 静态资源兜底）。 */
export function buildRouter(services: Services, options: WebUiOptions): App {
  const app = new Hono<AppEnv>()
  const staticAssets = loadStaticAssets(options.frontendDist)

  // 基础上下文：services 与 secureCookies 对所有路由可见。
  app.use("*", async (c: Context<AppEnv>, next) => {
    c.set("services", services)
    c.set("secureCookies", options.secureCookies === true)
    await next()
  })
  app.use("/api/*", authenticationGate(services))

  // 全局 /api 路由。
  const api = new Hono<AppEnv>()
  api.route("/", systemRoutes(services))
  api.route("/", projectsRoutes(services))
  api.route("/", schedulerRoutes(services))
  api.route("/", challengeRoutes(services))
  api.route("/", runRoutes(services))
  api.route("/", modelsRoutes(services))
  app.route("/api", api)

  // 项目级路由：注入 scope 后挂载到两种路径形态（新式与旧式 /api 后缀）。
  const scoped = new Hono<AppEnv>()
  scoped.use("*", async (c, next) => {
    const scope: ProjectScope = { projectId: c.req.param("projectId") ?? "" }
    c.set("scope", scope)
    await next()
  })
  scoped.route("/", scopedSystemRoutes(services))
  scoped.route("/", scopedProjectRoutes(services))
  scoped.route("/", schedulerRoutes(services))
  scoped.route("/", challengeRoutes(services))
  scoped.route("/", runRoutes(services))
  scoped.route("/", scopedModelsRoutes(services))
  app.route("/api/projects/:projectId", scoped)
  app.route("/api/projects/:projectId/api", scoped)

  // 健康检查与 SPA 静态资源（顶层兜底）。
  app.route("/", healthRoutes(services))
  app.all("*", async (c) => {
    const assets = await staticAssets
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      return c.json({ error: "not_found" }, 404)
    }
    const asset = assets.get(c.req.path)
    if (asset) {
      return c.body(asset.content, 200, {
        "Content-Type": asset.contentType,
        "Cache-Control": "no-cache",
      })
    }
    if (!c.req.path.startsWith("/api/")) {
      const index = assets.get("/")
      if (index) {
        return c.body(index.content, 200, {
          "Content-Type": index.contentType,
          "Cache-Control": "no-cache",
        })
      }
    }
    return c.json({ error: "not_found" }, 404)
  })

  app.onError(errorHandler)
  return app
}
