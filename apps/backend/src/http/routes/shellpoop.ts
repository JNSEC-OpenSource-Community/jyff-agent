import { Hono } from "hono"
import type { App, AppEnv } from "../context.ts"
import { errorText, HttpError } from "../errors.ts"
import { parseJsonBody, shellpoopConfigurationSchema, shellpoopKeySchema } from "../schema.ts"
import type { Services } from "../services.ts"

/** ShellPoop 反弹 shell 插件全局配置路由。 */
export function shellpoopRoutes(services: Services): App {
  const app = new Hono<AppEnv>()

  app.get("/global-config/shellpoop", async (c) => {
    return c.json(await services.requireShellPoop().snapshot())
  })

  app.post("/global-config/shellpoop", async (c) => {
    const body = await parseJsonBody(c, shellpoopConfigurationSchema, {
      code: "invalid_shellpoop_configuration",
    })
    try {
      return c.json(
        await services.requireShellPoop().update({
          ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
          ...(body.baseUrl === undefined ? {} : { baseUrl: body.baseUrl }),
          ...(body.timeoutMs === undefined ? {} : { timeoutMs: body.timeoutMs }),
        }),
      )
    } catch (error) {
      throw new HttpError(400, "invalid_shellpoop_configuration", errorText(error))
    }
  })

  app.post("/global-config/shellpoop/key", async (c) => {
    const body = await parseJsonBody(c, shellpoopKeySchema, {
      code: "invalid_shellpoop_key",
    })
    try {
      await services.requireShellPoop().setApiKey(body.apiKey ?? undefined)
      return c.json({ ok: true })
    } catch (error) {
      throw new HttpError(400, "invalid_shellpoop_key", errorText(error))
    }
  })

  return app
}
