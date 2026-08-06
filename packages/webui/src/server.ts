import { readFile } from "node:fs/promises"
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http"
import type { AddressInfo } from "node:net"
import {
  ContestSchedulerError,
  type ProjectConfig,
  parseProjectConfig,
  type RunSessionExportMetadata,
} from "@ctf-agent/core"
import {
  buildChallengeDetails,
  buildDashboardSnapshot,
  buildEmptyDashboardSnapshot,
} from "./model.ts"
import { exportPiSessionHtml } from "./pi-html-export.ts"
import type {
  DashboardControlPlane,
  DashboardModelAuthentication,
  DashboardModelConfiguration,
  DashboardProject,
  DashboardScheduler,
  DashboardSnapshot,
  ModelConfigurationUpdate,
} from "./types.ts"

export interface WebUiOptions {
  project?: DashboardProject
  controlPlane?: DashboardControlPlane
  host?: string
  port?: number
  pollIntervalMs?: number
  scheduler?: DashboardScheduler
  schedulerReconcileIntervalMs?: number
  modelConfiguration?: DashboardModelConfiguration
  modelAuthentication?: DashboardModelAuthentication
  /** 测试可替换 Pi 原生 HTML session 导出器。 */
  exportSessionHtml?: (
    sessionPath: string,
    metadata?: RunSessionExportMetadata,
  ) => Promise<Buffer>
}

export interface WebUiServer {
  readonly host: string
  readonly port: number
  readonly url: string
  refresh(): Promise<DashboardSnapshot>
  close(): Promise<void>
}

interface StaticAsset {
  content: Buffer
  contentType: string
}

interface DashboardSyncHealth {
  status: "ok" | "degraded"
  consecutiveFailures: number
  lastAttemptAt: string
  lastSuccessAt: string | null
  lastError: string | null
}

const STATIC_ASSETS = new Map<string, { file: URL; contentType: string }>([
  [
    "/",
    {
      file: new URL("./client/index.html", import.meta.url),
      contentType: "text/html; charset=utf-8",
    },
  ],
  [
    "/app.js",
    {
      file: new URL("./client/app.js", import.meta.url),
      contentType: "text/javascript; charset=utf-8",
    },
  ],
  [
    "/styles.css",
    {
      file: new URL("./client/styles.css", import.meta.url),
      contentType: "text/css; charset=utf-8",
    },
  ],
])

