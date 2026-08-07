import { Hono } from "hono"
import { errorText, HttpError, hasCode } from "../http/errors.ts"
import type { Services } from "../http/services.ts"
import type { App, AppContext, AppEnv } from "../http/types.ts"
import {
  announcementReviewSchema,
  challengeMessageSchema,
  dispatchSchema,
  parseJsonBody,
  readJsonBody,
  thinkingLevelSchema,
} from "../http/validation.ts"
import { buildChallengeDetails } from "../model.ts"

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
    const scheduler = services.requireScheduler(projectIdOf(c))
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
    return c.json(details)
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
