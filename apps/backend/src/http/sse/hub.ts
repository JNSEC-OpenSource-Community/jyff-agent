/**
 * SSE 客户端注册表：hub + 每连接串行队列。
 *
 * 每个连接拥有独立的串行消息队列：广播只做同步入队，实际写入由该连接
 * 唯一的消费循环执行，因此任意时刻不会有两个写者竞争同一个 socket。
 */
import type { SseMessage } from "./events.ts"

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

  broadcast(event: string, data: string, id?: string, projectId?: string): void {
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
    for (const client of this.clients) this.disconnect(client)
  }
}
