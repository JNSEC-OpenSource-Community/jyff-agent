import { Hono } from "hono"
import type { App, AppContext, AppEnv } from "../context.ts"
import {
  parseJsonBody,
  queueMoveSchema,
  readJsonBody,
  schedulerConcurrencySchema,
} from "../schema.ts"
import type { Services } from "../services.ts"

/** 调度器路由（全局 + 项目级复用同一实现，projectId 可选）。 */
export function schedulerRoutes(services: Services): App {
  const app = new Hono<AppEnv>()

  const projectIdOf = (c: AppContext): string => {
    const scope = c.get("scope") as { projectId?: string } | undefined
    return scope?.projectId ?? ""
  }

  const refreshFor = (c: AppContext) => {
    const projectId = projectIdOf(c)
    return projectId ? services.sync.refreshProject(projectId) : services.sync.refresh()
  }

  app.post("/scheduler/auto/start", async (c) => {
    await readJsonBody(c)
    await services.requireSolverScheduler(projectIdOf(c)).startAuto()
    return c.json(await refreshFor(c))
  })

  app.post("/scheduler/auto/pause", async (c) => {
    await readJsonBody(c)
    services.requireSolverScheduler(projectIdOf(c)).pauseAuto()
    return c.json(await refreshFor(c))
  })

  app.post("/scheduler/concurrency", async (c) => {
    const body = await parseJsonBody(c, schedulerConcurrencySchema, {
      code: "invalid_scheduler_configuration",
    })
    await services.requireSolverScheduler(projectIdOf(c)).setMaxConcurrent(body.maxConcurrent)
    return c.json(await refreshFor(c))
  })

  app.patch("/scheduler/queue/:challengeId", async (c) => {
    const body = await parseJsonBody(c, queueMoveSchema, {
      code: "invalid_queue_position",
      perFieldCodes: {
        expectedVersion: "invalid_queue_version",
      },
    })
    services.requireSolverScheduler(projectIdOf(c)).reorderQueue(c.req.param("challengeId"), {
      position: body.position,
      expectedVersion: body.expectedVersion,
      overrideBlockedLane: body.overrideBlockedLane === true,
    })
    return c.json(await refreshFor(c))
  })

  return app
}
