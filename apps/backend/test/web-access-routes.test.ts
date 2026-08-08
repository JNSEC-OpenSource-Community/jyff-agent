import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MemorySecretStore } from "@ctf-agent/core"
import { afterEach, describe, expect, it } from "vitest"
import { createFileWebAccessConfiguration } from "../src/domain/web-access-config.ts"
import { createFileWebUiAuthentication } from "../src/domain/webui-auth.ts"
import { createWebUiApp, type WebUiApp } from "../src/server.ts"
import { FakeDashboardProject } from "./fake-project.ts"
import { jsonOf, jsonRequest } from "./helpers.ts"

interface ProviderView {
  id: string
  enabled: boolean
  configured: boolean
}

function providersOf(body: Record<string, unknown>): ProviderView[] {
  return body.providers as ProviderView[]
}

describe("web-access 配置路由", () => {
  const roots: string[] = []
  let webApp: WebUiApp | undefined

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    )
    webApp = undefined
  })

  async function appWithWebAccess(authenticated = false) {
    const root = await mkdtemp(join(tmpdir(), "ctf-web-access-route-"))
    roots.push(root)
    const webAccessConfiguration = await createFileWebAccessConfiguration({
      storagePath: join(root, "web-access.json"),
      secretStore: new MemorySecretStore(),
    })
    let authentication:
      | Awaited<ReturnType<typeof createFileWebUiAuthentication>>
      | undefined
    if (authenticated) {
      authentication = await createFileWebUiAuthentication(
        join(root, "global-config.json"),
      )
      await authentication.configure({
        enabled: true,
        username: "operator",
        password: "strong-password",
      })
    }
    webApp = createWebUiApp({
      project: new FakeDashboardProject(),
      webAccessConfiguration,
      ...(authentication ? { authentication } : {}),
      frontendDist: "/nonexistent",
    })
    return { app: webApp.app, webAccessConfiguration }
  }

  it("GET 返回配置视图（含 provider configured 状态）", async () => {
    const { app, webAccessConfiguration } = await appWithWebAccess()
    await webAccessConfiguration.setProviderKey("brave", "k-brave")

    const res = await app.request("/api/global-config/web-access")
    expect(res.status).toBe(200)
    const body = await jsonOf(res)
    expect(body.enabled).toBe(false)
    const brave = providersOf(body).find((p) => p.id === "brave")
    expect(brave?.configured).toBe(true)
    // 视图绝不包含密钥值。
    expect(JSON.stringify(body)).not.toContain("k-brave")
  })

  it("POST 更新配置", async () => {
    const { app } = await appWithWebAccess()
    const res = await jsonRequest(
      app,
      "/api/global-config/web-access",
      "POST",
      {
        enabled: true,
        providers: ["brave", "gemini"],
        workflow: "auto-summary",
        ssrf: { allowRanges: ["10.0.0.0/8"], trustEnvProxy: false },
      },
    )
    expect(res.status).toBe(200)
    const body = await jsonOf(res)
    expect(body.enabled).toBe(true)
    expect(body.workflow).toBe("auto-summary")
    expect(
      providersOf(body)
        .filter((p) => p.enabled)
        .map((p) => p.id),
    ).toEqual(["brave", "gemini"])
  })

  it("POST 写入某 provider 的密钥（写 SecretStore）", async () => {
    const { app } = await appWithWebAccess()
    const res = await jsonRequest(
      app,
      "/api/global-config/web-access/providers/brave/key",
      "POST",
      { apiKey: "route-secret" },
    )
    expect(res.status).toBe(200)
    // 再次 GET 应显示已配置且不泄漏。
    const view = await jsonOf(
      await app.request("/api/global-config/web-access"),
    )
    const brave = providersOf(view).find((p) => p.id === "brave")
    expect(brave?.configured).toBe(true)
    expect(JSON.stringify(view)).not.toContain("route-secret")
  })

  it("未登录时 /api/global-config/web-access 返回 401", async () => {
    const { app } = await appWithWebAccess(true)
    expect((await app.request("/api/global-config/web-access")).status).toBe(
      401,
    )
  })
})