export async function startWebUi(options: WebUiOptions): Promise<WebUiServer> {
  if (!options.project && !options.controlPlane) {
    throw new Error("WebUI 至少需要 project 或 controlPlane")
  }
  const host = options.host ?? "127.0.0.1"
  const requestedPort = options.port ?? 3000
  const pollIntervalMs = Math.max(250, options.pollIntervalMs ?? 1_000)
  const clients = new Set<ServerResponse>()
  const assets = await loadStaticAssets()
  const currentProject = (): DashboardProject | undefined =>
    options.controlPlane?.currentProject() ?? options.project
  const currentScheduler = (): DashboardScheduler | undefined =>
    options.controlPlane?.currentScheduler() ?? options.scheduler
  const exportSessionHtml = options.exportSessionHtml ?? exportPiSessionHtml
  const buildCurrentSnapshot = async (): Promise<DashboardSnapshot> => {
    const project = currentProject()
    if (project) {
      return await buildDashboardSnapshot(
        project,
        currentScheduler(),
        options.controlPlane,
      )
    }
    if (options.controlPlane) {
      return buildEmptyDashboardSnapshot(options.controlPlane)
    }
    throw new Error("WebUI 当前没有可用的 project")
  }
  const initialAttemptAt = new Date().toISOString()
  let syncHealth: DashboardSyncHealth
  let latestSnapshot: DashboardSnapshot
  try {
    latestSnapshot = await buildCurrentSnapshot()
    syncHealth = {
      status: "ok",
      consecutiveFailures: 0,
      lastAttemptAt: initialAttemptAt,
      lastSuccessAt: latestSnapshot.generatedAt,
      lastError: null,
    }
  } catch (error) {
    if (!options.controlPlane) throw error
    const message = errorText(error)
    latestSnapshot = buildEmptyDashboardSnapshot(options.controlPlane)
    syncHealth = {
      status: "degraded",
      consecutiveFailures: 1,
      lastAttemptAt: initialAttemptAt,
      lastSuccessAt: null,
      lastError: message,
    }
    console.warn(`[webui] 初始平台同步失败，将在后台恢复：${message}`)
  }
  let serializedSnapshot = JSON.stringify(latestSnapshot)
  let snapshotFingerprint = fingerprint(latestSnapshot)
  let pendingRefresh: Promise<DashboardSnapshot> | undefined

  const markSyncSuccess = (snapshot: DashboardSnapshot): void => {
    const recovered = syncHealth.status === "degraded"
    syncHealth = {
      status: "ok",
      consecutiveFailures: 0,
      lastAttemptAt: snapshot.generatedAt,
      lastSuccessAt: snapshot.generatedAt,
      lastError: null,
    }
    if (recovered) {
      console.info("[webui] 平台同步已恢复")
      broadcast(clients, "dashboard_recovered", JSON.stringify(syncHealth))
    }
  }

  const markSyncFailure = (error: unknown, source: string): void => {
    const message = errorText(error)
    syncHealth = {
      status: "degraded",
      consecutiveFailures: syncHealth.consecutiveFailures + 1,
      lastAttemptAt: new Date().toISOString(),
      lastSuccessAt: syncHealth.lastSuccessAt,
      lastError: message,
    }
    console.warn(
      `[webui] ${source}失败（连续 ${syncHealth.consecutiveFailures} 次）：${message}`,
    )
    broadcast(
      clients,
      "dashboard_error",
      JSON.stringify({ message, ...syncHealth }),
    )
  }

  const refresh = async (): Promise<DashboardSnapshot> => {
    if (pendingRefresh) return pendingRefresh
    pendingRefresh = buildCurrentSnapshot()
      .then((snapshot) => {
        markSyncSuccess(snapshot)
        const serialized = JSON.stringify(snapshot)
        const nextFingerprint = fingerprint(snapshot)
        latestSnapshot = snapshot
        if (nextFingerprint !== snapshotFingerprint) {
          snapshotFingerprint = nextFingerprint
          serializedSnapshot = serialized
          broadcast(clients, "snapshot", serialized, snapshot.generatedAt)
        }
        return snapshot
      })
      .catch((error: unknown) => {
        markSyncFailure(error, "平台快照同步")
        throw error
      })
      .finally(() => {
        pendingRefresh = undefined
      })
    return pendingRefresh
  }

  const server = createServer((request, response) => {
    void handleRequest(request, response).catch((error: unknown) => {
      if (response.headersSent) {
        response.end()
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      if (error instanceof ContestSchedulerError) {
        const status =
          error.code === "challenge_not_found"
            ? 404
            : error.code === "unavailable"
              ? 503
              : 409
        sendJson(response, status, { error: error.code, message })
        return
      }
      if (error instanceof HttpRequestError) {
        sendJson(response, error.status, { error: error.code, message })
        return
      }
      sendJson(response, 500, { error: "internal_error", message })
    })
  })

  async function handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const method = request.method ?? "GET"
    const url = new URL(request.url ?? "/", "http://localhost")

    if (method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, {
        status: "ok",
        generatedAt: latestSnapshot.generatedAt,
        connectedClients: clients.size,
        platformSync: { ...syncHealth },
        controlPlane: options.controlPlane?.snapshot() ?? null,
        scheduler: currentScheduler()?.snapshot() ?? null,
        modelConfiguration: options.modelConfiguration?.snapshot() ?? null,
        modelAuthentication:
          (await options.modelAuthentication?.snapshot()) ?? null,
      })
      return
    }

    if (method === "GET" && url.pathname === "/api/control-plane") {
      requireControlPlane(options.controlPlane)
      sendJson(response, 200, options.controlPlane.setupSnapshot())
      return
    }

    if (method === "POST" && url.pathname === "/api/control-plane/test") {
      requireControlPlane(options.controlPlane)
      requireJsonRequest(request)
      const input = controlPlaneSetup(await readJsonBody(request))
      try {
        sendJson(
          response,
          200,
          await options.controlPlane.testConnection(input),
        )
      } catch (error) {
        throw new HttpRequestError(
          422,
          "platform_connection_failed",
          errorText(error),
        )
      }
      return
    }

    if (method === "POST" && url.pathname === "/api/control-plane/apply") {
      requireControlPlane(options.controlPlane)
      requireJsonRequest(request)
      const input = controlPlaneSetup(await readJsonBody(request))
      try {
        await options.controlPlane.applySetup(input)
      } catch (error) {
        throw new HttpRequestError(
          422,
          "platform_setup_failed",
          errorText(error),
        )
      }
      sendJson(response, 200, {
        setup: options.controlPlane.setupSnapshot(),
        snapshot: await refresh(),
      })
      return
    }

    if (method === "POST" && url.pathname === "/api/control-plane/connect") {
      requireControlPlane(options.controlPlane)
      requireJsonRequest(request)
      try {
        await options.controlPlane.connect()
      } catch (error) {
        throw new HttpRequestError(
          503,
          "platform_connection_failed",
          errorText(error),
        )
      }
      sendJson(response, 200, await refresh())
      return
    }

    if (method === "GET" && url.pathname === "/api/snapshot") {
      sendJson(response, 200, await refresh())
      return
    }

    if (method === "POST" && url.pathname === "/api/refresh") {
      requireJsonRequest(request)
      const project = currentProject()
      if (project) await project.refresh()
      await currentScheduler()?.reconcile()
      sendJson(response, 200, await refresh())
      return
    }

    if (method === "GET" && url.pathname === "/api/model-config") {
      requireModelConfiguration(options.modelConfiguration)
      sendJson(response, 200, options.modelConfiguration.snapshot())
      return
    }

    if (method === "POST" && url.pathname === "/api/model-config") {
      requireModelConfiguration(options.modelConfiguration)
      requireJsonRequest(request)
      const configuration = await options.modelConfiguration.update(
        modelConfigurationUpdate(await readJsonBody(request)),
      )
      const scheduler = currentScheduler()
      if (!configuration.configured) scheduler?.pauseAuto()
      else await scheduler?.reconcile()
      sendJson(response, 200, {
        configuration,
        snapshot: await refresh(),
      })
      return
    }

    if (method === "GET" && url.pathname === "/api/model-auth") {
      requireModelAuthentication(options.modelAuthentication)
      sendJson(response, 200, await options.modelAuthentication.snapshot())
      return
    }

    if (method === "POST" && url.pathname === "/api/model-auth/login") {
      requireModelAuthentication(options.modelAuthentication)
      const authentication = options.modelAuthentication
      requireJsonRequest(request)
      const body = await readJsonBody(request)
      const provider = requiredString(
        body.provider,
        "Provider",
        128,
        "invalid_model_authentication",
      )
      const methodId = requiredString(
        body.method,
        "登录方式",
        128,
        "invalid_model_authentication",
      )
      const secret =
        body.secret === undefined
          ? undefined
          : optionalString(
              body.secret,
              "凭据",
              16_384,
              "invalid_model_authentication",
            )
      sendJson(
        response,
        202,
        await modelAuthenticationAction(() =>
          authentication.startLogin({
            provider,
            method: methodId,
            ...(secret ? { secret } : {}),
          }),
        ),
      )
      return
    }

    const loginSession = /^\/api\/model-auth\/login\/([^/]+)$/.exec(
      url.pathname,
    )
    if (method === "GET" && loginSession) {
      requireModelAuthentication(options.modelAuthentication)
      const authentication = options.modelAuthentication
      const session = await modelAuthenticationAction(() =>
        Promise.resolve(
          authentication.loginSession(
            decodeURIComponent(loginSession[1] ?? ""),
          ),
        ),
      )
      if (session.status === "success") {
        await reconcileModelAvailability(
          options.modelConfiguration,
          currentScheduler(),
        )
      }
      sendJson(response, 200, session)
      return
    }

    const loginAction =
      /^\/api\/model-auth\/login\/([^/]+)\/(prompt|cancel)$/.exec(url.pathname)
    if (method === "POST" && loginAction) {
      requireModelAuthentication(options.modelAuthentication)
      const authentication = options.modelAuthentication
      requireJsonRequest(request)
      const sessionId = decodeURIComponent(loginAction[1] ?? "")
      if (loginAction[2] === "prompt") {
        const body = await readJsonBody(request)
        const value = requiredString(
          body.value,
          "登录输入",
          16_384,
          "invalid_model_authentication",
        )
        sendJson(
          response,
          200,
          await modelAuthenticationAction(() =>
            Promise.resolve(authentication.submitPrompt(sessionId, value)),
          ),
        )
      } else {
        await readJsonBody(request)
        sendJson(
          response,
          200,
          await modelAuthenticationAction(() =>
            Promise.resolve(authentication.cancelLogin(sessionId)),
          ),
        )
      }
      return
    }

    const modelLogout = /^\/api\/model-auth\/providers\/([^/]+)\/logout$/.exec(
      url.pathname,
    )
    if (method === "POST" && modelLogout) {
      requireModelAuthentication(options.modelAuthentication)
      const modelAuthentication = options.modelAuthentication
      requireJsonRequest(request)
      await readJsonBody(request)
      const authentication = await modelAuthenticationAction(() =>
        modelAuthentication.logout(decodeURIComponent(modelLogout[1] ?? "")),
      )
      const configuration = await reconcileModelAvailability(
        options.modelConfiguration,
        currentScheduler(),
      )
      sendJson(response, 200, {
        authentication,
        configuration,
        snapshot: await refresh(),
      })
      return
    }

    if (method === "POST" && url.pathname === "/api/model-auth/import") {
      requireModelAuthentication(options.modelAuthentication)
      const authentication = options.modelAuthentication
      requireJsonRequest(request)
      const body = await readJsonBody(request, 262_144)
      const raw = requiredString(
        body.json,
        "auth.json",
        250_000,
        "invalid_model_authentication",
      )
      const imported = await modelAuthenticationAction(() =>
        authentication.importJson(raw),
      )
      const configuration = await reconcileModelAvailability(
        options.modelConfiguration,
        currentScheduler(),
      )
      sendJson(response, 200, {
        imported,
        authentication: await authentication.snapshot(),
        configuration,
        snapshot: await refresh(),
      })
      return
    }

    if (method === "POST" && url.pathname === "/api/model-auth/import-file") {
      requireModelAuthentication(options.modelAuthentication)
      const authentication = options.modelAuthentication
      requireJsonRequest(request)
      await readJsonBody(request)
      const imported = await modelAuthenticationAction(() =>
        authentication.importFile(),
      )
      const configuration = await reconcileModelAvailability(
        options.modelConfiguration,
        currentScheduler(),
      )
      sendJson(response, 200, {
        imported,
        authentication: await authentication.snapshot(),
        configuration,
        snapshot: await refresh(),
      })
      return
    }

    if (method === "POST" && url.pathname === "/api/scheduler/auto/start") {
      const scheduler = currentScheduler()
      requireScheduler(scheduler)
      requireJsonRequest(request)
      await scheduler.startAuto()
      sendJson(response, 200, await refresh())
      return
    }

    if (method === "POST" && url.pathname === "/api/scheduler/auto/pause") {
      const scheduler = currentScheduler()
      requireScheduler(scheduler)
      requireJsonRequest(request)
      scheduler.pauseAuto()
      sendJson(response, 200, await refresh())
      return
    }

    if (method === "POST" && url.pathname === "/api/scheduler/concurrency") {
      const scheduler = currentScheduler()
      requireScheduler(scheduler)
      requireJsonRequest(request)
      const body = await readJsonBody(request)
      const maxConcurrent = requiredPositiveInteger(
        body.maxConcurrent,
        "调度并发量",
        64,
        "invalid_scheduler_configuration",
      )
      await scheduler.setMaxConcurrent(maxConcurrent)
      sendJson(response, 200, await refresh())
      return
    }

    const queueMove = /^\/api\/scheduler\/queue\/([^/]+)$/.exec(url.pathname)
    if (method === "PATCH" && queueMove) {
      const scheduler = currentScheduler()
      requireScheduler(scheduler)
      requireJsonRequest(request)
      const challengeId = decodeURIComponent(queueMove[1] ?? "")
      const body = await readJsonBody(request)
      scheduler.reorderQueue(challengeId, {
        position: requiredPositiveInteger(
          body.position,
          "队列位置",
          Number.MAX_SAFE_INTEGER,
          "invalid_queue_position",
        ),
        expectedVersion: requiredPositiveInteger(
          body.expectedVersion,
          "队列版本",
          Number.MAX_SAFE_INTEGER,
          "invalid_queue_version",
        ),
        overrideBlockedLane: body.overrideBlockedLane === true,
      })
      sendJson(response, 200, await refresh())
      return
    }

    const action = /^\/api\/challenges\/([^/]+)\/(dispatch|cancel)$/.exec(
      url.pathname,
    )
    if (method === "POST" && action) {
      const scheduler = currentScheduler()
      requireScheduler(scheduler)
      requireJsonRequest(request)
      const challengeId = decodeURIComponent(action[1] ?? "")
      if (action[2] === "dispatch") {
        const body = await readJsonBody(request)
        await scheduler.dispatch(challengeId, {
          force: body.force === true,
        })
      } else {
        await scheduler.cancel(challengeId)
      }
      sendJson(response, 200, await refresh())
      return
    }

    // 题目级对话框:向该题当前活跃的 solver 发送人工消息(走 project,不走调度器)
    const message = /^\/api\/challenges\/([^/]+)\/message$/.exec(url.pathname)
    if (method === "POST" && message) {
      const project = currentProject()
      requireProject(project)
      requireJsonRequest(request)
      const challengeId = decodeURIComponent(message[1] ?? "")
      const body = await readJsonBody(request)
      const text = requiredString(body.text, "Text", 4_000, "invalid_message")
      try {
        sendJson(response, 200, await project.sendMessage(challengeId, text))
      } catch (error) {
        if (hasCode(error, "no_active_run")) {
          throw new HttpRequestError(
            409,
            "no_active_run",
            "该题当前没有运行中的 Agent",
          )
        }
        if (hasCode(error, "invalid_message")) {
          // 保留 project 侧原始错误文案,不掩盖真实校验错误(requiredString 已在上游拦截)
          throw new HttpRequestError(
            400,
            "invalid_message",
            error instanceof Error && error.message
              ? error.message
              : "invalid_message",
          )
        }
        throw error
      }
      return
    }

    // 运行中切换思考强度:向该题当前活跃的 solver 设置 thinkingLevel(下一 turn 生效)
    const thinkingLevel = /^\/api\/challenges\/([^/]+)\/thinking-level$/.exec(
      url.pathname,
    )
    if (method === "POST" && thinkingLevel) {
      const project = currentProject()
      requireProject(project)
      requireJsonRequest(request)
      const challengeId = decodeURIComponent(thinkingLevel[1] ?? "")
      const body = await readJsonBody(request)
      const level = requiredString(body.level, "Level", 32, "invalid_level")
      if (!THINKING_LEVELS.has(level) && level !== "off") {
        throw new HttpRequestError(
          400,
          "invalid_level",
          `思考强度必须是 ${[...THINKING_LEVELS, "off"].join("/")} 之一`,
        )
      }
      try {
        sendJson(
          response,
          200,
          await project.setThinkingLevel(challengeId, level),
        )
      } catch (error) {
        if (hasCode(error, "no_active_run")) {
          throw new HttpRequestError(
            409,
            "no_active_run",
            "该题当前没有运行中的 Agent",
          )
        }
        if (hasCode(error, "invalid_level")) {
          throw new HttpRequestError(400, "invalid_level", "不支持的思考强度")
        }
        throw error
      }
      return
    }

    const subagentAction =
      /^\/api\/runs\/([^/]+)\/subagents\/([^/]+)\/(steer|cancel)$/.exec(
        url.pathname,
      )
    if (method === "POST" && subagentAction) {
      const project = currentProject()
      requireProject(project)
      requireJsonRequest(request)
      const runId = decodeURIComponent(subagentAction[1] ?? "")
      const subagentId = decodeURIComponent(subagentAction[2] ?? "")
      try {
        if (subagentAction[3] === "steer") {
          const body = await readJsonBody(request)
          const message = requiredString(
            body.message,
            "Message",
            4_000,
            "invalid_message",
          )
          sendJson(
            response,
            200,
            await project.steerSubagent(runId, subagentId, message),
          )
        } else {
          sendJson(
            response,
            200,
            await project.cancelSubagent(runId, subagentId),
          )
        }
      } catch (error) {
        if (hasCode(error, "subagent_unavailable")) {
          throw new HttpRequestError(
            409,
            "subagent_unavailable",
            errorText(error),
          )
        }
        throw error
      }
      return
    }

    // HTML session 导出必须在 /api/challenges/ 详情分支之前，否则路径会被吞。
    const exportMatch = /^\/api\/challenges\/([^/]+)\/export$/.exec(
      url.pathname,
    )
    if (method === "GET" && exportMatch) {
      const project = currentProject()
      requireProject(project)
      const challengeId = decodeURIComponent(exportMatch[1] ?? "")
      const runs = project.runs({ challengeId })
      if (runs.length === 0) {
        throw new HttpRequestError(404, "no_runs", "该题没有任何 Run 记录")
      }
      const requestedRunId = optionalQueryString(
        url.searchParams.get("run"),
        "run",
        64,
      )
      const run = requestedRunId
        ? runs.find((candidate) => candidate.id === requestedRunId)
        : [...runs].sort(
            (left, right) =>
              Date.parse(right.createdAt) - Date.parse(left.createdAt),
          )[0]
      if (!run) {
        throw new HttpRequestError(
          404,
          "run_not_found",
          `该题不存在 Run: ${requestedRunId}`,
        )
      }
      let body: Buffer
      try {
        body = await exportSessionHtml(
          project.runSessionPath(run.id),
          await project.runSessionExportMetadata(run.id),
        )
      } catch (error) {
        throw new HttpRequestError(
          409,
          "session_export_failed",
          `无法导出 Pi 会话: ${errorText(error)}`,
        )
      }
      // 直接以 HTML 页面内联呈现，不强制下载；平台/run 数据因此不会进入响应头。
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Length": body.byteLength,
      })
      response.end(body)
      return
    }

    if (
      method === "POST" &&
      /^\/api\/challenges\/[^/]+\/tldr\/refresh$/.test(url.pathname)
    ) {
      const project = currentProject()
      requireProject(project)
      const modelConfiguration = options.modelConfiguration
      if (!modelConfiguration?.snapshot().configured) {
        throw new HttpRequestError(
          503,
          "model_unavailable",
          "模型尚未配置，无法生成 TLDR",
        )
      }
      const encodedId = url.pathname
        .slice("/api/challenges/".length)
        .slice(0, -"/tldr/refresh".length)
      const challengeId = decodeURIComponent(encodedId)
      const tldr = await project.refreshTldr(
        challengeId,
        modelConfiguration.createAgentOptions(),
      )
      if (tldr.challengeId !== challengeId) {
        throw new HttpRequestError(404, "challenge_not_found", "题目不存在")
      }
      sendJson(response, 200, { tldr })
      return
    }

    if (
      method === "GET" &&
      /^\/api\/challenges\/[^/]+\/tldr$/.test(url.pathname)
    ) {
      const project = currentProject()
      requireProject(project)
      const encodedId = url.pathname
        .slice("/api/challenges/".length)
        .slice(0, -"/tldr".length)
      const challengeId = decodeURIComponent(encodedId)
      sendJson(response, 200, { tldr: project.tldr(challengeId) ?? null })
      return
    }

    if (
      method === "GET" &&
      /^\/api\/challenges\/[^/]+\/writeup$/.test(url.pathname)
    ) {
      const project = currentProject()
      requireProject(project)
      const encodedId = url.pathname
        .slice("/api/challenges/".length)
        .slice(0, -"/writeup".length)
      const challengeId = decodeURIComponent(encodedId)
      const writeup = await project.challengeWriteup(challengeId)
      if (!writeup.validation.valid || !writeup.content) {
        sendJson(response, 409, {
          error: "writeup_unavailable",
          validation: writeup.validation,
        })
        return
      }
      const body = Buffer.from(writeup.content, "utf8")
      response.writeHead(200, {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename="writeup-${filenameSafe(challengeId)}.md"`,
        "Cache-Control": "no-store",
        "Content-Length": body.byteLength,
      })
      response.end(body)
      return
    }

    if (method === "GET" && url.pathname.startsWith("/api/challenges/")) {
      const project = currentProject()
      requireProject(project)
      const encodedId = url.pathname.slice("/api/challenges/".length)
      const challengeId = decodeURIComponent(encodedId)
      const details = await buildChallengeDetails(
        project,
        challengeId,
        currentScheduler(),
        latestSnapshot,
      )
      if (!details) {
        sendJson(response, 404, { error: "challenge_not_found" })
        return
      }
      sendJson(response, 200, details)
      return
    }

    if (method === "GET" && url.pathname === "/api/events") {
      response.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      })
      response.write(": connected\n\n")
      clients.add(response)
      writeEvent(
        response,
        "snapshot",
        serializedSnapshot,
        latestSnapshot.generatedAt,
      )
      writeEvent(response, "dashboard_status", JSON.stringify(syncHealth))
      request.once("close", () => clients.delete(response))
      return
    }

    if (method === "GET") {
      const asset = assets.get(url.pathname)
      if (asset) {
        response.writeHead(200, {
          "Content-Type": asset.contentType,
          "Cache-Control": "no-cache",
          "Content-Length": asset.content.byteLength,
        })
        response.end(asset.content)
        return
      }
    }

    sendJson(response, 404, { error: "not_found" })
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(requestedPort, host, () => {
      server.off("error", reject)
      resolve()
    })
  })

  const address = server.address() as AddressInfo
  let closed = false
  let refreshTimer: NodeJS.Timeout | undefined
  const scheduleRefresh = (delayMs: number): void => {
    refreshTimer = setTimeout(async () => {
      try {
        await refresh()
      } catch {
        // refresh() already records and broadcasts the failure exactly once.
      } finally {
        if (!closed) {
          const exponent = Math.min(syncHealth.consecutiveFailures, 5)
          const nextDelay =
            syncHealth.status === "ok"
              ? pollIntervalMs
              : Math.min(30_000, pollIntervalMs * 2 ** exponent)
          scheduleRefresh(nextDelay)
        }
      }
    }, delayMs)
    refreshTimer.unref()
  }
  scheduleRefresh(pollIntervalMs)

  const heartbeat = setInterval(() => {
    for (const client of clients) client.write(": heartbeat\n\n")
  }, 15_000)
  heartbeat.unref()
  const schedulerReconcileDelay = Math.max(
    5_000,
    options.schedulerReconcileIntervalMs ?? 30_000,
  )
  let schedulerReconcileTimer: NodeJS.Timeout | undefined
  const scheduleReconcile = (delayMs: number): void => {
    if (!options.scheduler && !options.controlPlane) return
    schedulerReconcileTimer = setTimeout(async () => {
      const scheduler = currentScheduler()
      if (scheduler?.snapshot().autoEnabled) {
        try {
          await scheduler.reconcile()
        } catch (error) {
          markSyncFailure(error, "调度器平台同步")
        }
      }
      if (!closed) scheduleReconcile(schedulerReconcileDelay)
    }, delayMs)
    schedulerReconcileTimer.unref()
  }
  scheduleReconcile(schedulerReconcileDelay)

  return {
    host,
    port: address.port,
    url: `http://${host.includes(":") ? `[${host}]` : host}:${address.port}`,
    refresh,
    async close(): Promise<void> {
      closed = true
      if (refreshTimer) clearTimeout(refreshTimer)
      clearInterval(heartbeat)
      if (schedulerReconcileTimer) clearTimeout(schedulerReconcileTimer)
      for (const client of clients) client.end()
      clients.clear()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    },
  }
}

async function loadStaticAssets(): Promise<Map<string, StaticAsset>> {
  const loaded = new Map<string, StaticAsset>()
  await Promise.all(
    [...STATIC_ASSETS].map(async ([route, asset]) => {
      loaded.set(route, {
        content: await readFile(asset.file),
        contentType: asset.contentType,
      })
    }),
  )
  return loaded
}

function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  })
  response.end(body)
}

