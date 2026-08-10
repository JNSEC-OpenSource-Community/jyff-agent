import { existsSync } from "node:fs"
import { basename, join } from "node:path"
import {
  type AgentStreamEvent,
  listWorkspaceArtifacts,
  readWorkspaceArtifact,
} from "@ctf-agent/core"
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
import {
  WORKSPACE_PREVIEW_MAX_BYTES,
  workspacePreviewDescriptor,
} from "../workspace-files.ts"

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

  app.get("/father/sessions/:sessionId/export", async (c) => {
    const father = services.requireFather()
    const id = c.req.param("sessionId")
    requireSession(services, id)
    const path = father.sessionPath(id)
    if (!(await services.exporters.sessionHasConversation(path))) {
      throw new HttpError(409, "session_not_ready", "该会话尚未产生 Agent 对话")
    }
    const body = await services.exporters.exportSessionHtml(path)
    return new Response(new Uint8Array(body), {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    })
  })

  app.get("/father/sessions/:sessionId/plugin.ts", async (c) => {
    const father = services.requireFather()
    const id = c.req.param("sessionId")
    requireSession(services, id)
    const source = await services
      .requireExtensions()
      .readCandidateEntry(join(father.workspace(id), "output"))
    c.header("Content-Type", "text/typescript; charset=utf-8")
    c.header(
      "Content-Disposition",
      `attachment; filename="${source.filename.replaceAll('"', "")}"`,
    )
    c.header("Cache-Control", "no-store")
    return c.body(new Uint8Array(source.content))
  })

  app.get("/father/sessions/:sessionId/workspace/files", async (c) => {
    const father = services.requireFather()
    const id = c.req.param("sessionId")
    requireSession(services, id)
    const listing = await listWorkspaceArtifacts(father.workspace(id))
    c.header("Cache-Control", "no-store")
    return c.json({
      ...listing,
      files: listing.files.map((file) => ({
        ...file,
        preview: workspacePreviewDescriptor(file.path),
      })),
    })
  })

  app.get("/father/sessions/:sessionId/workspace/files/preview", async (c) => {
    const father = services.requireFather()
    const id = c.req.param("sessionId")
    requireSession(services, id)
    const artifactPath = c.req.query("path")
    if (!artifactPath)
      throw new HttpError(400, "invalid_workspace_path", "缺少文件路径")
    const preview = workspacePreviewDescriptor(artifactPath)
    if (!preview) {
      throw new HttpError(
        415,
        "workspace_preview_unsupported",
        "该文件类型不支持预览",
      )
    }
    const content = await readFatherWorkspaceFile(
      father.workspace(id),
      artifactPath,
      WORKSPACE_PREVIEW_MAX_BYTES,
    )
    let text: string
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(content)
    } catch {
      throw new HttpError(
        415,
        "workspace_preview_invalid_text",
        "文件不是有效的 UTF-8 文本",
      )
    }
    c.header("Cache-Control", "no-store")
    return c.json({
      path: artifactPath,
      size: content.byteLength,
      content: text,
      ...preview,
    })
  })

  app.get("/father/sessions/:sessionId/workspace/files/download", async (c) => {
    const father = services.requireFather()
    const id = c.req.param("sessionId")
    requireSession(services, id)
    const artifactPath = c.req.query("path")
    if (!artifactPath)
      throw new HttpError(400, "invalid_workspace_path", "缺少文件路径")
    const content = await readFatherWorkspaceFile(
      father.workspace(id),
      artifactPath,
    )
    const name = basename(artifactPath)
    c.header("Content-Type", "application/octet-stream")
    c.header(
      "Content-Disposition",
      `attachment; filename="${filenameSafe(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    )
    c.header("Content-Length", String(content.byteLength))
    c.header("Cache-Control", "no-store")
    return c.body(Buffer.from(content))
  })

  app.delete("/father/sessions/:sessionId", async (c) => {
    const father = services.requireFather()
    const id = c.req.param("sessionId")
    requireSession(services, id)
    await services.requireFatherValidationConfigs().delete(id)
    await services.extensions?.deleteValidationReport(id)
    await father.delete(id)
    return c.json({ deleted: true })
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
    if (body.schemaFingerprint !== candidate.schemaFingerprint) {
      throw new HttpError(
        409,
        "father_validation_schema_changed",
        "插件配置字段已经变化，请刷新后重新确认",
      )
    }
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
    const current = requireSession(services, id)
    if (current.gate?.status !== "ready" || !current.gate.report) {
      throw new HttpError(
        409,
        "father_validation_not_ready",
        "候选插件尚未通过 Validation Gate",
      )
    }
    const extension = await services.requireExtensions().activate({
      sessionId: id,
      candidateDirectory: join(father.workspace(id), "output"),
      validationReport: current.gate.report,
    })
    await father.setGateStatus(id, {
      status: "installed",
      requestedAt: current.gate.requestedAt,
      report: current.gate.report,
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

async function readFatherWorkspaceFile(
  workspace: string,
  artifactPath: string,
  maximumBytes?: number,
): Promise<Uint8Array> {
  try {
    return await readWorkspaceArtifact(workspace, artifactPath, maximumBytes)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT")
      throw new HttpError(404, "workspace_file_not_found", "文件不存在")
    if (error instanceof Error && error.message.includes("exceeds")) {
      throw new HttpError(
        413,
        "workspace_preview_too_large",
        "文件超过 256 KiB，无法在线预览",
      )
    }
    if (
      error instanceof Error &&
      (error.message.includes("Workspace artifact") || code === "EISDIR")
    ) {
      throw new HttpError(400, "invalid_workspace_path", error.message)
    }
    throw error
  }
}

function filenameSafe(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64)
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
