import { readFile } from "node:fs/promises"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { ContestSchedulerError } from "@ctf-agent/solver"
import { buildSessionMarkdown } from "./export.ts"
import { buildChallengeDetails, buildDashboardSnapshot } from "./model.ts"
import type {
  DashboardModelConfiguration,
  DashboardProject,
  DashboardScheduler,
  DashboardSnapshot,
  ModelConfigurationUpdate,
} from "./types.ts"

export interface WebUiOptions {
  project: DashboardProject
  host?: string
  port?: number
  pollIntervalMs?: number
  scheduler?: DashboardScheduler
  schedulerReconcileIntervalMs?: number
  modelConfiguration?: DashboardModelConfiguration
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

const STATIC_ASSETS = new Map<string, { file: URL; contentType: string }>([
  ["/", { file: new URL("./client/index.html", import.meta.url), contentType: "text/html; charset=utf-8" }],
  ["/app.js", { file: new URL("./client/app.js", import.meta.url), contentType: "text/javascript; charset=utf-8" }],
  ["/styles.css", { file: new URL("./client/styles.css", import.meta.url), contentType: "text/css; charset=utf-8" }],
])

export async function startWebUi(options: WebUiOptions): Promise<WebUiServer> {
  const host = options.host ?? "127.0.0.1"
  const requestedPort = options.port ?? 3000
  const pollIntervalMs = Math.max(250, options.pollIntervalMs ?? 1_000)
  const clients = new Set<ServerResponse>()
  const assets = await loadStaticAssets()
  let latestSnapshot = await buildDashboardSnapshot(options.project, options.scheduler)
  let serializedSnapshot = JSON.stringify(latestSnapshot)
  let snapshotFingerprint = fingerprint(latestSnapshot)
  let pendingRefresh: Promise<DashboardSnapshot> | undefined

  const refresh = async (): Promise<DashboardSnapshot> => {
    if (pendingRefresh) return pendingRefresh
    pendingRefresh = buildDashboardSnapshot(options.project, options.scheduler)
      .then((snapshot) => {
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
        const status = error.code === "challenge_not_found"
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
        scheduler: options.scheduler?.snapshot() ?? null,
        modelConfiguration: options.modelConfiguration?.snapshot() ?? null,
      })
      return
    }

    if (method === "GET" && url.pathname === "/api/snapshot") {
      sendJson(response, 200, await refresh())
      return
    }

    if (method === "POST" && url.pathname === "/api/refresh") {
      requireJsonRequest(request)
      await options.project.refresh()
      await options.scheduler?.reconcile()
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
      if (!configuration.configured) options.scheduler?.pauseAuto()
      else await options.scheduler?.reconcile()
      sendJson(response, 200, {
        configuration,
        snapshot: await refresh(),
      })
      return
    }

    if (method === "POST" && url.pathname === "/api/scheduler/auto/start") {
      requireScheduler(options.scheduler)
      requireJsonRequest(request)
      await options.scheduler.startAuto()
      sendJson(response, 200, await refresh())
      return
    }

    if (method === "POST" && url.pathname === "/api/scheduler/auto/pause") {
      requireScheduler(options.scheduler)
      requireJsonRequest(request)
      options.scheduler.pauseAuto()
      sendJson(response, 200, await refresh())
      return
    }

    const action = /^\/api\/challenges\/([^/]+)\/(dispatch|cancel)$/.exec(url.pathname)
    if (method === "POST" && action) {
      requireScheduler(options.scheduler)
      requireJsonRequest(request)
      const challengeId = decodeURIComponent(action[1]!)
      if (action[2] === "dispatch") {
        const body = await readJsonBody(request)
        await options.scheduler.dispatch(challengeId, { force: body.force === true })
      } else {
        await options.scheduler.cancel(challengeId)
      }
      sendJson(response, 200, await refresh())
      return
    }

    // 题目级对话框:向该题当前活跃的 solver 发送人工消息(走 project,不走调度器)
    const message = /^\/api\/challenges\/([^/]+)\/message$/.exec(url.pathname)
    if (method === "POST" && message) {
      requireJsonRequest(request)
      const challengeId = decodeURIComponent(message[1]!)
      const body = await readJsonBody(request)
      const text = requiredString(body.text, "Text", 4_000, "invalid_message")
      try {
        sendJson(response, 200, await options.project.sendMessage(challengeId, text))
      } catch (error) {
        if (hasCode(error, "no_active_run")) {
          throw new HttpRequestError(409, "no_active_run", "该题当前没有运行中的 Agent")
        }
        if (hasCode(error, "invalid_message")) {
          // 保留 project 侧原始错误文案,不掩盖真实校验错误(requiredString 已在上游拦截)
          throw new HttpRequestError(
            400,
            "invalid_message",
            error instanceof Error && error.message ? error.message : "invalid_message",
          )
        }
        throw error
      }
      return
    }

    // 运行中切换思考强度:向该题当前活跃的 solver 设置 thinkingLevel(下一 turn 生效)
    const thinkingLevel = /^\/api\/challenges\/([^/]+)\/thinking-level$/.exec(url.pathname)
    if (method === "POST" && thinkingLevel) {
      requireJsonRequest(request)
      const challengeId = decodeURIComponent(thinkingLevel[1]!)
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
        sendJson(response, 200, await options.project.setThinkingLevel(challengeId, level))
      } catch (error) {
        if (hasCode(error, "no_active_run")) {
          throw new HttpRequestError(409, "no_active_run", "该题当前没有运行中的 Agent")
        }
        if (hasCode(error, "invalid_level")) {
          throw new HttpRequestError(400, "invalid_level", "不支持的思考强度")
        }
        throw error
      }
      return
    }

