import { Hono } from "hono"
import type { App, AppContext, AppEnv } from "../context.ts"
import { errorText, hasCode, HttpError } from "../errors.ts"
import {
  parseJsonBody,
  queueMoveSchema,
  readJsonBody,
  schedulerConcurrencySchema,
  schedulerIdleBatchSchema,
  schedulerIdleOrderSchema,
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

  app.post("/scheduler/start", async (c) => {
    await readJsonBody(c)
    await services.requireSolverScheduler(projectIdOf(c)).start()
    return c.json(await refreshFor(c))
  })

  app.post("/scheduler/auto/start", async (c) => {
    await readJsonBody(c)
    await services.requireSolverScheduler(projectIdOf(c)).startAuto()
    return c.json(await refreshFor(c))
  })

  app.post("/scheduler/auto/pause", async (c) => {
    await readJsonBody(c)
    services.requireScheduler(projectIdOf(c)).pauseAuto()
    return c.json(await refreshFor(c))
  })

  app.post("/scheduler/active/stop", async (c) => {
    await readJsonBody(c)
    await services.requireScheduler(projectIdOf(c)).stopAllActive()
    return c.json(await refreshFor(c))
  })

  app.post("/scheduler/resume", async (c) => {
    await readJsonBody(c)
    const projectId = projectIdOf(c)
    if (!services.modelView(projectId).configured) {
      throw new HttpError(409, "solver_model_unavailable", "Solver 模型尚未配置完成，无法恢复调度")
    }
    const scheduler = services.requireSolverScheduler(projectId)
    scheduler.resume()
    await scheduler.reconcile()
    return c.json(await refreshFor(c))
  })

  app.post("/scheduler/concurrency", async (c) => {
    const body = await parseJsonBody(c, schedulerConcurrencySchema, {
      code: "invalid_scheduler_configuration",
    })
    await services.requireSolverScheduler(projectIdOf(c)).setMaxConcurrent(body.maxConcurrent)
    return c.json(await refreshFor(c))
  })

  app.post("/scheduler/idle", async (c) => {
    const body = await parseJsonBody(c, schedulerIdleBatchSchema, {
      code: "invalid_scheduler_idle_batch",
    })
    await services.requireSolverScheduler(projectIdOf(c)).stage(body.challengeIds)
    return c.json(await refreshFor(c))
  })

  app.delete("/scheduler/idle", async (c) => {
    const body = await parseJsonBody(c, schedulerIdleBatchSchema, {
      code: "invalid_scheduler_idle_batch",
    })
    services.requireScheduler(projectIdOf(c)).unstage(body.challengeIds)
    return c.json(await refreshFor(c))
  })

  app.put("/scheduler/idle/order", async (c) => {
    const body = await parseJsonBody(c, schedulerIdleOrderSchema, {
      code: "invalid_scheduler_idle_order",
      perFieldCodes: { expectedVersion: "invalid_queue_version" },
    })
    try {
      services.requireScheduler(projectIdOf(c)).reorderIdle(body.challengeIds, body.expectedVersion)
      return c.json(await refreshFor(c))
    } catch (error) {
      if (!hasCode(error, "queue_version_conflict")) throw error
      return c.json(
        {
          error: "queue_version_conflict",
          message: errorText(error),
          snapshot: await refreshFor(c),
        },
        409,
      )
    }
  })

  app.patch("/scheduler/queue/:challengeId", async (c) => {
    const body = await parseJsonBody(c, queueMoveSchema, {
      code: "invalid_queue_position",
      perFieldCodes: {
        expectedVersion: "invalid_queue_version",
      },
    })
    try {
      services.requireSolverScheduler(projectIdOf(c)).reorderQueue(c.req.param("challengeId"), {
        position: body.position,
        expectedVersion: body.expectedVersion,
        overrideBlockedLane: body.overrideBlockedLane === true,
      })
      return c.json(await refreshFor(c))
    } catch (error) {
      if (!hasCode(error, "queue_version_conflict")) throw error
      return c.json(
        {
          error: "queue_version_conflict",
          message: errorText(error),
          snapshot: await refreshFor(c),
        },
        409,
      )
    }
  })

  return app
}
