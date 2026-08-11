import type { Context } from "hono"
import { streamSSE } from "hono/streaming"
import type { AppEnv } from "../context.ts"
import type { SseHub } from "./hub.ts"

export interface SseMessage {
  event: string
  data: string
  id?: string
}

/** 注册 SSE 路由：写入响应头并启动逐客户端消费循环。 */
export function sseRoute(
  c: Context<AppEnv>,
  hub: SseHub,
  sync: {
    refresh(): Promise<{ generatedAt: string }>
    refreshProject(projectId: string): Promise<{ generatedAt: string }>
    serializedSnapshot(): string
    health(): {
      status: string
      consecutiveFailures: number
      lastAttemptAt: string
      lastSuccessAt: string | null
      lastError: string | null
    }
  },
  projectId?: string,
): Response {
  const client = hub.connect(projectId)
  c.header("Content-Type", "text/event-stream; charset=utf-8")
  c.header("Cache-Control", "no-cache, no-transform")
  c.header("Connection", "keep-alive")
  c.header("X-Accel-Buffering", "no")
  return streamSSE(c, async (stream) => {
    stream.onAbort(() => hub.disconnect(client))
    try {
      const snapshot = projectId ? await sync.refreshProject(projectId) : await sync.refresh()
      await stream.write(": connected\n\n")
      await stream.writeSSE({
        event: "snapshot",
        data: projectId ? JSON.stringify(snapshot) : sync.serializedSnapshot(),
        id: snapshot.generatedAt,
      })
      await stream.writeSSE({
        event: "dashboard_status",
        data: JSON.stringify(sync.health()),
      })
      for (;;) {
        const item = await client.queue.next()
        if (!item) break
        if ("raw" in item) await stream.write(item.raw)
        else await stream.writeSSE(item)
      }
    } catch {
      hub.disconnect(client)
    }
  })
}
