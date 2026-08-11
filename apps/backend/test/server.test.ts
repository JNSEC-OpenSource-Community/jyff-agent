import { afterEach, describe, expect, it } from "vite-plus/test"
import { createWebUiApp, startWebUi } from "../src/server.ts"
import { FakeDashboardProject } from "./fake-project.ts"
import { jsonOf } from "./helpers.ts"

describe("WebUI 服务集成", () => {
  const servers: Array<{ close: () => Promise<void> }> = []

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()))
  })

  it("startWebUi 在真实端口提供健康检查与静态页面", async () => {
    const server = await startWebUi({
      project: new FakeDashboardProject(),
      host: "127.0.0.1",
      port: 0,
      pollIntervalMs: 60_000,
    })
    servers.push(server)

    expect(server.port).toBeGreaterThan(0)
    expect(server.url).toContain(`:${server.port}`)

    const health = await fetch(`${server.url}/health`)
    expect(health.status).toBe(200)
    expect(await jsonOf(health)).toMatchObject({ status: "ok" })

    const home = await fetch(`${server.url}/`)
    expect(home.status).toBe(200)
    expect(home.headers.get("content-type")).toContain("text/html")
  })

  it("静态资源：dist 产物按单斜杠路径提供，index.html 映射到 /", async () => {
    const { mkdtemp, writeFile } = await import("node:fs/promises")
    const { tmpdir } = await import("node:os")
    const path = await import("node:path")
    const dist = await mkdtemp(path.join(tmpdir(), "webui-dist-"))
    await writeFile(path.join(dist, "index.html"), "<html>index</html>")
    await writeFile(path.join(dist, "app.js"), "console.log(1)")
    await writeFile(path.join(dist, "app.css"), "body{}")
    const { app } = createWebUiApp({
      project: new FakeDashboardProject(),
      frontendDist: dist,
    })
    const home = await app.request("/")
    expect(await home.text()).toBe("<html>index</html>")
    const script = await app.request("/app.js")
    expect(script.status).toBe(200)
    expect(await script.text()).toBe("console.log(1)")
    expect(script.headers.get("content-type")).toContain("javascript")
    const style = await app.request("/app.css")
    expect(style.status).toBe(200)
    expect(await style.text()).toBe("body{}")
  })

  it("createWebUiApp 与 startWebUi 共享同一条健康路径", async () => {
    const { app } = createWebUiApp({
      project: new FakeDashboardProject(),
      frontendDist: "/nonexistent",
    })
    const inMemory = await app.request("/health")
    expect(inMemory.status).toBe(200)

    const server = await startWebUi({
      project: new FakeDashboardProject(),
      host: "127.0.0.1",
      port: 0,
      pollIntervalMs: 60_000,
    })
    servers.push(server)
    const overWire = await fetch(`${server.url}/health`)
    expect(overWire.status).toBe(200)
  })

  it("调度器重连退避：失败时 dashboard 显示错误，恢复后自动重试成功", async () => {
    const project = new FakeDashboardProject()
    let failures = 0
    const flaky = Object.assign(new FakeDashboardProject(), {
      overview: async () => {
        if (failures < 2) {
          failures += 1
          throw new Error("平台连接超时")
        }
        return await project.overview()
      },
    })
    const server = await startWebUi({
      project: flaky,
      host: "127.0.0.1",
      port: 0,
      pollIntervalMs: 30,
    })
    servers.push(server)

    // 启动时的首次刷新失败；轮询重试两次后成功并恢复。
    const started = Date.now()
    for (;;) {
      const snapshot = await fetch(`${server.url}/api/snapshot`)
      const body = await jsonOf(snapshot)
      if (body.overview && (body.overview as { name?: string }).name) break
      if (Date.now() - started > 5_000) throw new Error("轮询始终未恢复")
      await new Promise((resolve) => setTimeout(resolve, 50))
    }

    const recovered = await jsonOf(await fetch(`${server.url}/health`))
    expect((recovered.platformSync as { status?: string }).status).toBe("ok")
    expect(failures).toBe(2)
  })
})
