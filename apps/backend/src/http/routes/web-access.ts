import { Hono } from "hono"
import type { App, AppEnv } from "../context.ts"
import { errorText, HttpError } from "../errors.ts"
import {
  decodedParam,
  parseJsonBody,
  webAccessConfigurationSchema,
  webAccessKeySchema,
} from "../schema.ts"
import type { Services } from "../services.ts"

/** web-access 插件全局配置路由。 */
export function webAccessRoutes(services: Services): App {
  const app = new Hono<AppEnv>()

  app.get("/global-config/web-access", async (c) => {
    return c.json(await services.requireWebAccess().snapshot())
  })

  app.post("/global-config/web-access", async (c) => {
    const body = await parseJsonBody(c, webAccessConfigurationSchema, {
      code: "invalid_web_access_configuration",
    })
    try {
      return c.json(
        await services.requireWebAccess().update({
          ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
          ...(body.providers === undefined ? {} : { providers: body.providers }),
          ...(body.workflow === undefined ? {} : { workflow: body.workflow }),
          ...(body.summaryModel === undefined
            ? {}
            : { summaryModel: body.summaryModel ?? undefined }),
          ...(body.ssrf === undefined ? {} : { ssrf: body.ssrf }),
          ...(body.providerConfig === undefined ? {} : { providerConfig: body.providerConfig }),
        }),
      )
    } catch (error) {
      throw new HttpError(400, "invalid_web_access_configuration", errorText(error))
    }
  })

  app.post("/global-config/web-access/providers/:provider/key", async (c) => {
    const provider = decodedParam(c, "provider")
    const body = await parseJsonBody(c, webAccessKeySchema, {
      code: "invalid_web_access_key",
    })
    try {
      await services.requireWebAccess().setProviderKey(provider, body.apiKey ?? undefined)
      return c.json({ ok: true, provider })
    } catch (error) {
      throw new HttpError(400, "invalid_web_access_key", errorText(error))
    }
  })

  return app
}
