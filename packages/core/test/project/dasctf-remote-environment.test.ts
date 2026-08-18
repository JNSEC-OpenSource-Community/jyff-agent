import { createServer, type Server } from "node:http"
import { dasctfPlatform } from "@ctf-agent/platform"
import { afterEach, describe, expect, it } from "vite-plus/test"
import {
  RemoteEnvironmentCoordinator,
  type RemoteEnvironmentLeaseRecord,
  type RemoteEnvironmentLeaseStore,
} from "../../src/project/remote-environment-coordinator.ts"

const API_PREFIX = "/slab-match/api/v1/agent/"
const ACCESS_KEY = "test-access-key"

class MemoryLeaseStore implements RemoteEnvironmentLeaseStore {
  readonly leases = new Map<string, RemoteEnvironmentLeaseRecord>()

  listEnvironmentLeases(): RemoteEnvironmentLeaseRecord[] {
    return [...this.leases.values()]
  }

  saveEnvironmentLease(record: RemoteEnvironmentLeaseRecord): void {
    this.leases.set(record.runId, { ...record })
  }

  deleteEnvironmentLease(runId: string): void {
    this.leases.delete(runId)
  }
}

describe("DASCTF remote environment through Core", () => {
  let server: Server | undefined

  afterEach(async () => {
    server?.closeAllConnections()
    if (server) {
      await new Promise<void>((resolve, reject) =>
        server?.close((error) => (error ? reject(error) : resolve())),
      )
    }
    server = undefined
  })

  it("同一 Run 的并发申请只 build 一次，并在 readiness 后持久化和回收", async () => {
    let baseUrl = ""
    let running = false
    let builds = 0
    let recovers = 0
    server = createServer((request, response) => {
      const path = request.url ?? "/"
      if (path === `${API_PREFIX}ctf/exercise?exerciseId=1001`) {
        return envelope(response, detail(baseUrl, running))
      }
      if (path === `${API_PREFIX}ctf/build-exercise-env`) {
        builds++
        running = true
        return envelope(response, {})
      }
      if (path === `${API_PREFIX}ctf/recover-exercise-env`) {
        recovers++
        running = false
        return envelope(response, {})
      }
      response.statusCode = 404
      response.end()
    })
    baseUrl = await listen(server)

    const platform = await dasctfPlatform.connect({
      project: { id: "dasctf-core", name: "DASCTF Core" },
      config: {
        baseUrl,
        minRequestIntervalMs: 1,
        environmentPollIntervalMs: 100,
        environmentMaxPollIntervalMs: 100,
        environmentReadyTimeoutMs: 2_000,
      },
      resolveSecret: (name) => (name === "DASCTF_ACCESS_KEY" ? ACCESS_KEY : undefined),
    })
    const capability = await platform.bindChallenge("1001")
    const challenge = await capability.getInfo()
    const store = new MemoryLeaseStore()
    const coordinator = new RemoteEnvironmentCoordinator(1, store, {
      startTimeoutMs: 3_000,
      operationTimeoutMs: 1_000,
    })
    const managed = coordinator.manage({
      runId: "run-dasctf",
      challenge,
      capability,
    })

    const [first, second] = await Promise.all([
      managed.instance?.start(),
      managed.instance?.start(),
    ])
    expect(first).toEqual(second)
    expect(first).toMatchObject({
      id: "dasctf:1001",
      status: "running",
      endpoint: expect.stringMatching(/^127\.0\.0\.1:\d+$/),
      readyAt: expect.any(String),
    })
    expect(builds).toBe(1)
    expect(store.leases.get("run-dasctf")).toMatchObject({
      challengeId: "1001",
      environmentId: "dasctf:1001",
    })

    await managed.instance?.destroy()
    expect(recovers).toBe(1)
    expect(store.leases.size).toBe(0)
    await coordinator.close()
    await platform.close()
  })
})

function detail(baseUrl: string, running: boolean) {
  const port = Number(new URL(baseUrl).port)
  return {
    id: 1001,
    name: "core-env",
    description: "Core integration",
    score: "100",
    difficulty: "WEB",
    endpoints: running
      ? [
          {
            portMappings: [{ type: "tcp", port: "80", proxy: String(port) }],
            proxyIps: ["127.0.0.1"],
            isProxy: true,
            expireTime: Date.now() + 60_000,
          },
        ]
      : [],
    isNeedInit: !running,
    isNeedCheck: false,
    endpointType: "monopoly",
    currentTime: Date.now(),
  }
}

function envelope(response: import("node:http").ServerResponse, data: unknown): void {
  response.statusCode = 200
  response.setHeader("Content-Type", "application/json")
  response.end(JSON.stringify({ code: "00000", message: "", data }))
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
