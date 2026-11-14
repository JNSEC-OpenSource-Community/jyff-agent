import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import { reportPage, shortSubagentPage } from "@ctf-agent/core"
import type { App, AppContext, AppEnv } from "../context.ts"
import { errorText, HttpError, hasCode } from "../errors.ts"
import { parseJsonBody, retryAttemptSchema, subagentMessageSchema } from "../schema.ts"
import type { Services } from "../services.ts"

/** Run/SubAgent 会话端点（全局 + 项目级复用，projectId 可选）。 */
export function runRoutes(services: Services): App {
  const app = new Hono<AppEnv>()

  const projectIdOf = (c: AppContext): string => {
    const scope = c.get("scope") as { projectId?: string } | undefined
    return scope?.projectId ?? ""
  }

  app.post("/runs/:runId/subagents/:subagentId/steer", async (c) => {
    const project = services.requireProject(projectIdOf(c))
    const body = await parseJsonBody(c, subagentMessageSchema, {
      code: "invalid_message",
    })
    try {
      return c.json(
        reportPage(
          await project.steerSubagent(
            c.req.param("runId"),
            c.req.param("subagentId"),
            body.message,
          ),
        ),
      )
    } catch (error) {
      if (hasCode(error, "subagent_unavailable")) {
        throw new HttpError(409, "subagent_unavailable", errorText(error))
      }
      throw error
    }
  })

  app.post("/runs/:runId/subagents/:subagentId/cancel", async (c) => {
    const project = services.requireProject(projectIdOf(c))
    try {
      return c.json(
        reportPage(await project.cancelSubagent(c.req.param("runId"), c.req.param("subagentId"))),
      )
    } catch (error) {
      if (hasCode(error, "subagent_unavailable")) {
        throw new HttpError(409, "subagent_unavailable", errorText(error))
      }
      throw error
    }
  })

  app.get("/runs/:runId/subagents", (c) => {
    const project = services.requireProject(projectIdOf(c))
    const runId = c.req.param("runId")
    if (!project.runs().some((run) => run.id === runId)) {
      throw new HttpError(404, "run_not_found", `Run 不存在: ${runId}`)
    }
    const limit = c.req.query("limit")
    try {
      const page = shortSubagentPage(runId, project.subagents(runId), {
        cursor: c.req.query("cursor"),
        ...(limit === undefined ? {} : { limit: Number(limit) }),
        budget: 15 * 1024,
      })
      return c.json({
        ...page,
        agents: page.agents.map((agent) => ({
          ...agent,
          hasConversation:
            agent.turns > 0 || agent.toolUses > 0 || agent.totalTokens > 0 || Boolean(agent.result),
        })),
      })
    } catch (error) {
      throw new HttpError(400, "invalid_subagent_page", errorText(error))
    }
  })

  app.get("/runs/:runId/subagents/:subagentId/result", (c) => {
    const project = services.requireProject(projectIdOf(c))
    const runId = c.req.param("runId")
    const subagentId = c.req.param("subagentId")
    requireRunAndSubagent(project, runId, subagentId)
    const record = project.subagents(runId).find(({ id }) => id === subagentId)
    if (!record) throw new HttpError(404, "subagent_not_found", `SubAgent 不存在: ${subagentId}`)
    const offset = c.req.query("offset")
    const limit = c.req.query("limit")
    try {
      return c.json(
        reportPage(record, {
          ...(offset === undefined ? {} : { offset: Number(offset) }),
          ...(limit === undefined ? {} : { limit: Number(limit) }),
          expectedResultVersion: c.req.query("expectedResultVersion"),
        }),
      )
    } catch (error) {
      throw new HttpError(400, "invalid_result_page", errorText(error))
    }
  })

  app.post("/runs/:runId/retry", async (c) => {
    const scheduler = services.requireSolverScheduler(projectIdOf(c))
    const body = await parseJsonBody(c, retryAttemptSchema, {
      code: "invalid_retry_prompt",
      maximumSize: 40_000,
    })
    await scheduler.retryAttempt(c.req.param("runId"), body.prompt ? { prompt: body.prompt } : {})
    return c.json(await scopedSnapshot(services, projectIdOf(c)))
  })

  app.get("/runs/:runId/subagents/:subagentId/export", async (c) => {
    const project = services.requireProject(projectIdOf(c))
    const runId = c.req.param("runId")
    const subagentId = c.req.param("subagentId")
    requireRunAndSubagent(project, runId, subagentId)
    const subagent = project.subagents(runId).find(({ id }) => id === subagentId)
    if (!subagent) {
      throw new HttpError(404, "subagent_not_found", `SubAgent 不存在: ${subagentId}`)
    }
    const body = await exportConversationHtml(subagent.sessionPath, undefined, services.exporters)
    return htmlResponse(body)
  })

  app.get("/runs/:runId/subagents/:subagentId/conversation", (c) => {
    const project = services.requireProject(projectIdOf(c))
    const runId = c.req.param("runId")
    const subagentId = c.req.param("subagentId")
    requireRunAndSubagent(project, runId, subagentId)
    const subagent = project.subagents(runId).find(({ id }) => id === subagentId)
    if (!subagent) {
      throw new HttpError(404, "subagent_not_found", `SubAgent 不存在: ${subagentId}`)
    }
    return c.json(readConversation(subagent.sessionPath, services.exporters))
  })

  app.get("/runs/:runId/subagents/:subagentId/events", (c) => {
    const project = services.requireProject(projectIdOf(c))
    const runId = c.req.param("runId")
    const subagentId = c.req.param("subagentId")
    requireRunAndSubagent(project, runId, subagentId)
    return agentEventStream(c, project, { runId, subagentId })
  })

  app.get("/runs/:runId/export", async (c) => {
    const project = services.requireProject(projectIdOf(c))
    const runId = c.req.param("runId")
    const run = project.runs().find((candidate) => candidate.id === runId)
    if (!run) {
      throw new HttpError(404, "run_not_found", `Run 不存在: ${runId}`)
    }
    const body = await exportConversationHtml(
      project.runSessionPath(run.id),
      await project.runSessionExportMetadata(run.id),
      services.exporters,
    )
    return htmlResponse(body)
  })

  app.get("/runs/:runId/conversation", (c) => {
    const project = services.requireProject(projectIdOf(c))
    const runId = c.req.param("runId")
    const run = project.runs().find((candidate) => candidate.id === runId)
    if (!run) {
      throw new HttpError(404, "run_not_found", `Run 不存在: ${runId}`)
    }
    return c.json(readConversation(project.runSessionPath(run.id), services.exporters))
  })

  app.get("/runs/:runId/events", (c) => {
    const project = services.requireProject(projectIdOf(c))
    const runId = c.req.param("runId")
    if (!project.runs().some((candidate) => candidate.id === runId)) {
      throw new HttpError(404, "run_not_found", `Run 不存在: ${runId}`)
    }
    return agentEventStream(c, project, { runId })
  })

  return app
}