    // 会话复盘导出:必须在 /api/challenges/ 详情分支(startsWith)之前,否则路径被吞。
    const exportMatch = /^\/api\/challenges\/([^/]+)\/export$/.exec(url.pathname)
    if (method === "GET" && exportMatch) {
      const challengeId = decodeURIComponent(exportMatch[1]!)
      const runs = options.project.runs({ challengeId })
      if (runs.length === 0) {
        throw new HttpRequestError(404, "no_runs", "该题没有任何 Run 记录")
      }
      const runId = optionalQueryString(url.searchParams.get("run"), "run", 64)
      if (runId) {
        const exists = runs.some((run) => run.id === runId)
        if (!exists) {
          throw new HttpRequestError(404, "run_not_found", `该题不存在 Run: ${runId}`)
        }
      }
      const markdown = buildSessionMarkdown(options.project, challengeId, {
        runId,
        full: url.searchParams.get("full") === "1",
      })
      const safeChallenge = filenameSafe(challengeId)
      const filename = runId
        ? `session-${safeChallenge}-${filenameSafe(runId.slice(0, 8))}-${timestampForFilename()}.md`
        : `session-${safeChallenge}-all-${timestampForFilename()}.md`
      const body = Buffer.from(markdown, "utf8")
      response.writeHead(200, {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
        "Content-Length": body.byteLength,
      })
      response.end(body)
      return
    }

    if (method === "GET" && url.pathname.startsWith("/api/challenges/")) {
      const encodedId = url.pathname.slice("/api/challenges/".length)
      const challengeId = decodeURIComponent(encodedId)
      const details = await buildChallengeDetails(options.project, challengeId, options.scheduler)
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
      writeEvent(response, "snapshot", serializedSnapshot, latestSnapshot.generatedAt)
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
  const interval = setInterval(() => {
    void refresh().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      broadcast(clients, "dashboard_error", JSON.stringify({ message }))
    })
  }, pollIntervalMs)
  interval.unref()

  const heartbeat = setInterval(() => {
    for (const client of clients) client.write(": heartbeat\n\n")
  }, 15_000)
  heartbeat.unref()
  const schedulerReconcileInterval = options.scheduler
    ? setInterval(() => {
        if (!options.scheduler?.snapshot().autoEnabled) return
        void options.scheduler.reconcile()
          .then(() => refresh())
          .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error)
            broadcast(clients, "dashboard_error", JSON.stringify({ message }))
          })
      }, Math.max(5_000, options.schedulerReconcileIntervalMs ?? 30_000))
    : undefined
  schedulerReconcileInterval?.unref()

  return {
    host,
    port: address.port,
    url: `http://${host.includes(":") ? `[${host}]` : host}:${address.port}`,
    refresh,
    async close(): Promise<void> {
      clearInterval(interval)
      clearInterval(heartbeat)
      if (schedulerReconcileInterval) clearInterval(schedulerReconcileInterval)
      for (const client of clients) client.end()
      clients.clear()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve())
      })
    },
  }
}

