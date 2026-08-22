import { createServer, type Server } from "node:http"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vite-plus/test"
import { SourceUpdateWorker, type UpdateWorkerOptions } from "../../updater/src/main.ts"

const roots: string[] = []
const servers: Server[] = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()))
        }),
    ),
  )
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("Update Worker 协议", () => {
  it("只允许 Bearer token 访问状态，并报告应用能力", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctf-update-worker-"))
    roots.push(root)
    const options: UpdateWorkerOptions = {
      host: "127.0.0.1",
      port: 0,
      token: "worker-secret",
      repository: "acme/agent",
      deploymentRoot: root,
      releasesDirectory: join(root, "releases"),
      currentPath: join(root, "current"),
      previousPath: join(root, "previous"),
      serviceName: "ctf-agent.service",
      healthUrl: "http://127.0.0.1:3000/health",
      allowApply: false,
      runSandboxBuild: false,
    }
    const worker = await SourceUpdateWorker.open(options)
    const server = createServer((request, response) => {
      void worker.handle(request, response)
    })
    servers.push(server)
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", () => resolve())
    })
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("测试 Worker 未监听端口")

    const unauthorized = await fetch(`http://127.0.0.1:${address.port}/v1/status`)
    expect(unauthorized.status).toBe(401)

    const authorized = await fetch(`http://127.0.0.1:${address.port}/v1/status`, {
      headers: { Authorization: "Bearer worker-secret" },
    })
    expect(authorized.status).toBe(200)
    expect(await authorized.json()).toMatchObject({
      protocolVersion: 1,
      connected: true,
      canPrepare: true,
      canApply: false,
    })
  })
})
