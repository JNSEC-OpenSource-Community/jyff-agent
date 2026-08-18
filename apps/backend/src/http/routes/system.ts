import { parseProjectConfig } from "@ctf-agent/core"
import { Hono } from "hono"
import { defaultBuiltInPluginConfigurationView } from "../../domain/built-in-plugin-config.ts"
import type { App, AppContext, AppEnv, ProjectScope } from "../context.ts"
import { errorText, HttpError } from "../errors.ts"
import {
  expiredSessionCookie,
  isAuthenticated,
  sessionCookie,
  sessionToken,
} from "../middleware/auth.ts"
import {
  parseJsonBody,
  builtInPluginStateSchema,
  readJsonBody,
  webUiAuthenticationSchema,
  webUiLoginSchema,
} from "../schema.ts"
import type { Services } from "../services.ts"
import { sseRoute } from "../sse/events.ts"

function authenticationOf(services: Services) {
  return services.authentication?.snapshot() ?? { enabled: false, username: null }
}

function setupFromBody(body: Record<string, unknown>): {
  config: import("@ctf-agent/core").ProjectConfig
  secrets?: Readonly<Record<string, string | undefined>>
} {
  let config: import("@ctf-agent/core").ProjectConfig
  try {
    config = parseProjectConfig(body.config)
  } catch (error) {
    throw new HttpError(400, "invalid_project_config", errorText(error))
  }
  if (body.secrets === undefined) return { config }
  if (typeof body.secrets !== "object" || body.secrets === null || Array.isArray(body.secrets)) {
    throw new HttpError(400, "invalid_secrets", "secrets 必须是字符串键值对象")
  }
  const secrets: Record<string, string | undefined> = {}
  for (const [name, value] of Object.entries(body.secrets)) {
    if (typeof value !== "string") {
      throw new HttpError(400, "invalid_secrets", `密钥 ${name} 必须是字符串`)
    }
    secrets[name] = value.length > 0 ? value : undefined
  }
  return { config, secrets }
}

/** 健康检查（挂载在顶层，不走 /api 前缀）。 */
export function healthRoutes(services: Services): App {
  const app = new Hono<AppEnv>()
  app.get("/health", async (c) => {
    const authentication = authenticationOf(services)
    const authenticated = isAuthenticated(services, sessionToken(c))
    return c.json({
      status: "ok",
      generatedAt: services.sync.latestSnapshot().generatedAt,
      connectedClients: services.sse.size,
      platformSync: { ...services.sync.health() },
      controlPlane: services.controlPlane?.snapshot() ?? null,
      scheduler: services.currentScheduler()?.snapshot() ?? null,
      modelConfiguration: services.modelConfiguration?.snapshot() ?? null,
      modelAuthentication: (await services.modelAuthentication?.snapshot()) ?? null,
      authentication: { ...authentication, authenticated },
    })
  })
  return app
}

