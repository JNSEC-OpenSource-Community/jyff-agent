import { basename } from "node:path"
import { Hono } from "hono"
import { buildChallengeDetails } from "../../domain/view.ts"
import type { DashboardProject } from "../../types.ts"
import type { App, AppContext, AppEnv } from "../context.ts"
import { errorText, HttpError, hasCode } from "../errors.ts"
import {
  announcementReviewSchema,
  challengeMessageSchema,
  challengeSchedulingSchema,
  dispatchSchema,
  parseJsonBody,
  readJsonBody,
  thinkingLevelSchema,
} from "../schema.ts"
import type { Services } from "../services.ts"
import {
  WORKSPACE_PREVIEW_MAX_BYTES,
  workspacePreviewDescriptor,
} from "../workspace-files.ts"

/** 题目级路由：派发/取消、人工消息、思考强度、TLDR、writeup、详情。 */
export function challengeRoutes(services: Services): App {
  const app = new Hono<AppEnv>()

  const projectIdOf = (c: AppContext): string => {
    const scope = c.get("scope") as { projectId?: string } | undefined
    return scope?.projectId ?? ""
  }

  const refreshFor = (c: AppContext) => {
    const projectId = projectIdOf(c)
    return projectId
      ? services.sync.refreshProject(projectId)
      : services.sync.refresh()
  }

  app.post("/challenges/:challengeId/dispatch", async (c) => {
    const body = await parseJsonBody(c, dispatchSchema, {
      code: "invalid_dispatch",
    })
    const scheduler = services.requireSolverScheduler(projectIdOf(c))
    await scheduler.dispatch(c.req.param("challengeId"), {
      force: body.force === true,
    })
    return c.json(await refreshFor(c))
  })

  app.post("/challenges/:challengeId/cancel", async (c) => {
    await readJsonBody(c)
    await services
      .requireScheduler(projectIdOf(c))
      .cancel(c.req.param("challengeId"))
    return c.json(await refreshFor(c))
  })

  app.patch("/challenges/:challengeId/scheduling", async (c) => {
    const challengeId = c.req.param("challengeId")
    const project = services.requireProject(projectIdOf(c))
    const exists = (await project.challenges()).some(
      (challenge) => challenge.id === challengeId,
    )
    if (!exists) throw new HttpError(404, "challenge_not_found", "题目不存在")
    const body = await parseJsonBody(c, challengeSchedulingSchema, {
      code: "invalid_challenge_scheduling",
    })
    project.setChallengeSchedulingDisposition(
      challengeId,
      body.disposition === "default" ? null : body.disposition,
    )
    const scheduler = services.currentScheduler(projectIdOf(c))
    if (body.disposition === "default") await scheduler?.reconcile()
    else if (scheduler) await scheduler.cancel(challengeId)
    else project.removeSchedulerChallenge(challengeId)
    return c.json(await refreshFor(c))
  })

  // 题目级对话框：向该题当前活跃的 solver 发送人工消息（走 project，不走调度器）。
  app.post("/challenges/:challengeId/message", async (c) => {
    const project = services.requireProject(projectIdOf(c))
    const body = await parseJsonBody(c, challengeMessageSchema, {
      code: "invalid_message",
    })
    try {
      return c.json(
        await project.sendMessage(c.req.param("challengeId"), body.text),
      )
    } catch (error) {
      if (hasCode(error, "no_active_run")) {
        throw new HttpError(409, "no_active_run", "该题当前没有运行中的 Agent")
      }
      if (hasCode(error, "invalid_message")) {
        // 保留 project 侧原始错误文案，不掩盖真实校验错误
        throw new HttpError(
          400,
          "invalid_message",
          error instanceof Error && error.message
            ? error.message
            : "invalid_message",
        )
      }
      throw error
    }
  })

  // 运行中切换思考强度：向该题当前活跃的 solver 设置 thinkingLevel（下一 turn 生效）。
  app.post("/challenges/:challengeId/thinking-level", async (c) => {
    const project = services.requireProject(projectIdOf(c))
    const body = await parseJsonBody(c, thinkingLevelSchema, {
      code: "invalid_level",
    })
    try {
      return c.json(
        await project.setThinkingLevel(c.req.param("challengeId"), body.level),
      )
    } catch (error) {
      if (hasCode(error, "no_active_run")) {
        throw new HttpError(409, "no_active_run", "该题当前没有运行中的 Agent")
      }
      if (hasCode(error, "invalid_level")) {
        throw new HttpError(400, "invalid_level", "不支持的思考强度")
      }
      throw error
    }
  })

  app.post("/challenges/:challengeId/tldr/refresh", async (c) => {
    const project = services.requireProject(projectIdOf(c))
    const modelConfiguration = services.modelConfiguration
    const bindings = services.runtime(projectIdOf(c))?.snapshot()
    const modelSnapshot = modelConfiguration?.snapshot(bindings)
    const tldrModelId =
      modelSnapshot?.tldrModelId || modelSnapshot?.solverModelId
    const tldrModel = modelSnapshot?.models.find(
      (model) => model.id === tldrModelId,
    )
    if (!modelConfiguration || !tldrModel?.configured) {
      throw new HttpError(
        503,
        "model_unavailable",
        tldrModel?.unavailableReason ?? "TLDR 模型尚未配置",
      )
    }
    const challengeId = c.req.param("challengeId")
    const tldr = await project.refreshTldr(
      challengeId,
      modelConfiguration.createAgentOptions("tldr", bindings),
    )
    if (tldr.challengeId !== challengeId) {
      throw new HttpError(404, "challenge_not_found", "题目不存在")
    }
    return c.json({ tldr })
  })

  app.get("/challenges/:challengeId/tldr", (c) => {
    const project = services.requireProject(projectIdOf(c))
    return c.json({ tldr: project.tldr(c.req.param("challengeId")) ?? null })
  })

  app.get("/challenges/:challengeId/writeup", async (c) => {
    const project = services.requireProject(projectIdOf(c))
    const challengeId = c.req.param("challengeId")
    const writeup = await project.challengeWriteup(challengeId)
    if (!writeup.validation.valid || !writeup.content) {
      return c.json(
        { error: "writeup_unavailable", validation: writeup.validation },
        409,
      )
    }
    c.header("Content-Type", "text/markdown; charset=utf-8")
    c.header(
      "Content-Disposition",
      `attachment; filename="writeup-${filenameSafe(challengeId)}.md"`,
    )
    c.header("Cache-Control", "no-store")
    return c.body(Buffer.from(writeup.content, "utf8"))
  })

  app.get("/challenges/:challengeId/files", async (c) => {
    const project = services.requireProject(projectIdOf(c))
    const listing = await project.challengeWorkspaceFiles(
      c.req.param("challengeId"),
    )
    c.header("Cache-Control", "no-store")
    return c.json({
      ...listing,
      files: listing.files.map((file) => ({
        ...file,
        preview: workspacePreviewDescriptor(file.path),
      })),
    })
  })

  app.get("/challenges/:challengeId/files/preview", async (c) => {
    const artifactPath = c.req.query("path")
    if (!artifactPath) {
      throw new HttpError(400, "invalid_workspace_path", "缺少文件路径")
    }
    const preview = workspacePreviewDescriptor(artifactPath)
    if (!preview) {
      throw new HttpError(
        415,
        "workspace_preview_unsupported",
        "该文件类型不支持预览",
      )
    }
    const project = services.requireProject(projectIdOf(c))
    const listing = await project.challengeWorkspaceFiles(
      c.req.param("challengeId"),
    )
    const file = listing.files.find(
      (candidate) => candidate.path === artifactPath,
    )
    if (!file) {
      throw new HttpError(404, "workspace_file_not_found", "文件不存在")
    }
    if (file.size > WORKSPACE_PREVIEW_MAX_BYTES) {
      throw new HttpError(
        413,
        "workspace_preview_too_large",
        "文件超过 256 KiB，无法在线预览",
      )
    }
    const content = await readWorkspaceFile(
      project,
      c.req.param("challengeId"),
      artifactPath,
    )
    if (content.byteLength > WORKSPACE_PREVIEW_MAX_BYTES) {
      throw new HttpError(
        413,
        "workspace_preview_too_large",
        "文件超过 256 KiB，无法在线预览",
      )
    }
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

  app.get("/challenges/:challengeId/files/download", async (c) => {
    const artifactPath = c.req.query("path")
    if (!artifactPath) {
      throw new HttpError(400, "invalid_workspace_path", "缺少文件路径")
    }
    const project = services.requireProject(projectIdOf(c))
    const content = await readWorkspaceFile(
      project,
      c.req.param("challengeId"),
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

  // 公告审核：与题目绑定，全局与项目级均可用。
  app.post("/announcements/review", async (c) => {
    const project = services.requireProject(projectIdOf(c))
    const body = await parseJsonBody(c, announcementReviewSchema, {
      code: "invalid_announcement_review",
    })
    try {
      await project.reviewChallengeAnnouncement(
        body.challengeId,
        body.announcementKey,
        body.status,
      )
    } catch (error) {
      if (hasCode(error, "announcement_candidate_not_found")) {
        throw new HttpError(
          404,
          "announcement_candidate_not_found",
          errorText(error),
        )
      }
      throw error
    }
    return c.json(await refreshFor(c))
  })

  // 详情兜底：/challenges/<id> 以及旧版带任意后缀的路径都按题目 ID 解析。
  app.get("/challenges/*", async (c) => {
    const project = services.requireProject(projectIdOf(c))
    const challengeId = challengeIdFromPath(c.req.path)
    const details = await buildChallengeDetails(
      project,
      challengeId,
      services.currentScheduler(projectIdOf(c)),
      // 全局模式下确保先完成一次真实构建（latestSnapshot 可能仍是空占位）
      projectIdOf(c) ? undefined : await services.sync.refresh(),
    )
    if (!details) {
      throw new HttpError(404, "challenge_not_found", "题目不存在")
    }
    return c.json({
      ...details,
      solverAvailable: services.canStartSolver(projectIdOf(c)),
    })
  })

  return app
}

/** 从完整路径提取 /challenges/ 之后的剩余部分（兼容全局与项目级两种挂载形态）。 */
function challengeIdFromPath(path: string): string {
  const marker = "/challenges/"
  const index = path.lastIndexOf(marker)
  return index < 0 ? "" : path.slice(index + marker.length)
}

/** Content-Disposition filename 段白名单清洗：平台/run 数据不可信，防 header 注入。 */
function filenameSafe(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64)
}

async function readWorkspaceFile(
  project: DashboardProject,
  challengeId: string,
  artifactPath: string,
): Promise<Uint8Array> {
  try {
    return await project.challengeWorkspaceFile(challengeId, artifactPath)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT") {
      throw new HttpError(404, "workspace_file_not_found", "文件不存在")
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
