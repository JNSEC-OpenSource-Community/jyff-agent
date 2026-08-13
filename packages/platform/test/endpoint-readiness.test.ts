import { createServer as createHttpServer } from "node:http"
import { createServer as createTcpServer } from "node:net"
import { describe, expect, it } from "vite-plus/test"
import { waitForEndpointReachable } from "../src/endpoint-readiness.ts"

async function listen(server: ReturnType<typeof createTcpServer>): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("测试 server 未取得端口")
  return address.port
}

describe("endpoint readiness", () => {
  it("非 HTTP endpoint 使用 TCP 连接检测", async () => {
    const server = createTcpServer((socket) => socket.end())
    const port = await listen(server)
    try {
      await expect(
        waitForEndpointReachable(`127.0.0.1:${port}`, undefined, {
          timeoutMs: 1_000,
          retryDelayMs: 10,
        }),
      ).resolves.toBeUndefined()
    } finally {
      server.close()
    }
  })

  it("HTTP 5xx 继续等待，服务接受请求后才就绪", async () => {
    let requests = 0
    const server = createHttpServer((_request, response) => {
      requests++
      response.statusCode = requests === 1 ? 503 : 204
      response.end()
    })
    const port = await listen(server)
    try {
      await waitForEndpointReachable(`http://127.0.0.1:${port}/health`, undefined, {
        timeoutMs: 1_000,
        retryDelayMs: 10,
      })
      expect(requests).toBe(2)
    } finally {
      server.close()
    }
  })
})