function broadcast(
  clients: Set<ServerResponse>,
  event: string,
  data: string,
  id?: string,
): void {
  for (const client of clients) writeEvent(client, event, data, id)
}

function writeEvent(
  response: ServerResponse,
  event: string,
  data: string,
  id?: string,
): void {
  if (id) response.write(`id: ${id}\n`)
  response.write(`event: ${event}\n`)
  for (const line of data.split("\n")) response.write(`data: ${line}\n`)
  response.write("\n")
}

function fingerprint(snapshot: DashboardSnapshot): string {
  return JSON.stringify({
    overview: snapshot.overview,
    stats: snapshot.stats,
    challenges: snapshot.challenges,
    categories: snapshot.categories,
    announcements: snapshot.announcements,
    environments: snapshot.environments,
    scheduler: snapshot.scheduler,
    controlPlane: snapshot.controlPlane,
  })
}

function requireProject(
  project: DashboardProject | undefined,
): asserts project is DashboardProject {
  if (!project) {
    throw new HttpRequestError(
      503,
      "project_unavailable",
      "比赛尚未配置或平台当前未连接",
    )
  }
}

function requireScheduler(
  scheduler: DashboardScheduler | undefined,
): asserts scheduler is DashboardScheduler {
  if (!scheduler) {
    throw new ContestSchedulerError("unavailable", "当前控制面没有配置调度器")
  }
}

