import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { App } from "../src/http/types.ts"
import type { WebUiOptions } from "../src/server.ts"
import { createWebUiApp, startWebUi, type WebUiServer } from "../src/server.ts"
import type { DashboardControlPlane } from "../src/types.ts"
import { FakeDashboardProject } from "./fake-project.ts"

/** 测试装配：临时目录 + 内存 app，返回可供 request 的实例。 */
export async function createTestApp(options: Partial<WebUiOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), "ctf-webui-test-"))
  const cleanup = async () => {
    await rm(root, { recursive: true, force: true })
  }
  const app = createWebUiApp({
    project: new FakeDashboardProject(),
    ...options,
  })
  return { ...app, root, cleanup }
}

export type TestApp = Awaited<ReturnType<typeof createTestApp>>

/** JSON 请求助手（自动带 content-type 与 body 序列化）。 */
export function jsonRequest(
  app: App,
  path: string,
  method = "GET",
  body?: unknown,
  headers?: Record<string, string>,
): Promise<Response> {
  return Promise.resolve(
    app.request(path, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
}

export async function jsonOf(
  response: Response,
): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>
}

/** 读取 SSE 响应体直到出现目标事件文本（用于断言首帧快照）。 */
export async function readSseUntil(
  response: Response,
  needle: string,
  timeoutMs = 5_000,
): Promise<string> {
  if (!response.body) throw new Error("SSE 响应没有 body")
  return readStreamUntil(response.body, needle, timeoutMs)
}

/** 基于已打开 reader 继续读取，直到出现目标文本（不 cancel，可复用）。 */
export async function readStreamUntil(
  stream: ReadableStream<Uint8Array>,
  needle: string,
  timeoutMs = 5_000,
): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let collected = ""
  const deadline = Date.now() + timeoutMs
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return collected
      collected += decoder.decode(value, { stream: true })
      if (collected.includes(needle)) return collected
      if (Date.now() > deadline) throw new Error(`SSE 超时：未等到 ${needle}`)
    }
  } finally {
    reader.releaseLock()
  }
}

/** 真实端口集成测试用的服务器装配。 */
export async function createTestServer(
  options: Partial<WebUiOptions> = {},
): Promise<{ server: WebUiServer; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "ctf-webui-server-"))
  const server = await startWebUi({
    project: new FakeDashboardProject(),
    host: "127.0.0.1",
    port: 0,
    pollIntervalMs: 60_000,
    ...options,
  })
  return {
    server,
    cleanup: async () => {
      await server.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

export type ControlPlaneOptions = {
  controlPlane: DashboardControlPlane
}

export { FakeDashboardProject }
