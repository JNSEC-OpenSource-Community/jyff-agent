/**
 * SSE 客户端注册表。
 *
 * 每个连接拥有独立的串行消息队列：广播只做同步入队，实际写入由该连接
 * 唯一的消费循环执行，因此任意时刻不会有两个写者竞争同一个 socket。
 */
import type { Context } from "hono"
import { streamSSE } from "hono/streaming"
import type { AppEnv } from "./types.ts"

export interface SseMessage {
  event: string
  data: string
  id?: string
}

type QueueItem = SseMessage | { raw: string }

class ClientQueue {
  private items: QueueItem[] = []
  private waiters: Array<(item: QueueItem | undefined) => void> = []
  closed = false

  push(item: QueueItem): void {
    if (this.closed) return
    const waiter = this.waiters.shift()
    if (waiter) waiter(item)
    else this.items.push(item)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const waiter of this.waiters.splice(0)) waiter(undefined)
  }

  async next(): Promise<QueueItem | undefined> {
    const item = this.items.shift()
    if (item) return item
    if (this.closed) return undefined
    return await new Promise<QueueItem | undefined>((resolve) => {
      this.waiters.push(resolve)
    })
  }
}

export interface SseClient {
  projectId?: string
  readonly queue: ClientQueue
}

export class SseHub {
  private readonly clients = new Set<SseClient>()

  get size(): number {
    return this.clients.size
  }

  /** 当前有订阅者的项目（用于轮询时按项目刷新快照）。 */
  scopedProjectIds(): string[] {
    return [
      ...new Set(
        [...this.clients]
          .map((client) => client.projectId)
          .filter((id): id is string => id !== undefined),
      ),
    ]
  }

  connect(projectId?: string): SseClient {
    const client: SseClient = { projectId, queue: new ClientQueue() }
    this.clients.add(client)
    return client
  }

  disconnect(client: SseClient): void {
    this.clients.delete(client)
    client.queue.close()
  }

  broadcast(
    event: string,
    data: string,
    id?: string,
    projectId?: string,
  ): void {
    for (const client of this.clients) {
      if (client.projectId === projectId) {
        client.queue.push({ event, data, ...(id ? { id } : {}) })
      }
    }
  }

  /** SSE 保活注释。 */
  ping(): void {
    for (const client of this.clients) {
      client.queue.push({ raw: ": heartbeat\n\n" })
    }
  }

  close(): void {
    for (const client of [...this.clients]) this.disconnect(client)
  }
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
      const snapshot = projectId
        ? await sync.refreshProject(projectId)
        : await sync.refresh()
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