function requireModelConfiguration(
  configuration: DashboardModelConfiguration | undefined,
): asserts configuration is DashboardModelConfiguration {
  if (!configuration) {
    throw new HttpRequestError(
      404,
      "model_configuration_unavailable",
      "当前控制面不支持模型配置",
    )
  }
}

function requireModelAuthentication(
  authentication: DashboardModelAuthentication | undefined,
): asserts authentication is DashboardModelAuthentication {
  if (!authentication) {
    throw new HttpRequestError(
      404,
      "model_authentication_unavailable",
      "当前控制面不支持模型凭据管理",
    )
  }
}

async function reconcileModelAvailability(
  configuration: DashboardModelConfiguration | undefined,
  scheduler: DashboardScheduler | undefined,
): Promise<ReturnType<DashboardModelConfiguration["snapshot"]> | null> {
  if (!configuration) return null
  const current = configuration.snapshot()
  if (current.configured) await scheduler?.reconcile()
  else scheduler?.pauseAuto()
  return current
}

async function modelAuthenticationAction<T>(
  action: () => Promise<T>,
): Promise<T> {
  try {
    return await action()
  } catch (error) {
    throw new HttpRequestError(
      400,
      "invalid_model_authentication",
      errorText(error),
    )
  }
}

function requireControlPlane(
  controlPlane: DashboardControlPlane | undefined,
): asserts controlPlane is DashboardControlPlane {
  if (!controlPlane) {
    throw new HttpRequestError(
      404,
      "control_plane_unavailable",
      "当前 WebUI 未启用动态控制面",
    )
  }
}

