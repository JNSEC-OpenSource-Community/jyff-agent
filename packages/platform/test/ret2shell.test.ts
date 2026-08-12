import { createServer, type Server } from "node:http"
import { afterEach, describe, expect, it } from "vite-plus/test"
import {
  extractGameId,
  parseConfig,
  Ret2ShellProject,
  ret2shellPlatform,
} from "../src/ret2shell.ts"

describe("Ret2Shell platform", () => {
  let server: Server | undefined

  afterEach(async () => {
    server?.closeAllConnections()
    if (server?.listening) {
      await new Promise<void>((resolve, reject) =>
        server?.close((error) => (error ? reject(error) : resolve())),
      )
    }
    server = undefined
  })

  it("解析比赛 URL、认证类型与可选 game ID", () => {
    expect(
      parseConfig({
        baseUrl: "https://ctf.xidian.edu.cn/games/37/",
        auth: { type: "basic" },
      }),
    ).toEqual({
      baseUrl: "https://ctf.xidian.edu.cn",
      gameId: 37,
      auth: { type: "basic" },
    })
    expect(extractGameId("game-37", true)).toBe(37)
    expect(() =>
      parseConfig({ baseUrl: "https://ctf.example", auth: { type: "basic", token: "no" } }),
    ).toThrow("credentials must be provided through secrets")
  })

  it("声明控制面网络需求，使本地 wsrx 隧道可被 Solver 使用", async () => {
    const project = await ret2shellPlatform.connect({
      project: { id: "37", name: "Example" },
      config: { baseUrl: "https://ctf.example", auth: { type: "bearer" } },
      resolveSecret: (name) => (name === "R2S_TOKEN" ? "token" : undefined),
    })
    expect(project.solverSandboxNetwork).toBe("control_plane")
    await project.close()
  })

  it("请求 deadline 覆盖停滞的响应体", async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" })
      response.write("{")
    })
    const project = localProject(await listen(server))

    await expect(project.request({ path: "/stall", timeoutMs: 25 })).rejects.toMatchObject({
      code: "network",
      retryable: true,
    })
    await project.close()
  })

  it("外部 signal 可中断正在读取响应体的请求", async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" })
      response.write("{")
    })
    const project = localProject(await listen(server))
    const controller = new AbortController()
    const request = project.request({ path: "/stall", timeoutMs: 5_000, signal: controller.signal })
    setTimeout(() => controller.abort(), 20)

    await expect(request).rejects.toMatchObject({ name: "AbortError" })
    await project.close()
  })
})

function localProject(baseUrl: string): Ret2ShellProject {
  return new Ret2ShellProject({
    baseUrl,
    authHeader: "Bearer test",
    gameId: 1,
    project: { id: "1", name: "Test" },
  })
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("测试服务器未监听 TCP 端口")
  return `http://127.0.0.1:${address.port}`
}
