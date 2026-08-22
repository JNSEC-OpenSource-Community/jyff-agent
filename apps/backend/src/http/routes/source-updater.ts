import { Hono } from "hono"
import type { App, AppEnv } from "../context.ts"
import { errorText, HttpError } from "../errors.ts"
import {
  parseJsonBody,
  sourceUpdaterApplySchema,
  sourceUpdaterConfigurationSchema,
  sourceUpdaterPrepareSchema,
  sourceUpdaterRollbackSchema,
  sourceUpdaterTokenSchema,
} from "../schema.ts"
import type { Services } from "../services.ts"

export function sourceUpdaterRoutes(services: Services): App {
  const app = new Hono<AppEnv>()

  app.get("/global-config/source-updater", async (c) => {
    return c.json(await services.requireSourceUpdater().snapshot())
  })

  app.post("/global-config/source-updater", async (c) => {
    const body = await parseJsonBody(c, sourceUpdaterConfigurationSchema, {
      code: "invalid_source_updater_configuration",
    })
    if (body.automaticApply === true) requireAuthenticatedControl(services)
    try {
      return c.json(await services.requireSourceUpdater().updateConfiguration(body))
    } catch (error) {
      throw new HttpError(400, "invalid_source_updater_configuration", errorText(error))
    }
  })

  app.post("/global-config/source-updater/github-token", async (c) => {
    const body = await parseJsonBody(c, sourceUpdaterTokenSchema, {
      code: "invalid_source_updater_token",
    })
    try {
      return c.json(await services.requireSourceUpdater().setGitHubToken(body.token ?? undefined))
    } catch (error) {
      throw new HttpError(400, "invalid_source_updater_token", errorText(error))
    }
  })

  app.post("/global-config/source-updater/check", async (c) => {
    await parseJsonBody(c, sourceUpdaterConfigurationSchema, {
      code: "invalid_source_updater_check",
    })
    try {
      return c.json(await services.requireSourceUpdater().checkNow())
    } catch (error) {
      throw sourceUpdaterHttpError(error, "source_update_check_failed")
    }
  })

  app.post("/global-config/source-updater/prepare", async (c) => {
    requireAuthenticatedControl(services)
    const body = await parseJsonBody(c, sourceUpdaterPrepareSchema, {
      code: "invalid_source_updater_prepare",
    })
    try {
      return c.json(await services.requireSourceUpdater().prepare(body.expectedTargetRevision))
    } catch (error) {
      throw sourceUpdaterHttpError(error, "source_update_prepare_failed")
    }
  })

  app.post("/global-config/source-updater/apply", async (c) => {
    requireAuthenticatedControl(services)
    const body = await parseJsonBody(c, sourceUpdaterApplySchema, {
      code: "invalid_source_updater_apply",
    })
    try {
      return c.json(await services.requireSourceUpdater().apply(body))
    } catch (error) {
      throw sourceUpdaterHttpError(error, "source_update_apply_failed")
    }
  })

  app.post("/global-config/source-updater/rollback", async (c) => {
    requireAuthenticatedControl(services)
    const body = await parseJsonBody(c, sourceUpdaterRollbackSchema, {
      code: "invalid_source_updater_rollback",
    })
    try {
      return c.json(await services.requireSourceUpdater().rollback(body.operationId))
    } catch (error) {
      throw sourceUpdaterHttpError(error, "source_update_rollback_failed")
    }
  })

  return app
}

function requireAuthenticatedControl(services: Services): void {
  if (services.authentication?.snapshot().enabled !== true) {
    throw new HttpError(
      403,
      "source_update_authentication_required",
      "请先启用 WebUI 鉴权，再执行源码变更",
    )
  }
}

function sourceUpdaterHttpError(error: unknown, fallback: string): HttpError {
  const code = errorCode(error) ?? fallback
  const status =
    code === "source_update_system_busy" ||
    code === "source_update_operation_conflict" ||
    code === "source_update_revision_conflict" ||
    code === "source_update_dirty_worktree"
      ? 409
      : code === "source_update_executor_unavailable" ||
          code === "source_update_executor_timeout" ||
          code === "source_update_executor_failed"
        ? 503
        : code === "source_update_check_required" || code === "source_update_not_available"
          ? 422
          : 400
  return new HttpError(status, code, errorText(error))
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === "string" ? code : undefined
}