function controlPlaneSetup(body: Record<string, unknown>): {
  config: ProjectConfig
  secrets?: Readonly<Record<string, string | undefined>>
} {
  let config: ProjectConfig
  try {
    config = parseProjectConfig(body.config)
  } catch (error) {
    throw new HttpRequestError(400, "invalid_project_config", errorText(error))
  }
  if (body.secrets === undefined) return { config }
  if (
    typeof body.secrets !== "object" ||
    body.secrets === null ||
    Array.isArray(body.secrets)
  ) {
    throw new HttpRequestError(
      400,
      "invalid_secrets",
      "secrets 必须是字符串键值对象",
    )
  }
  const secrets: Record<string, string | undefined> = {}
  for (const [name, value] of Object.entries(body.secrets)) {
    if (typeof value !== "string") {
      throw new HttpRequestError(
        400,
        "invalid_secrets",
        `密钥 ${name} 必须是字符串`,
      )
    }
    secrets[name] = value.length > 0 ? value : undefined
  }
  return { config, secrets }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 跨包错误契约:按 Error 上的 code 字段匹配(不依赖错误类型)。 */
function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === code
  )
}

/** Content-Disposition filename 段白名单清洗:平台/run 数据不可信,防 header 注入。 */
function filenameSafe(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64)
}

