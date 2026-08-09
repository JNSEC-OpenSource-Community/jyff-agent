import { existsSync } from "node:fs"
import { join } from "node:path"
import type { AgentStreamEvent } from "@ctf-agent/core"
import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import type { App, AppEnv } from "../context.ts"
import { HttpError } from "../errors.ts"
import {
  fatherMessageSchema,
  fatherSessionCreateSchema,
  fatherValidationSchema,
  parseJsonBody,
} from "../schema.ts"
import type { Services } from "../services.ts"

/** 全局 Clanker Father 多 Session、实时对话与插件 Gate。 */
export function fatherRoutes(services: Services): App {
  const app = new Hono<AppEnv>()

  app.get("/father/sessions", (c) =>
    c.json({ sessions: services.requireFather().list() }),
  )

  app.post("/father/sessions", async (c) => {
    const body = await parseJsonBody(c, fatherSessionCreateSchema, {
      code: "invalid_father_session",
    })
    return c.json(
      await services.requireFather().create({
        ...body,
        createdBy: services.authentication?.snapshot().username ?? "local",
      }),
      201,
    )
  })

  app.get("/father/sessions/:sessionId/gate", async (c) => {
    const id = c.req.param("sessionId")
    const father = services.requireFather()
    const session = requireSession(services, id)
    if (!session.gate)
      throw new HttpError(
        409,
        "validation_not_requested",
        "Father 尚未请求验证",
      )
    const candidate = await services
      .requireExtensions()
      .describeCandidate(join(father.workspace(id), "output"))
    const saved = await services
      .requireFatherValidationConfigs()
      .read(id, candidate.schemaFingerprint)
    return c.json({
      candidate,
      saved: saved
        ? { config: saved.config, configuredSecrets: saved.configuredSecrets }
        : null,
    })
  })

  app.get("/father/sessions/:sessionId", (c) =>
    c.json(requireSession(services, c.req.param("sessionId"))),
  )

  app.get("/father/sessions/:sessionId/conversation", (c) => {
    const father = services.requireFather()
    const id = c.req.param("sessionId")
    requireSession(services, id)
    const path = father.sessionPath(id)
    return c.json(
      existsSync(path)
        ? services.exporters.readSessionConversation(path)
        : { messages: [] },
    )
  })

  app.post("/father/sessions/:sessionId/message", async (c) => {
    const body = await parseJsonBody(c, fatherMessageSchema, {
      code: "invalid_father_message",
      maximumSize: 40_000,
    })
    return c.json(
      await services
        .requireFather()
        .send(c.req.param("sessionId"), body.message),
    )
  })

  app.post("/father/sessions/:sessionId/stop", async (c) =>
    c.json(await services.requireFather().stop(c.req.param("sessionId"))),
  )

  app.post("/father/sessions/:sessionId/complete", async (c) =>
    c.json(await services.requireFather().complete(c.req.param("sessionId"))),
  )

  app.get("/father/sessions/:sessionId/events", (c) => {
    const father = services.requireFather()
    const id = c.req.param("sessionId")
    requireSession(services, id)
    c.header("Content-Type", "text/event-stream; charset=utf-8")
    c.header("Cache-Control", "no-cache, no-transform")
    c.header("Connection", "keep-alive")
    c.header("X-Accel-Buffering", "no")
    return streamSSE(c, async (stream) => {
      const queue = new AsyncEventQueue<
        AgentStreamEvent | { heartbeat: true }
      >()
      const heartbeat = setInterval(
        () => queue.push({ heartbeat: true }),
        15_000,
      )
      const unsubscribe = father.subscribe(id, (event) => queue.push(event))
      stream.onAbort(() => queue.close())
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
          } else {
            await stream.writeSSE({
              event: "agent_event",
              data: JSON.stringify(event),
              id: String(event.seq),
            })
          }
        }
      } finally {
        clearInterval(heartbeat)
        unsubscribe()
        queue.close()
      }
    })
  })

  app.post("/father/sessions/:sessionId/validate", async (c) => {
    const id = c.req.param("sessionId")
    const father = services.requireFather()
    requireSession(services, id)
    const body = await parseJsonBody(c, fatherValidationSchema, {
      code: "invalid_validation_profile",
      maximumSize: 80_000,
    })
    const candidateDirectory = join(father.workspace(id), "output")
    const candidate = await services
      .requireExtensions()
      .describeCandidate(candidateDirectory)
    const secretNames = candidate.setup.authStrategies.flatMap((strategy) =>
      strategy.secrets.map((secret) => secret.name),
    )
    const configs = services.requireFatherValidationConfigs()
    await configs.save({
      sessionId: id,
      schemaFingerprint: candidate.schemaFingerprint,
      config: body.config,
      secrets: body.secrets ?? {},
      secretNames,
    })
    const saved = await configs.read(id, candidate.schemaFingerprint)
    const requestedAt =
      father.get(id)?.gate?.requestedAt ?? new Date().toISOString()
    await father.setGateStatus(id, { status: "validating", requestedAt })
    const report = await services.requireExtensions().validate({
      sessionId: id,
      candidateDirectory,
      profile: {
        id: `father-${id}`,
        project: {
          id: `father-${candidate.pluginId}`,
          name: `${candidate.name} validation`,
        },
        config: body.config,
        secrets: saved?.secrets,
        expected: body.expected,
        mutations: body.mutations,
      },
    })
    await father.notifyValidation(id, report)
    return c.json(report)
  })

  app.post("/father/sessions/:sessionId/activate", async (c) => {
    const id = c.req.param("sessionId")
    const father = services.requireFather()
    requireSession(services, id)
    const extension = await services.requireExtensions().activate({
      sessionId: id,
      candidateDirectory: join(father.workspace(id), "output"),
    })
    const current = father.get(id)
    await father.setGateStatus(id, {
      status: "installed",
      requestedAt: current?.gate?.requestedAt ?? new Date().toISOString(),
      report: current?.gate?.report,
    })
    return c.json(extension)
  })

  app.get("/extensions", async (c) =>
    c.json({ extensions: await services.requireExtensions().list() }),
  )

  return app
}

function requireSession(services: Services, id: string) {
  const session = services.requireFather().get(id)
  if (!session) {
    throw new HttpError(
      404,
      "father_session_not_found",
      `Father Session 不存在: ${id}`,
    )
  }
  return session
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
    return item
      ? Promise.resolve(item)
      : this.closed
        ? Promise.resolve(undefined)
        : new Promise((resolve) => this.waiters.push(resolve))
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const waiter of this.waiters.splice(0)) waiter(undefined)
  }
}
