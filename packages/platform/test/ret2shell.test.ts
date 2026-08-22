import { createServer, type Server } from "node:http"
import { afterEach, describe, expect, it, vi } from "vite-plus/test"
import {
  extractGameId,
  parseConfig,
  Ret2ShellProject,
  ret2shellPlatform,
} from "../src/ret2shell.ts"

describe("Ret2Shell platform", () => {
  let server: Server | undefined

  afterEach(async () => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
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

  it("返回比赛和排行榜链接，并按已解题计算当前分数", async () => {
    server = createServer((request, response) => {
      const path = request.url ?? "/"
      if (path === "/api/game/1") {
        return json(response, { id: 1, name: "Local Game" })
      }
      if (path === "/api/game/1/challenge") {
        return json(response, [
          [
            {
              id: 7,
              name: "Evidence",
              tag: [{ name: "web", primary: true }],
              score: 100,
            },
            {
              id: 8,
              name: "Signal",
              tag: [{ name: "misc", primary: true }],
              score: 200,
            },
          ],
          2,
        ])
      }
      if (path === "/api/game/1/solve") {
        return json(response, [{ challenge_id: 7 }])
      }
      if (path === "/api/game/1/notification") return json(response, [])
      return json(response, { error: "not found" }, 404)
    })
    const baseUrl = await listen(server)
    const project = localProject(baseUrl)

    expect(await project.getOverview()).toMatchObject({
      id: "1",
      name: "Local Game",
      participant: { score: 100, rank: null },
      links: {
        contest: `${baseUrl}/games/1`,
        leaderboard: `${baseUrl}/games/1/scoreboard`,
      },
    })
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

  it("将 cargo crates 重建中的 412 标记为可退避重试", async () => {
    server = createServer((_request, response) => {
      response.writeHead(412, { "Content-Type": "text/plain" })
      response.end("please wait for rebuilding cargo crates")
    })
    const project = localProject(await listen(server))

    await expect(project.request({ path: "/building" })).rejects.toMatchObject({
      code: "precondition",
      retryable: true,
      retryAfterMs: undefined,
    })
    await project.close()
  })

  it("销毁实例会等待平台列表确认资源消失后再返回", async () => {
    vi.useFakeTimers()
    let deleteAccepted = false
    let deleteRequests = 0
    let statusReads = 0
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const url = new URL(
          typeof input === "string" ? input : input instanceof URL ? input : input.url,
        )
        const method = init?.method ?? "GET"
        if (method === "DELETE" && url.pathname === "/api/game/1/challenge/7/instance") {
          deleteRequests++
          if (deleteRequests > 1) return new Response("not found", { status: 404 })
          deleteAccepted = true
          return jsonResponse({})
        }
        if (method === "GET" && url.pathname === "/api/game/1/instance") {
          statusReads++
          return jsonResponse(
            deleteAccepted && statusReads >= 2
              ? []
              : [
                  {
                    state: "Running",
                    name: "instance-7",
                    traffic: "traffic-7",
                    ports: [],
                    renew_count: 0,
                    created_at: 0,
                    user_id: 1,
                    team_id: 1,
                    challenge_id: 7,
                    game_id: 1,
                    exposed_ports: [],
                  },
                ],
          )
        }
        return new Response("not found", { status: 404 })
      }),
    )
    const project = localProject("https://ret2shell.test")
    const capability = await project.bindChallenge("7")
    if (!capability.instance) throw new Error("测试题目缺少远程环境能力")

    const destroying = capability.instance.destroy()
    await vi.advanceTimersByTimeAsync(0)
    expect(statusReads).toBe(1)
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    await vi.advanceTimersByTimeAsync(1_000)
    await destroying
    await expect(capability.instance.destroy()).resolves.toBeUndefined()

    expect(deleteAccepted).toBe(true)
    expect(deleteRequests).toBe(2)
    expect(statusReads).toBe(2)
    await project.close()
  })
})

function json(response: import("node:http").ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { "Content-Type": "application/json" })
  response.end(JSON.stringify(body))
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  })
}

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