function requireJsonRequest(request: IncomingMessage): void {
  const contentType = request.headers["content-type"] ?? ""
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new HttpRequestError(
      415,
      "unsupported_media_type",
      "控制操作必须使用 application/json",
    )
  }
}

async function readJsonBody(
  request: IncomingMessage,
  maximumSize = 16_384,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.byteLength
    if (size > maximumSize)
      throw new HttpRequestError(413, "payload_too_large", "请求体过大")
    chunks.push(buffer)
  }
  if (size === 0) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown
  } catch {
    throw new HttpRequestError(400, "invalid_json", "请求体不是有效 JSON")
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new HttpRequestError(400, "invalid_json", "请求体必须是 JSON 对象")
  }
  return parsed as Record<string, unknown>
}

function modelConfigurationUpdate(
  body: Record<string, unknown>,
): ModelConfigurationUpdate {
  const provider = requiredString(body.provider, "Provider", 128)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(provider)) {
    throw new HttpRequestError(
      400,
      "invalid_model_configuration",
      "Provider 只能包含字母、数字、点、下划线和连字符",
    )
  }
  const modelId = requiredString(body.modelId, "Model ID", 256)
  if (hasControlCharacter(modelId)) {
    throw new HttpRequestError(
      400,
      "invalid_model_configuration",
      "Model ID 不能包含控制字符",
    )
  }
  const baseUrl = optionalString(body.baseUrl, "Base URL", 2_048)
  if (baseUrl) {
    let parsed: URL
    try {
      parsed = new URL(baseUrl)
    } catch {
      throw new HttpRequestError(
        400,
        "invalid_model_configuration",
        "Base URL 不是有效 URL",
      )
    }
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new HttpRequestError(
        400,
        "invalid_model_configuration",
        "Base URL 仅支持 HTTP 或 HTTPS",
      )
    }
  }
  const contextWindow = requiredPositiveInteger(
    body.contextWindow,
    "Context Window",
    2_000_000,
  )
  const apiKey =
    body.apiKey === undefined
      ? undefined
      : optionalString(body.apiKey, "API Key", 8_192)
  const clearApiKey = body.clearApiKey === true
  if (apiKey && clearApiKey) {
    throw new HttpRequestError(
      400,
      "invalid_model_configuration",
      "不能同时设置和清除 API Key",
    )
  }
  const thinkingEnabled = body.thinkingEnabled === true
  const passthroughThinking = body.passthroughThinking === true
  const reasoningEffort = requiredString(
    body.reasoningEffort,
    "Reasoning Effort",
    32,
  )
  if (!THINKING_LEVELS.has(reasoningEffort)) {
    throw new HttpRequestError(
      400,
      "invalid_model_configuration",
      `Reasoning Effort 必须是 ${[...THINKING_LEVELS].join("/")} 之一`,
    )
  }
  return {
    provider,
    modelId,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    contextWindow,
    thinkingEnabled,
    reasoningEffort,
    passthroughThinking,
    ...(apiKey ? { apiKey } : {}),
    ...(clearApiKey ? { clearApiKey: true } : {}),
  }
}