async function loadStaticAssets(): Promise<Map<string, StaticAsset>> {
  const loaded = new Map<string, StaticAsset>()
  await Promise.all([...STATIC_ASSETS].map(async ([route, asset]) => {
    loaded.set(route, {
      content: await readFile(asset.file),
      contentType: asset.contentType,
    })
  }))
  return loaded
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
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
  })
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

/** 跨包错误契约:按 Error 上的 code 字段匹配(不依赖错误类型)。 */
function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null &&
    (error as { code?: unknown }).code === code
}

/** Content-Disposition filename 段白名单清洗:平台/run 数据不可信,防 header 注入。 */
function filenameSafe(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64)
}

function timestampForFilename(): string {
  const date = new Date()
  const pad = (value: number) => String(value).padStart(2, "0")
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("-")
}

function requireJsonRequest(request: IncomingMessage): void {
  const contentType = request.headers["content-type"] ?? ""
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new HttpRequestError(415, "unsupported_media_type", "控制操作必须使用 application/json")
  }
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.byteLength
    if (size > 16_384) throw new HttpRequestError(413, "payload_too_large", "请求体过大")
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
  if (/[\u0000-\u001f\u007f]/.test(modelId)) {
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
  const maxTokens = requiredPositiveInteger(body.maxTokens, "Max Tokens", 1_000_000)
  if (maxTokens > contextWindow) {
    throw new HttpRequestError(
      400,
      "invalid_model_configuration",
      "Max Tokens 不能大于 Context Window",
    )
  }
  const apiKey = body.apiKey === undefined
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
  const reasoningEffort = requiredString(body.reasoningEffort, "Reasoning Effort", 32)
  if (!THINKING_LEVELS.has(reasoningEffort)) {
    throw new HttpRequestError(
      400,
      "invalid_model_configuration",
      `Reasoning Effort 必须是 ${[...THINKING_LEVELS].join("/")} 之一`,
    )
  }
  const platformToken = body.platformToken === undefined
    ? undefined
    : optionalString(body.platformToken, "Platform Token", 8_192)
  const clearPlatformToken = body.clearPlatformToken === true
  if (platformToken && clearPlatformToken) {
    throw new HttpRequestError(
      400,
      "invalid_model_configuration",
      "不能同时设置和清除 Platform Token",
    )
  }
  return {
    provider,
    modelId,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    contextWindow,
    maxTokens,
    thinkingEnabled,
    reasoningEffort,
    passthroughThinking,
    ...(apiKey ? { apiKey } : {}),
    ...(clearApiKey ? { clearApiKey: true } : {}),
    ...(platformToken ? { platformToken } : {}),
    ...(clearPlatformToken ? { clearPlatformToken: true } : {}),
  }
}

/** 思考强度档位全集(与 pi ThinkingLevel 一致,不含 off——off 由 thinkingEnabled 表达)。 */
const THINKING_LEVELS = new Set(["minimal", "low", "medium", "high", "xhigh", "max"])

function optionalQueryString(value: string | null, field: string, maxLength: number): string | undefined {
  if (value === null) return undefined
  const text = value.trim()
  if (text.length === 0) return undefined
  if (text.length > maxLength) {
    throw new HttpRequestError(400, "invalid_query", `${field} 长度不能超过 ${maxLength}`)
  }
  if (/[\u0000-\u001f\u007f]/.test(text)) {
    throw new HttpRequestError(400, "invalid_query", `${field} 不能包含控制字符`)
  }
  return text
}

function requiredString(value: unknown, field: string, maxLength: number, code = "invalid_model_configuration"): string {
  const text = optionalString(value, field, maxLength, code)
  if (text) return text
  throw new HttpRequestError(
    400,
    code,
    `${field} 不能为空`,
  )
}

function optionalString(value: unknown, field: string, maxLength: number, code = "invalid_model_configuration"): string {
  if (typeof value !== "string") {
    throw new HttpRequestError(
      400,
      code,
      `${field} 必须是字符串`,
    )
  }
  const text = value.trim()
  if (text.length > maxLength) {
    throw new HttpRequestError(
      400,
      code,
      `${field} 长度不能超过 ${maxLength}`,
    )
  }
  return text
}

function requiredPositiveInteger(value: unknown, field: string, max: number): number {
  if (!Number.isInteger(value) || Number(value) <= 0 || Number(value) > max) {
    throw new HttpRequestError(
      400,
      "invalid_model_configuration",
      `${field} 必须是 1–${max} 的整数`,
    )
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
