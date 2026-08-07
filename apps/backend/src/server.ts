import type { AddressInfo } from "node:net"
import type { ServerType } from "@hono/node-server"
import { serve } from "@hono/node-server"
import { buildRouter, type WebUiOptions } from "./http/app.ts"
import { Services } from "./http/services.ts"
import type { DashboardSnapshot } from "./types.ts"

export type { WebUiApp, WebUiOptions } from "./http/app.ts"
export { createWebUiApp } from "./http/app.ts"

export interface WebUiServer {
  readonly host: string
  readonly port: number
  readonly url: string
  refresh(): Promise<DashboardSnapshot>
  close(): Promise<void>
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
