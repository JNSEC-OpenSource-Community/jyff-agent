import type { AddressInfo } from "node:net"
import type { RunSessionExportMetadata } from "@ctf-agent/core"
import { type ServerType, serve } from "@hono/node-server"
import { type Context, Hono } from "hono"
import { authenticationGate } from "./http/auth.ts"
import { errorHandler } from "./http/errors.ts"
import { Services } from "./http/services.ts"
import type { SseHub } from "./http/sse.ts"
import { loadStaticAssets } from "./http/static.ts"
import type { SnapshotSync } from "./http/sync.ts"
import type { App, AppEnv, ProjectScope } from "./http/types.ts"
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
} from "./types.ts"

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

export interface WebUiServer {
  readonly host: string
  readonly port: number
  readonly url: string
  refresh(): Promise<DashboardSnapshot>
  close(): Promise<void>
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
function buildRouter(services: Services, options: WebUiOptions): App {
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

export async function startWebUi(options: WebUiOptions): Promise<WebUiServer> {
  if (!options.project && !options.controlPlane) {
    throw new Error("WebUI 至少需要 project 或 controlPlane")
  }
  const services = new Services(options)
  const app = buildRouter(services, options)

  // 启动前先完成一次真实快照构建；失败时保持 degraded 并由轮询退避恢复。
  try {
    await services.sync.refresh()
  } catch {
    // refresh() 已记录失败并广播 dashboard_error。
  }

  const host = options.host ?? "0.0.0.0"
  let server: ServerType
  const address = await new Promise<AddressInfo>((resolve, reject) => {
    server = serve(
      { fetch: app.fetch, hostname: host, port: options.port ?? 5454 },
      resolve,
    )
    server.once("error", reject)
  })
  const url = `http://${host.includes(":") ? `[${host}]` : host}:${address.port}`

  const pollIntervalMs = options.pollIntervalMs ?? 15_000
  const schedulerReconcileDelay = Math.max(
    5_000,
    options.schedulerReconcileIntervalMs ?? 30_000,
  )
  let closed = false
  let refreshTimer: NodeJS.Timeout | undefined
  let schedulerReconcileTimer: NodeJS.Timeout | undefined
  const heartbeat = setInterval(() => services.sse.ping(), 15_000)
  heartbeat.unref()

  const scheduleRefresh = (delayMs: number): void => {
    refreshTimer = setTimeout(async () => {
      try {
        await services.sync.refresh()
        for (const projectId of services.sse.scopedProjectIds()) {
          try {
            await services.sync.pollProject(projectId)
          } catch {
            // 单个项目轮询失败只影响该项目，下次轮询继续。
          }
        }
      } catch {
        // refresh() 已记录失败并广播 degraded。
      } finally {
        if (!closed)
          scheduleRefresh(services.sync.nextPollDelay(pollIntervalMs))
      }
    }, delayMs)
    refreshTimer.unref()
  }
  scheduleRefresh(pollIntervalMs)

  const scheduleReconcile = (delayMs: number): void => {
    if (!options.scheduler && !options.controlPlane) return
    schedulerReconcileTimer = setTimeout(async () => {
      const schedulers = options.controlPlane
        ? options.controlPlane
            .projectSnapshots()
            .map(({ id }) => services.currentScheduler(id))
        : [services.currentScheduler()]
      for (const scheduler of schedulers) {
        if (!scheduler?.snapshot().autoEnabled) continue
        try {
          await scheduler.reconcile()
        } catch {
          // 调度器平台同步失败不中断其他调度器。
        }
      }
      if (!closed) scheduleReconcile(schedulerReconcileDelay)
    }, delayMs)
    schedulerReconcileTimer.unref()
  }
  scheduleReconcile(schedulerReconcileDelay)

  return {
    host,
    port: address.port,
    url,
    refresh: () => services.sync.refresh(),
    async close(): Promise<void> {
      closed = true
      if (refreshTimer) clearTimeout(refreshTimer)
      if (schedulerReconcileTimer) clearTimeout(schedulerReconcileTimer)
      clearInterval(heartbeat)
      services.sse.close()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    },
  }
}
