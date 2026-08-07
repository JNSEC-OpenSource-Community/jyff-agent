import type { Context, Hono } from "hono"
import type {
  DashboardControlPlane,
  DashboardProject,
  DashboardProjectRuntimeConfiguration,
  DashboardScheduler,
} from "../types.ts"
import type { Services } from "./services.ts"

/** 项目级路由上下文：由 /api/projects/:projectId 前缀中间件解析并注入。 */
export interface ProjectScope {
  projectId: string
  project?: DashboardProject
  scheduler?: DashboardScheduler
  runtime?: DashboardProjectRuntimeConfiguration
  controlPlane?: DashboardControlPlane
}

export interface AuthView {
  enabled: boolean
  username: string | null
  authenticated: boolean
}

export interface AppVariables {
  services: Services
  scope?: ProjectScope
  auth: AuthView
  secureCookies: boolean
}

export type AppEnv = { Variables: AppVariables }
export type AppContext = Context<AppEnv>
export type App = Hono<AppEnv>
