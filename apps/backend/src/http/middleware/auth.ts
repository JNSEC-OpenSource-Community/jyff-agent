import type { AppContext } from "../context.ts"
import { HttpError } from "../errors.ts"
import type { Services } from "../services.ts"

export function sessionToken(c: AppContext): string | undefined {
  const cookie = c.req.header("cookie")
  if (!cookie) return undefined
  for (const part of cookie.split(";")) {
    const separator = part.indexOf("=")
    if (
      separator < 0 ||
      part.slice(0, separator).trim() !== "ctf_agent_session"
    ) {
      continue
    }
    try {
      return decodeURIComponent(part.slice(separator + 1).trim())
    } catch {
      return undefined
    }
  }
  return undefined
}

export function isAuthenticated(
  services: Services,
  token: string | undefined,
): boolean {
  const authentication = services.authentication
  if (!authentication?.snapshot().enabled) return true
  return authentication.authenticate(token) === true
}

export function sessionCookie(token: string, secure: boolean): string {
  return [
    `ctf_agent_session=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${24 * 60 * 60}`,
    ...(secure ? ["Secure"] : []),
  ].join("; ")
}

export function expiredSessionCookie(secure: boolean): string {
  return [
    "ctf_agent_session=",
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=0",
    ...(secure ? ["Secure"] : []),
  ].join("; ")
}

/**
 * 全局鉴权闸门：/api/* 全部要求已登录，/api/auth 与 /api/auth/login 除外。
 * 挂在顶层应用上，对挂载的项目级路由同样生效。
 */
export function authenticationGate(services: Services) {
  return async (c: AppContext, next: () => Promise<void>): Promise<void> => {
    const path = c.req.path
    if (path === "/api/auth" || path === "/api/auth/login") {
      await next()
      return
    }
    if (isAuthenticated(services, sessionToken(c))) {
      await next()
      return
    }
    throw new HttpError(401, "authentication_required", "请先登录")
  }
}
