import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createFileWebUiAuthentication } from "../src/domain/webui-auth.ts"
import { createWebUiApp, type WebUiApp } from "../src/server.ts"
import { FakeDashboardProject } from "./fake-project.ts"
import { jsonOf, jsonRequest } from "./helpers.ts"

describe("WebUI 鉴权", () => {
  const roots: string[] = []
  let webApp: WebUiApp | undefined

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    )
    webApp = undefined
  })

  async function appWithAuth(enabled = true) {
    const root = await mkdtemp(join(tmpdir(), "ctf-webui-auth-"))
    roots.push(root)
    const authentication = await createFileWebUiAuthentication(
      join(root, "global-config.json"),
    )
    if (enabled) {
      await authentication.configure({
        enabled: true,
        username: "operator",
        password: "strong-password",
      })
    }
    webApp = createWebUiApp({
      project: new FakeDashboardProject(),
      authentication,
      frontendDist: "/nonexistent",
    })
    return { app: webApp.app, authentication }
  }

  it("未登录时 /api/* 被拒绝，登录后可访问，登出后失效", async () => {
    const { app, authentication } = await appWithAuth()

    expect((await app.request("/api/snapshot")).status).toBe(401)
    expect((await app.request("/api/projects/x/snapshot")).status).toBe(401)
    // 健康检查与静态页面不需要登录
    expect((await app.request("/health")).status).toBe(200)
    expect((await app.request("/")).status).toBe(200)

    const rejected = await jsonRequest(app, "/api/auth/login", "POST", {
      username: "operator",
      password: "wrong-password",
    })
    expect(rejected.status).toBe(401)
    expect(await jsonOf(rejected)).toMatchObject({
      error: "invalid_credentials",
    })

    const login = await jsonRequest(app, "/api/auth/login", "POST", {
      username: "operator",
      password: "strong-password",
    })
    expect(login.status).toBe(200)
    const cookie = login.headers.get("set-cookie")
    expect(cookie).toContain("HttpOnly")
    expect(cookie).toContain("SameSite=Strict")

    const snapshot = await app.request("/api/snapshot", {
      headers: { Cookie: cookie ?? "" },
    })
    expect(snapshot.status).toBe(200)

    const logout = await jsonRequest(
      app,
      "/api/auth/logout",
      "POST",
      {},
      { Cookie: cookie ?? "" },
    )
    expect(logout.status).toBe(200)
    expect(
      authentication.authenticate(cookie?.split("=")[1]?.split(";")[0]),
    ).toBe(false)
    expect(
      (
        await app.request("/api/snapshot", {
          headers: { Cookie: cookie ?? "" },
        })
      ).status,
    ).toBe(401)
  })

  it("鉴权未启用时无需登录且登录接口返回 409", async () => {
    const { app } = await appWithAuth(false)
    expect((await app.request("/api/snapshot")).status).toBe(200)

    const login = await jsonRequest(app, "/api/auth/login", "POST", {
      username: "operator",
      password: "strong-password",
    })
    expect(login.status).toBe(409)
    expect(await jsonOf(login)).toMatchObject({
      error: "authentication_disabled",
    })
  })

  it("/api/auth 反映当前登录状态", async () => {
    const { app } = await appWithAuth()
    const anonymous = await app.request("/api/auth")
    expect(await jsonOf(anonymous)).toMatchObject({
      enabled: true,
      authenticated: false,
    })

    const login = await jsonRequest(app, "/api/auth/login", "POST", {
      username: "operator",
      password: "strong-password",
    })
    const cookie = login.headers.get("set-cookie") ?? ""
    const loggedIn = await app.request("/api/auth", {
      headers: { Cookie: cookie },
    })
    expect(await jsonOf(loggedIn)).toMatchObject({
      enabled: true,
      username: "operator",
      authenticated: true,
    })
  })

  it("登录接口校验用户名与密码格式", async () => {
    const { app } = await appWithAuth()
    for (const body of [
      { username: "", password: "x" },
      { username: "op", password: "" },
    ]) {
      const response = await jsonRequest(app, "/api/auth/login", "POST", body)
      expect(response.status).toBe(400)
      expect(await jsonOf(response)).toMatchObject({ error: "invalid_login" })
    }
  })

  it("配置鉴权：启用/禁用并校验表单", async () => {
    const { app, authentication } = await appWithAuth(false)

    const enabled = await jsonRequest(
      app,
      "/api/global-config/authentication",
      "POST",
      {
        enabled: true,
        username: "operator",
        password: "new-password",
      },
    )
    expect(enabled.status).toBe(200)
    expect(authentication.snapshot().enabled).toBe(true)

    // 启用后先登录，再继续操作
    const login = await jsonRequest(app, "/api/auth/login", "POST", {
      username: "operator",
      password: "new-password",
    })
    const cookie = login.headers.get("set-cookie") ?? ""

    // 启用后必须提供用户名
    const missingUsername = await jsonRequest(
      app,
      "/api/global-config/authentication",
      "POST",
      { enabled: true, password: "x" },
      { Cookie: cookie },
    )
    expect(missingUsername.status).toBe(400)
    expect(await jsonOf(missingUsername)).toMatchObject({
      error: "invalid_authentication_configuration",
    })

    const disabled = await jsonRequest(
      app,
      "/api/global-config/authentication",
      "POST",
      { enabled: false },
      { Cookie: cookie },
    )
    expect(disabled.status).toBe(200)
    expect(authentication.snapshot().enabled).toBe(false)
  })

  it("global-config 汇总鉴权与模型配置状态", async () => {
    const { app, authentication } = await appWithAuth()
    const login = await jsonRequest(app, "/api/auth/login", "POST", {
      username: "operator",
      password: "strong-password",
    })
    const cookie = login.headers.get("set-cookie") ?? ""
    const response = await app.request("/api/global-config", {
      headers: { Cookie: cookie },
    })
    expect(response.status).toBe(200)
    const body = await jsonOf(response)
    expect(body.authentication).toMatchObject({
      enabled: true,
      username: "operator",
    })
    expect(body.modelConfiguration).toBeNull()
    expect(body.modelAuthentication).toBeNull()
    expect(authentication.snapshot().enabled).toBe(true)
  })
})