/** 思考强度档位全集(与 pi ThinkingLevel 一致,不含 off——off 由 thinkingEnabled 表达)。 */
const THINKING_LEVELS = new Set([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
])

function optionalQueryString(
  value: string | null,
  field: string,
  maxLength: number,
): string | undefined {
  if (value === null) return undefined
  const text = value.trim()
  if (text.length === 0) return undefined
  if (text.length > maxLength) {
    throw new HttpRequestError(
      400,
      "invalid_query",
      `${field} 长度不能超过 ${maxLength}`,
    )
  }
  if (hasControlCharacter(text)) {
    throw new HttpRequestError(
      400,
      "invalid_query",
      `${field} 不能包含控制字符`,
    )
  }
  return text
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code <= 0x1f || code === 0x7f
  })
}

function requiredString(
  value: unknown,
  field: string,
  maxLength: number,
  code = "invalid_model_configuration",
): string {
  const text = optionalString(value, field, maxLength, code)
  if (text) return text
  throw new HttpRequestError(400, code, `${field} 不能为空`)
}

function optionalString(
  value: unknown,
  field: string,
  maxLength: number,
  code = "invalid_model_configuration",
): string {
  if (typeof value !== "string") {
    throw new HttpRequestError(400, code, `${field} 必须是字符串`)
  }
  const text = value.trim()
  if (text.length > maxLength) {
    throw new HttpRequestError(400, code, `${field} 长度不能超过 ${maxLength}`)
  }
  return text
}

function requiredPositiveInteger(
  value: unknown,
  field: string,
  max: number,
  code = "invalid_model_configuration",
): number {
  if (!Number.isInteger(value) || Number(value) <= 0 || Number(value) > max) {
    throw new HttpRequestError(400, code, `${field} 必须是 1–${max} 的整数`)
  }
  return Number(value)
}

class HttpRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = "HttpRequestError"
  }
}
