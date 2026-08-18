import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vite-plus/test"
import { createFileShellPoopConfiguration } from "../src/domain/shellpoop-config.ts"
import { createFileWebUiAuthentication } from "../src/domain/webui-auth.ts"
import { createWebUiApp, type WebUiApp } from "../src/server.ts"
import { FakeDashboardProject } from "./fake-project.ts"
import { jsonOf, jsonRequest } from "./helpers.ts"

describe("ShellPoop 配置路由", () => {
  const roots: string[] = []
  let webApp: WebUiApp | undefined

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
    webApp = undefined
  })

  async function appWithShellPoop(authenticated = false) {
    const root = await mkdtemp(join(tmpdir(), "ctf-shellpoop-route-"))
    roots.push(root)
    const shellpoopConfiguration = await createFileShellPoopConfiguration({
      storagePath: join(root, "shellpoop.json"),
    })
    let authentication: Awaited<ReturnType<typeof createFileWebUiAuthentication>> | undefined
    if (authenticated) {
      authentication = await createFileWebUiAuthentication(join(root, "global-config.json"))
      await authentication.configure({
        enabled: true,
        username: "operator",
        password: "strong-password",
      })
    }
    webApp = createWebUiApp({
      project: new FakeDashboardProject(),
      shellpoopConfiguration,
      ...(authentication ? { authentication } : {}),
      frontendDist: "/nonexistent",
    })
    return { app: webApp.app, shellpoopConfiguration }
  }

  it("GET 返回配置视图", async () => {
    const { app } = await appWithShellPoop()
    const res = await app.request("/api/global-config/shellpoop")
    expect(res.status).toBe(200)
    const body = await jsonOf(res)
    expect(body.enabled).toBe(false)
    expect(body.baseUrl).toBe("http://127.0.0.1:8000")
  })

  it("POST 更新配置", async () => {
    const { app } = await appWithShellPoop()
    const res = await jsonRequest(app, "/api/global-config/shellpoop", "POST", {
      enabled: true,
      baseUrl: "http://shellpoop:8000",
      timeoutMs: 5000,
    })
    expect(res.status).toBe(200)
    const body = await jsonOf(res)
    expect(body.enabled).toBe(true)
    expect(body.baseUrl).toBe("http://shellpoop:8000")
    expect(body.timeoutMs).toBe(5000)
  })

  it("POST 拒绝非法 baseUrl", async () => {
    const { app } = await appWithShellPoop()
    const res = await jsonRequest(app, "/api/global-config/shellpoop", "POST", {
      baseUrl: "ftp://bad",
    })
    expect(res.status).toBe(400)
  })

  it("/global-config 快照包含 shellpoop 配置", async () => {
    const { app, shellpoopConfiguration } = await appWithShellPoop()
    await shellpoopConfiguration.update({ enabled: true })
    const res = await app.request("/api/global-config")
    expect(res.status).toBe(200)
    const body = await jsonOf(res)
    expect(body.shellpoop).toEqual(expect.objectContaining({ enabled: true }))
  })

  it("未登录时 /api/global-config/shellpoop 返回 401", async () => {
    const { app } = await appWithShellPoop(true)
    expect((await app.request("/api/global-config/shellpoop")).status).toBe(401)
  })
})