/** 全局系统路由：WebUI 鉴权、全局配置、动态控制面、快照与 SSE（相对路径，挂载于 /api）。 */
export function systemRoutes(services: Services): App {
  const app = new Hono<AppEnv>()

  app.get("/auth", (c) => {
    const authentication = authenticationOf(services)
    return c.json({
      ...authentication,
      authenticated: isAuthenticated(services, sessionToken(c)),
    })
  })

  app.post("/auth/login", async (c) => {
    if (!services.authentication?.snapshot().enabled) {
      throw new HttpError(409, "authentication_disabled", "WebUI 鉴权未启用")
    }
    const body = await parseJsonBody(c, webUiLoginSchema, {
      code: "invalid_login",
    })
    try {
      const session = await services.authentication.login(body.username, body.password)
      c.header("Set-Cookie", sessionCookie(session.token, c.get("secureCookies")))
      return c.json({
        authenticated: true,
        username: session.username,
        expiresAt: session.expiresAt,
      })
    } catch (error) {
      throw new HttpError(401, "invalid_credentials", errorText(error))
    }
  })

  app.post("/auth/logout", (c) => {
    services.authentication?.logout(sessionToken(c))
    c.header("Set-Cookie", expiredSessionCookie(c.get("secureCookies")))
    return c.json({ authenticated: false })
  })

  app.get("/global-config", async (c) => {
    return c.json({
      authentication: authenticationOf(services),
      modelConfiguration: services.modelConfiguration?.snapshot() ?? null,
      modelAuthentication: (await services.modelAuthentication?.snapshot()) ?? null,
      plugins:
        services.builtInPluginConfiguration?.snapshot() ?? defaultBuiltInPluginConfigurationView(),
      webAccess: services.webAccessConfiguration
        ? await services.webAccessConfiguration.snapshot()
        : null,
      shellpoop: services.shellpoopConfiguration
        ? await services.shellpoopConfiguration.snapshot()
        : null,
    })
  })

  app.post("/global-config/plugins/:pluginId", async (c) => {
    const configuration = services.builtInPluginConfiguration
    if (!configuration) {
      throw new HttpError(404, "plugin_configuration_unavailable", "当前 WebUI 未配置插件存储")
    }
    const pluginId = c.req.param("pluginId")
    if (!configuration.has(pluginId)) {
      throw new HttpError(404, "plugin_not_found", `未知内置插件: ${pluginId}`)
    }
    const body = await parseJsonBody(c, builtInPluginStateSchema, {
      code: "invalid_plugin_configuration",
    })
    return c.json(await configuration.setEnabled(pluginId, body.enabled))
  })

  app.post("/global-config/authentication", async (c) => {
    if (!services.authentication) {
      throw new HttpError(404, "authentication_unavailable", "当前 WebUI 未配置鉴权存储")
    }
    const body = await parseJsonBody(c, webUiAuthenticationSchema, {
      code: "invalid_authentication_configuration",
    })
    try {
      return c.json(
        await services.authentication.configure({
          enabled: body.enabled,
          ...(body.enabled
            ? {
                username: body.username ?? "",
                ...(body.password === undefined ? {} : { password: body.password }),
              }
            : {}),
        }),
      )
    } catch (error) {
      throw new HttpError(400, "invalid_authentication_configuration", errorText(error))
    }
  })

  // ---- 动态控制面 ----

  app.get("/control-plane", (c) => {
    return c.json(services.requireControlPlane().setupSnapshot())
  })

  app.post("/control-plane/test", async (c) => {
    const controlPlane = services.requireControlPlane()
    const input = setupFromBody(await readJsonBody(c))
    try {
      return c.json(await controlPlane.testConnection(input))
    } catch (error) {
      throw new HttpError(422, "platform_connection_failed", errorText(error))
    }
  })

  app.post("/control-plane/apply", async (c) => {
    const controlPlane = services.requireControlPlane()
    const input = setupFromBody(await readJsonBody(c))
    try {
      await controlPlane.applySetup(input)
    } catch (error) {
      throw new HttpError(422, "platform_setup_failed", errorText(error))
    }
    return c.json({
      setup: controlPlane.setupSnapshot(),
      snapshot: await services.sync.refresh(),
    })
  })

  app.post("/control-plane/connect", async (c) => {
    const controlPlane = services.requireControlPlane()
    try {
      await controlPlane.connect()
    } catch (error) {
      throw new HttpError(503, "platform_connection_failed", errorText(error))
    }
    return c.json(await services.sync.refresh())
  })

  // ---- 快照与 SSE ----

  app.get("/snapshot", async (c) => {
    return c.json(await services.sync.refresh())
  })

  app.post("/refresh", async (c) => {
    await readJsonBody(c)
    const project = services.currentProject()
    if (project) await project.refresh()
    await services.currentScheduler()?.reconcile()
    return c.json(await services.sync.refresh())
  })

  app.get("/events", (c) => sseRoute(c, services.sse, services.sync))

  return app
}

/** 项目级快照/事件端点（与全局版共享实现）。 */
export function scopedSystemRoutes(services: Services): App {
  const app = new Hono<AppEnv>()

  const projectIdOf = (c: AppContext): string => {
    const scope = c.get("scope") as ProjectScope | undefined
    return scope?.projectId ?? ""
  }

  app.get("/snapshot", async (c) => {
    return c.json(await services.sync.refreshProject(projectIdOf(c)))
  })

  app.post("/refresh", async (c) => {
    await readJsonBody(c)
    const projectId = projectIdOf(c)
    const project = services.currentProject(projectId)
    if (project) await project.refresh()
    await services.currentScheduler(projectId)?.reconcile()
    return c.json(await services.sync.refreshProject(projectId))
  })

  app.delete("/environments/:environmentId", async (c) => {
    const projectId = projectIdOf(c)
    const project = services.requireProject(projectId)
    if (!project.destroyEnvironment) {
      throw new HttpError(501, "environment_management_unavailable", "当前平台不支持环境管理")
    }
    await project.destroyEnvironment(c.req.param("environmentId"))
    return c.json(await services.sync.refreshProject(projectId))
  })

  app.get("/events", (c) => {
    const projectId = projectIdOf(c)
    return sseRoute(c, services.sse, services.sync, projectId)
  })

  return app
}
