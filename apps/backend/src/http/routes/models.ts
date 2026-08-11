import { Hono } from "hono"
import type { App, AppContext, AppEnv } from "../context.ts"
import { errorText, HttpError } from "../errors.ts"
import {
  customModelProviderEditSchema,
  customModelProviderSchema,
  modelConfigurationUpdateSchema,
  modelImportSchema,
  modelLoginSchema,
  modelPromptSchema,
  parseJsonBody,
  readJsonBody,
} from "../schema.ts"
import type { Services } from "../services.ts"

/** 包装模型登录动作：统一映射为 400 invalid_model_authentication。 */
async function modelAuthenticationAction<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action()
  } catch (error) {
    throw new HttpError(400, "invalid_model_authentication", errorText(error))
  }
}

async function modelProviderAction<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action()
  } catch (error) {
    throw new HttpError(400, "invalid_model_provider", errorText(error))
  }
}

/** 模型配置与凭据路由（全局版）。 */
export function modelsRoutes(services: Services): App {
  const app = new Hono<AppEnv>()

  app.get("/model-config", (c) => {
    return c.json(services.modelView())
  })

  app.post("/model-config", async (c) => {
    const modelConfiguration = services.requireModelConfiguration()
    const body = await parseJsonBody(c, modelConfigurationUpdateSchema, {
      code: "invalid_model_configuration",
      maximumSize: 256_000,
    })
    const configuration = await modelConfiguration.update(body)
    const scheduler = services.currentScheduler()
    if (!configuration.configured) scheduler?.pauseAuto()
    else await scheduler?.reconcile()
    return c.json({
      configuration: services.modelView(),
      snapshot: await services.sync.refresh(),
    })
  })

  app.post("/model-config/providers", async (c) => {
    const modelConfiguration = services.requireModelConfiguration()
    const body = await parseJsonBody(c, customModelProviderSchema, {
      code: "invalid_model_provider",
    })
    return c.json({
      configuration: await modelProviderAction(() => modelConfiguration.addCustomProvider(body)),
    })
  })

  app.put("/model-config/providers/:providerId", async (c) => {
    const modelConfiguration = services.requireModelConfiguration()
    const body = await parseJsonBody(c, customModelProviderEditSchema, {
      code: "invalid_model_provider",
    })
    return c.json({
      configuration: await modelProviderAction(() =>
        modelConfiguration.updateCustomProvider(c.req.param("providerId"), body),
      ),
    })
  })

  app.delete("/model-config/providers/:providerId", async (c) => {
    const modelConfiguration = services.requireModelConfiguration()
    await readJsonBody(c)
    return c.json({
      configuration: await modelProviderAction(() =>
        modelConfiguration.removeCustomProvider(c.req.param("providerId")),
      ),
    })
  })

  app.get("/model-config/providers/:providerId/models", async (c) => {
    const modelConfiguration = services.requireModelConfiguration()
    return c.json({
      models: await modelProviderAction(() =>
        modelConfiguration.discoverCustomProviderModels(c.req.param("providerId")),
      ),
    })
  })

  app.get("/model-auth", async (c) => {
    return c.json(await services.requireModelAuthentication().snapshot())
  })

  app.post("/model-auth/login", async (c) => {
    const authentication = services.requireModelAuthentication()
    const body = await parseJsonBody(c, modelLoginSchema, {
      code: "invalid_model_authentication",
    })
    return c.json(
      await modelAuthenticationAction(() =>
        authentication.startLogin({
          provider: body.provider,
          method: body.method,
          ...(body.secret ? { secret: body.secret } : {}),
        }),
      ),
      202,
    )
  })

  app.get("/model-auth/login/:sessionId", async (c) => {
    const authentication = services.requireModelAuthentication()
    const session = await modelAuthenticationAction(() =>
      Promise.resolve(authentication.loginSession(c.req.param("sessionId"))),
    )
    if (session.status === "success") {
      await services.reconcileModelAvailability(services.currentScheduler())
    }
    return c.json(session)
  })

  app.post("/model-auth/login/:sessionId/prompt", async (c) => {
    const authentication = services.requireModelAuthentication()
    const body = await parseJsonBody(c, modelPromptSchema, {
      code: "invalid_model_authentication",
    })
    return c.json(
      await modelAuthenticationAction(() =>
        Promise.resolve(authentication.submitPrompt(c.req.param("sessionId"), body.value)),
      ),
    )
  })

  app.post("/model-auth/login/:sessionId/cancel", async (c) => {
    const authentication = services.requireModelAuthentication()
    await readJsonBody(c)
    return c.json(
      await modelAuthenticationAction(() =>
        Promise.resolve(authentication.cancelLogin(c.req.param("sessionId"))),
      ),
    )
  })

  app.post("/model-auth/providers/:provider/logout", async (c) => {
    const modelAuthentication = services.requireModelAuthentication()
    await readJsonBody(c)
    const authentication = await modelAuthenticationAction(() =>
      modelAuthentication.logout(c.req.param("provider")),
    )
    const configuration = await services.reconcileModelAvailability(services.currentScheduler())
    return c.json({
      authentication,
      configuration,
      snapshot: await services.sync.refresh(),
    })
  })

  app.post("/model-auth/import", async (c) => {
    const authentication = services.requireModelAuthentication()
    const body = await parseJsonBody(c, modelImportSchema, {
      code: "invalid_model_authentication",
      maximumSize: 262_144,
    })
    const imported = await modelAuthenticationAction(() => authentication.importJson(body.json))
    const configuration = await services.reconcileModelAvailability(services.currentScheduler())
    return c.json({
      imported,
      authentication: await authentication.snapshot(),
      configuration,
      snapshot: await services.sync.refresh(),
    })
  })

  app.post("/model-auth/import-file", async (c) => {
    const authentication = services.requireModelAuthentication()
    await readJsonBody(c)
    const imported = await modelAuthenticationAction(() => authentication.importFile())
    const configuration = await services.reconcileModelAvailability(services.currentScheduler())
    return c.json({
      imported,
      authentication: await authentication.snapshot(),
      configuration,
      snapshot: await services.sync.refresh(),
    })
  })

  return app
}

/** 项目级模型配置（绑定基于该项目运行配置）。 */
export function scopedModelsRoutes(services: Services): App {
  const app = new Hono<AppEnv>()

  const projectIdOf = (c: AppContext): string => {
    const scope = c.get("scope") as { projectId?: string } | undefined
    return scope?.projectId ?? ""
  }

  app.get("/model-config", (c) => {
    return c.json(services.modelView(projectIdOf(c)))
  })

  app.post("/model-config", async (c) => {
    const modelConfiguration = services.requireModelConfiguration()
    const body = await parseJsonBody(c, modelConfigurationUpdateSchema, {
      code: "invalid_model_configuration",
      maximumSize: 256_000,
    })
    const configuration = await modelConfiguration.update(body)
    const scheduler = services.currentScheduler(projectIdOf(c))
    if (!configuration.configured) scheduler?.pauseAuto()
    else await scheduler?.reconcile()
    return c.json({
      configuration: services.modelView(projectIdOf(c)),
      snapshot: await services.sync.refreshProject(projectIdOf(c)),
    })
  })

  return app
}