function agentEventStream(
  c: AppContext,
  project: import("../../types.ts").DashboardProject,
  target: import("@ctf-agent/core").AgentStreamTarget,
): Response {
  c.header("Content-Type", "text/event-stream; charset=utf-8")
  c.header("Cache-Control", "no-cache, no-transform")
  c.header("Connection", "keep-alive")
  c.header("X-Accel-Buffering", "no")
  return streamSSE(c, async (stream) => {
    type QueueItem = import("@ctf-agent/core").AgentStreamEvent | { heartbeat: true }
    const queue = new AsyncEventQueue<QueueItem>()
    const heartbeat = setInterval(() => queue.push({ heartbeat: true }), 15_000)
    const unsubscribe = project.subscribeAgentStream(target, (event) => {
      queue.push(event)
    })
    stream.onAbort(() => {
      unsubscribe()
      queue.close()
    })
    try {
      await stream.write(": connected\n\n")
      await stream.writeSSE({
        event: "ready",
        data: JSON.stringify({ connectedAt: new Date().toISOString() }),
      })
      for (;;) {
        const event = await queue.next()
        if (!event) break
        if ("heartbeat" in event) {
          await stream.write(": heartbeat\n\n")
          continue
        }
        await stream.writeSSE({
          event: "agent_event",
          data: JSON.stringify(event),
          id: String(event.seq),
        })
      }
    } finally {
      clearInterval(heartbeat)
      unsubscribe()
      queue.close()
    }
  })
}

class AsyncEventQueue<T> {
  private readonly items: T[] = []
  private readonly waiters: Array<(item: T | undefined) => void> = []
  private closed = false

  push(item: T): void {
    if (this.closed) return
    const waiter = this.waiters.shift()
    if (waiter) waiter(item)
    else this.items.push(item)
  }

  next(): Promise<T | undefined> {
    const item = this.items.shift()
    if (item) return Promise.resolve(item)
    if (this.closed) return Promise.resolve(undefined)
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const waiter of this.waiters.splice(0)) waiter(undefined)
  }
}

function scopedSnapshot(
  services: Services,
  projectId: string,
): Promise<import("../../types.ts").DashboardSnapshot> {
  return projectId ? services.sync.refreshProject(projectId) : services.sync.refresh()
}

function requireRunAndSubagent(
  project: import("../../types.ts").DashboardProject,
  runId: string,
  subagentId: string,
): void {
  if (!project.runs().some((candidate) => candidate.id === runId)) {
    throw new HttpError(404, "run_not_found", `Run 不存在: ${runId}`)
  }
  if (!project.subagents(runId).some((candidate) => candidate.id === subagentId)) {
    throw new HttpError(404, "subagent_not_found", `SubAgent 不存在: ${subagentId}`)
  }
}

/** 导出 Pi 会话 HTML；会话尚未产生对话时 409。 */
async function exportConversationHtml(
  sessionPath: string,
  metadata: import("@ctf-agent/core").RunSessionExportMetadata | undefined,
  exporters: {
    exportSessionHtml: (
      sessionPath: string,
      metadata?: import("@ctf-agent/core").RunSessionExportMetadata,
    ) => Promise<Buffer>
    sessionHasConversation: (sessionPath: string) => Promise<boolean>
  },
): Promise<Buffer> {
  try {
    if (!(await exporters.sessionHasConversation(sessionPath))) {
      throw new HttpError(409, "session_not_ready", "该会话尚未产生 Agent 对话")
    }
    return await exporters.exportSessionHtml(sessionPath, metadata)
  } catch (error) {
    if (error instanceof HttpError) throw error
    throw new HttpError(409, "session_export_failed", `无法导出 Pi 会话: ${errorText(error)}`)
  }
}

/** 读取结构化会话对话；尚无 assistant 消息时 409。 */
function readConversation(
  sessionPath: string,
  exporters: {
    readSessionConversation: (sessionPath: string) => import("../../types.ts").DashboardConversation
  },
): import("../../types.ts").DashboardConversation {
  try {
    const conversation = exporters.readSessionConversation(sessionPath)
    if (!conversation.messages.some(({ message }) => message.role === "assistant")) {
      throw new HttpError(409, "session_not_ready", "该会话尚未产生 Agent 对话")
    }
    return conversation
  } catch (error) {
    if (error instanceof HttpError) throw error
    throw new HttpError(409, "session_read_failed", `无法读取 Pi 会话: ${errorText(error)}`)
  }
}

function htmlResponse(body: Buffer): Response {
  return new Response(new Uint8Array(body), {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  })
}
