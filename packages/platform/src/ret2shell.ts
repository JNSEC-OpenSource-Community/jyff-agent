import type {
  Announcement,
  Attachment,
  ChallengeCapability,
  ChallengeInfo,
  ChallengeSummary,
  ContestOverview,
  FlagSubmission,
  PlatformPlugin,
  PlatformProject,
  PlatformSetupDescriptor,
  RemoteEnvironment,
} from "@ctf-agent/platform"
import { createServer, type AddressInfo, type Server, type Socket } from "node:net"

// ---------------------------------------------------------------------------
// Ret2Shell (https://github.com/ret2shell/ret2shell) platform adapter.
//
// API conventions (verified against crates/server/src/routes and the live
// ctf.xidian.edu.cn site):
//   * API base is <site>/api; errors are text/plain with the status code
//     semantics of HTTP.
//   * Auth: `Authorization: Basic base64(account:password)` works per request
//     (oneshot basic auth, no captcha); `Authorization: Bearer <jwt>` also
//     works for tokens issued by the platform.
//   * Challenge list returns `[Challenge[], total]`; without pagination
//     params the server returns the whole list.
//   * Submissions are asynchronous: POST returns a record with
//     solved/result == null; the checker worker fills them in, poll
//     GET .../submit?id=<id>.
//   * Remote environments: instances expose `traffic` + `ports`; without an
//     exposed traffic mapper the only access path is the wsrx WebSocket
//     tunnel `ws(s)://<host>/api/traffic/<traffic>?port=<port>`. That endpoint
//     speaks the WebSocketReflectorX protocol (plain TCP bytes over binary
//     WebSocket frames). This adapter proxies it in-process to a local TCP
//     listener so the environment appears as a plain tcp://127.0.0.1:<port>.
// ---------------------------------------------------------------------------

const REQUEST_TIMEOUT_MS = 30_000
const SUBMIT_POLL_INTERVAL_MS = 1_500
const SUBMIT_POLL_MAX_TRIES = 45 // ~67s worst case
// Instance startup is deliberately polled conservatively to avoid flooding
// the upstream `/game/<id>/instance` endpoint while a container is starting.
const INSTANCE_POLL_INTERVAL_MS = 10_000
const INSTANCE_START_TIMEOUT_MS = 3 * 60_000

// ---------------------------------------------------------------------------
// Error type (bounded, credential-free)
// ---------------------------------------------------------------------------

export type R2SErrorCode =
  | "config"
  | "network"
  | "auth"
  | "permission"
  | "not_found"
  | "rate_limited"
  | "conflict"
  | "precondition"
  | "protocol"
  | "server"

export class R2SError extends Error {
  readonly code: R2SErrorCode
  readonly status?: number
  readonly retryable: boolean
  readonly retryAfterMs?: number
  constructor(
    code: R2SErrorCode,
    message: string,
    status?: number,
    retry?: { retryable: boolean; retryAfterMs?: number },
  ) {
    super(message)
    this.name = "R2SError"
    this.code = code
    this.status = status
    this.retryable =
      retry?.retryable ??
      (this.code === "network" || this.code === "rate_limited" || this.code === "server")
    if (retry?.retryAfterMs !== undefined) this.retryAfterMs = retry.retryAfterMs
  }
}

// ---------------------------------------------------------------------------
// Upstream response shapes
// ---------------------------------------------------------------------------

interface R2SGame {
  id: number
  name: string
  brief?: string | null
  start_at: number
  end_at: number
  hidden?: boolean
  offline?: boolean
}

interface R2STag {
  name: string
  primary: boolean
}

interface R2SChallenge {
  id: number
  name: string
  updated_at: number
  content: string | null
  hidden: boolean
  game_id: number
  tag: R2STag[]
  score_rule: { initial: number; minimum: number; decay: number }
  score: number
  release_at: number | null
  archive_at: number | null
}

interface R2SNotification {
  id: number
  title: string
  content: string
  published_at: number
  game_id: number
  publisher_id: number
  publisher_name: string
}

interface R2SFile {
  folder: "static" | "mapped" | "checker"
  file: string
}

interface R2SEnvImage {
  name: string
  tag?: string | null
  port: number | null
  protocol?: "tcp" | "stcp" | "udp" | null
  app_protocol?: "raw" | "http" | null
  service_type?: "http" | "tcp" | "udp" | null
  description?: string | null
  restricted?: boolean | null
}

interface R2SEnv {
  internet: boolean
  restricted?: boolean | null
  privileged?: boolean | null
  images: R2SEnvImage[]
  pull_secret?: string | null
}

interface R2SSolvesStatus {
  solved: boolean
  solves: number
}

interface R2SSubmission {
  id: number
  created_at: number
  user_id: number
  challenge_id: number
  team_id?: number | null
  content?: string | null
  solved: boolean | null
  result: string | null
}

interface R2SInstance {
  state: string
  name: string
  traffic: string
  ports: number[]
  renew_count: number
  created_at: number
  user_id: number
  user_name?: string
  team_id: number
  team_name?: string
  challenge_id: number
  challenge_name?: string
  game_id: number
  game_name?: string
  exposed_ports: { name: string; address: string }[] | null
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface PluginConfig {
  baseUrl: string
  gameId?: number
  auth: { type: "basic" } | { type: "bearer" }
}

const CONFIG_KEYS = new Set(["baseUrl", "gameId", "auth"])

export function parseConfig(value: unknown): PluginConfig {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new R2SError("config", "config must be an object")
  }
  const raw = value as Record<string, unknown>
  for (const key of Object.keys(raw)) {
    if (!CONFIG_KEYS.has(key)) {
      throw new R2SError("config", `unknown config key: ${key}`)
    }
  }

  const baseUrl = raw.baseUrl
  if (typeof baseUrl !== "string" || baseUrl.trim().length === 0) {
    throw new R2SError("config", "baseUrl is required and must be a URL string")
  }
  let parsedUrl: URL
  try {
    parsedUrl = new URL(baseUrl)
  } catch {
    throw new R2SError("config", "baseUrl is not a valid URL")
  }
  if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
    throw new R2SError("config", "baseUrl must use http:// or https://")
  }

  let basePath = parsedUrl.pathname.replace(/\/+$/, "")

  // If the user pasted a game URL (…/games/<id>), derive the game id and
  // strip the path so the API base stays <origin>/api.
  const gamesMatch = basePath.match(/\/games\/(\d+)\/?$/i)
  let gameId: number | undefined
  if (gamesMatch) {
    gameId = Number(gamesMatch[1])
    basePath = ""
  }
  if (raw.gameId !== undefined && raw.gameId !== null && raw.gameId !== "") {
    if (typeof raw.gameId === "number" && Number.isInteger(raw.gameId) && raw.gameId > 0) {
      gameId = raw.gameId
    } else if (typeof raw.gameId === "string" && /^[1-9]\d*$/.test(raw.gameId.trim())) {
      gameId = Number(raw.gameId.trim())
    } else {
      throw new R2SError("config", "gameId must be a positive integer")
    }
  }

  const auth = raw.auth
  if (auth === null || typeof auth !== "object" || Array.isArray(auth)) {
    throw new R2SError("config", "auth is required")
  }
  const authObj = auth as Record<string, unknown>
  const authKeys = Object.keys(authObj)
  if (authKeys.length !== 1 || authKeys[0] !== "type") {
    throw new R2SError(
      "config",
      "credentials must be provided through secrets, not in the config (auth may only contain a type)",
    )
  }
  const authType = authObj.type
  if (authType !== "basic" && authType !== "bearer") {
    throw new R2SError("config", 'auth.type must be "basic" or "bearer"')
  }

  return {
    baseUrl: parsedUrl.origin + basePath,
    gameId,
    auth: { type: authType },
  }
}

function apiBaseOf(baseUrl: string): string {
  return /\/api$/i.test(baseUrl) ? baseUrl : `${baseUrl}/api`
}

/**
 * Pulls a game id out of free-form identity strings such as "37",
 * "games/37", "https://…/games/37", or "game-37". Returns undefined when
 * there is no unambiguous positive integer id.
 */
export function extractGameId(
  value: string | undefined | null,
  allowSlugSuffix = false,
): number | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  if (/^[1-9]\d*$/.test(trimmed)) return Number(trimmed)
  const gamesPath = trimmed.match(/(?:^|\/)games\/(\d+)(?:\/|$)/i)
  if (gamesPath) return Number(gamesPath[1])
  // Slug forms like "game-37" — but not UUIDs/nanoids, and never for names
  // such as "MoeCTF 2026" that merely end in a year.
  if (!allowSlugSuffix) return undefined
  if (trimmed.split("-").length > 2) return undefined
  const trailing = trimmed.match(/(?:^|[^a-zA-Z0-9])([1-9]\d{1,6})$/)
  if (trailing) return Number(trailing[1])
  return undefined
}

/** Rough name matching score: exact 100, normalized-equal 90, contains 60+. */
function nameSimilarity(gameName: string, target: string): number {
  const a = gameName.trim().toLowerCase()
  const b = target.trim().toLowerCase()
  if (a === b) return 100
  if (a.includes(b)) return 70
  if (b.includes(a)) return 60
  const an = a.replace(/[^a-z0-9]/g, "")
  const bn = b.replace(/[^a-z0-9]/g, "")
  if (an === bn) return 90
  if (an.includes(bn)) return 65
  if (bn.includes(an)) return 55
  return 0
}

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------

interface RequestOptions {
  path: string
  method?: string
  authHeader: string
  query?: Record<string, string | number | boolean | undefined>
  body?: unknown
  timeoutMs?: number
  binary?: boolean
  signal?: AbortSignal
}

interface ResponseData {
  status: number
  headers: Headers
  text: string
  bytes: Uint8Array
}

async function httpRequest(baseUrl: string, options: RequestOptions): Promise<ResponseData> {
  const url = new URL(apiBaseOf(baseUrl) + options.path)
  if (options.query) {
    for (const [key, value] of Object.entries(options.query)) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value))
      }
    }
  }

  const headers = new Headers()
  headers.set("Authorization", options.authHeader)
  headers.set("Accept", "application/json")
  headers.set("Accept-Language", "zh-CN,en-US;q=0.8")
  let body: string | undefined
  if (options.body !== undefined) {
    headers.set("Content-Type", "application/json")
    body = JSON.stringify(options.body)
  }

  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal
  try {
    const response = await fetch(url.toString(), {
      method: options.method ?? "GET",
      headers,
      body,
      signal,
      redirect: "follow",
    })

    // The deadline covers the response body too. Clearing a timer after headers
    // lets a stalled body keep a tool call pending forever.
    const bytes = new Uint8Array(await response.arrayBuffer())
    const text = new TextDecoder("utf-8").decode(bytes)

    if (response.status >= 400) {
      const detail = (text || response.statusText).trim().slice(0, 200)
      throw errorFromStatus(response.status, detail)
    }

    return { status: response.status, headers: response.headers, text, bytes }
  } catch (err) {
    if (err instanceof R2SError) throw err
    if (options.signal?.aborted) throw abortReason(options.signal)
    if (timeoutSignal.aborted) {
      throw new R2SError("network", `request to ${url.origin} timed out after ${timeoutMs}ms`)
    }
    const reason = err instanceof Error ? err.message : String(err)
    throw new R2SError("network", `cannot reach ${url.origin}: ${reason}`)
  }
}

function errorFromStatus(status: number, detail: string): R2SError {
  switch (status) {
    case 401:
      return new R2SError("auth", `authentication failed: ${detail}`, status)
    case 403:
      return new R2SError("permission", `permission denied: ${detail}`, status)
    case 404:
      return new R2SError("not_found", `resource not found: ${detail}`, status)
    case 409:
      return new R2SError("conflict", `conflict: ${detail}`, status)
    case 412:
      return new R2SError(
        "precondition",
        `precondition failed: ${detail}`,
        status,
        /rebuilding cargo crates/i.test(detail)
          ? { retryable: true, retryAfterMs: 2_000 }
          : undefined,
      )
    case 429:
      return new R2SError("rate_limited", `rate limited: ${detail}`, status)
    default:
      if (status >= 500) {
        return new R2SError("server", `server error (${status}): ${detail}`, status)
      }
      return new R2SError("protocol", `unexpected response (${status}): ${detail}`, status)
  }
}

function parseJson<T>(data: ResponseData, path: string): T {
  try {
    return JSON.parse(data.text) as T
  } catch {
    throw new R2SError("protocol", `invalid JSON from ${path}`)
  }
}

// ---------------------------------------------------------------------------
// WebSocketReflectorX in-process tunnel
//
// The ret2shell traffic endpoint (`/api/traffic/<traffic>?port=<port>`) speaks
// the WebSocketReflectorX protocol: raw TCP stream bytes carried inside binary
// WebSocket frames (one WebSocket per TCP connection). We proxy it locally so
// the remote environment is reachable as a plain TCP endpoint.
// ---------------------------------------------------------------------------

interface TunnelMeta {
  traffic: string
  port: number
  challengeId: string
}

interface TunnelEntry extends TunnelMeta {
  key: string
  localAddr: string
  server: Server
  sockets: Set<Socket>
  websockets: Set<WebSocket>
}

export class TunnelManager {
  private entries = new Map<string, TunnelEntry>()
  private pending = new Map<string, Promise<string>>()
  private closedFlag = false

  get closed(): boolean {
    return this.closedFlag
  }

  /** Returns the local TCP address proxying the given wsrx remote endpoint. */
  ensure(remote: string, meta: TunnelMeta): Promise<string> {
    if (this.closedFlag) {
      return Promise.reject(new R2SError("protocol", "tunnel manager is closed"))
    }
    const key = `${meta.traffic}:${meta.port}`
    const existing = this.entries.get(key)
    if (existing) return Promise.resolve(existing.localAddr)
    const inflight = this.pending.get(key)
    if (inflight) return inflight

    const creating = this.listen(remote, key, meta)
      .then((entry) => {
        this.pending.delete(key)
        this.entries.set(key, entry)
        return entry.localAddr
      })
      .catch((err: unknown) => {
        this.pending.delete(key)
        throw err
      })
    this.pending.set(key, creating)
    return creating
  }

  private listen(remote: string, key: string, meta: TunnelMeta): Promise<TunnelEntry> {
    return new Promise((resolve, reject) => {
      const entry: TunnelEntry = {
        ...meta,
        key,
        localAddr: "",
        server: undefined as unknown as Server,
        sockets: new Set(),
        websockets: new Set(),
      }
      const server = createServer((socket) => {
        this.attach(socket, remote, entry)
      })
      entry.server = server
      server.on("error", (err) => {
        reject(new R2SError("protocol", `wsrx tunnel failed to listen: ${err.message}`))
      })
      server.listen(0, "127.0.0.1", () => {
        const address = server.address() as AddressInfo
        entry.localAddr = `127.0.0.1:${address.port}`
        resolve(entry)
      })
    })
  }

  private attach(socket: Socket, remote: string, entry: TunnelEntry): void {
    entry.sockets.add(socket)
    let websocket: WebSocket | null = null
    try {
      websocket = new WebSocket(remote)
    } catch {
      socket.destroy()
      return
    }
    entry.websockets.add(websocket)
    websocket.binaryType = "arraybuffer"

    const pending: Uint8Array[] = []
    let opened = false
    socket.pause()

    websocket.onopen = () => {
      opened = true
      for (const chunk of pending.splice(0)) {
        websocket?.send(webSocketPayload(chunk))
      }
      socket.resume()
    }
    websocket.onmessage = (event) => {
      const data = event.data
      const chunk =
        typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data as ArrayBuffer)
      socket.write(chunk)
    }
    websocket.onerror = () => {
      socket.destroy()
    }
    websocket.onclose = () => {
      socket.destroy()
      entry.websockets.delete(websocket as WebSocket)
    }

    socket.on("data", (chunk: Buffer) => {
      if (opened && websocket && websocket.readyState === WebSocket.OPEN) {
        websocket.send(webSocketPayload(chunk))
      } else if (!opened) {
        pending.push(chunk)
      }
    })
    socket.on("close", () => {
      entry.sockets.delete(socket)
      try {
        websocket?.close()
      } catch {
        /* noop */
      }
    })
    socket.on("error", () => {
      try {
        websocket?.close()
      } catch {
        /* noop */
      }
    })
  }

  /** Close every tunnel belonging to a challenge instance. */
  closeByChallenge(challengeId: string): void {
    for (const entry of this.entries.values()) {
      if (entry.challengeId === challengeId) {
        this.closeEntry(entry)
        this.entries.delete(entry.key)
      }
    }
  }

  close(): void {
    if (this.closedFlag) return
    this.closedFlag = true
    for (const entry of this.entries.values()) {
      this.closeEntry(entry)
    }
    this.entries.clear()
  }

  private closeEntry(entry: TunnelEntry): void {
    try {
      entry.server.close()
    } catch {
      /* noop */
    }
    for (const socket of entry.sockets) {
      socket.destroy()
    }
    for (const websocket of entry.websockets) {
      try {
        websocket.close()
      } catch {
        /* noop */
      }
    }
    entry.sockets.clear()
    entry.websockets.clear()
  }
}

// ---------------------------------------------------------------------------
// Project implementation
// ---------------------------------------------------------------------------

interface ProjectState {
  game?: R2SGame
  challenges?: ChallengeSummary[]
  announcements?: Announcement[]
}

export class Ret2ShellProject implements PlatformProject {
  readonly solverSandboxNetwork = "control_plane" as const
  readonly tunnels: TunnelManager
  readonly baseUrl: string
  readonly authHeader: string
  private readonly explicitGameId?: number
  readonly project: { id: string; name: string }
  private gameIdPromise: Promise<number> | null = null
  private state: ProjectState = {}
  private closedFlag = false

  constructor(options: {
    baseUrl: string
    authHeader: string
    gameId?: number
    project: { id: string; name: string }
  }) {
    this.baseUrl = options.baseUrl
    this.authHeader = options.authHeader
    this.explicitGameId = options.gameId
    this.project = options.project
    this.tunnels = new TunnelManager()
  }

  // -- helpers --------------------------------------------------------------

  private assertOpen(): void {
    if (this.closedFlag) {
      throw new R2SError("protocol", "project is closed")
    }
  }

  async request(options: Omit<RequestOptions, "authHeader">): Promise<ResponseData> {
    this.assertOpen()
    return httpRequest(this.baseUrl, { ...options, authHeader: this.authHeader })
  }

  async getJson<T>(
    path: string,
    query?: RequestOptions["query"],
    options: Pick<RequestOptions, "signal" | "timeoutMs"> = {},
  ): Promise<T> {
    const data = await this.request({ path, query, ...options })
    return parseJson<T>(data, path)
  }

  async resolveGameId(): Promise<number> {
    if (this.gameIdPromise) return this.gameIdPromise
    this.gameIdPromise = this.resolveGameIdInner()
    return this.gameIdPromise
  }

  private async resolveGameIdInner(): Promise<number> {
    if (this.explicitGameId !== undefined) return this.explicitGameId

    const fromId = extractGameId(this.project.id, true)
    if (fromId !== undefined) return fromId
    const fromName = extractGameId(this.project.name, false)
    if (fromName !== undefined) return fromName

    // Fall back to matching the game by name in the public game list.
    const list = await this.getJson<[R2SGame[], number]>("/game", {
      page: 1,
      page_size: 200,
    })
    const games = Array.isArray(list) && Array.isArray(list[0]) ? list[0] : []
    if (games.length > 0) {
      const target = `${this.project.name} ${this.project.id}`.trim().toLowerCase()
      const scored = games
        .map((game) => ({ game, score: nameSimilarity(game.name, target) }))
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score)
      const matched = scored[0]
      if (matched) return matched.game.id
    }
    throw new R2SError(
      "config",
      "cannot determine the game id: set gameId (the number from /games/<id>) in the plugin configuration",
    )
  }

  private async fetchGame(): Promise<R2SGame> {
    const gameId = await this.resolveGameId()
    return this.getJson<R2SGame>(`/game/${gameId}`)
  }

  async fetchChallengeList(): Promise<R2SChallenge[]> {
    const gameId = await this.resolveGameId()
    const data = await this.getJson<[R2SChallenge[], number]>(`/game/${gameId}/challenge`)
    const challenges = Array.isArray(data) && Array.isArray(data[0]) ? data[0] : []
    return challenges
  }

  async fetchSolves(): Promise<Set<number>> {
    const gameId = await this.resolveGameId()
    const solves = await this.getJson<{ challenge_id: number }[]>(`/game/${gameId}/solve`)
    const set = new Set<number>()
    for (const solve of Array.isArray(solves) ? solves : []) {
      if (solve && typeof solve.challenge_id === "number") set.add(solve.challenge_id)
    }
    return set
  }

  async fetchAnnouncements(): Promise<R2SNotification[]> {
    const gameId = await this.resolveGameId()
    const data = await this.getJson<R2SNotification[]>(`/game/${gameId}/notification`)
    return Array.isArray(data) ? data : []
  }

  async fetchInstances(signal?: AbortSignal, timeoutMs?: number): Promise<R2SInstance[]> {
    const gameId = await this.resolveGameId()
    const data = await this.getJson<R2SInstance[]>(`/game/${gameId}/instance`, undefined, {
      signal,
      timeoutMs,
    })
    return Array.isArray(data) ? data : []
  }

  private async summaryCache(): Promise<{
    challenges: ChallengeSummary[]
    announcements: Announcement[]
  }> {
    if (!this.state.challenges || !this.state.announcements) {
      const [challenges, solves, notifications] = await Promise.all([
        this.fetchChallengeList(),
        this.fetchSolves(),
        this.fetchAnnouncements(),
      ])
      this.state.challenges = challenges.map((challenge) => mapChallengeSummary(challenge, solves))
      this.state.announcements = notifications.map(mapAnnouncement)
    }
    return {
      challenges: this.state.challenges,
      announcements: this.state.announcements,
    }
  }

  // -- PlatformProject ------------------------------------------------------

  async refresh(): Promise<ContestOverview> {
    this.assertOpen()
    const game = await this.fetchGame()
    this.state.game = game
    const { challenges, announcements } = await this.summaryCache()
    return {
      id: String(game.id),
      name: game.name,
      challenges: challenges.length,
      announcements: announcements.length,
    }
  }

  async getOverview(): Promise<ContestOverview> {
    if (!this.state.game) {
      return this.refresh()
    }
    const { challenges, announcements } = await this.summaryCache()
    return {
      id: String(this.state.game.id),
      name: this.state.game.name,
      challenges: challenges.length,
      announcements: announcements.length,
    }
  }

  async listChallenges(): Promise<ChallengeSummary[]> {
    this.assertOpen()
    const { challenges } = await this.summaryCache()
    return challenges.map((challenge) => ({ ...challenge }))
  }

  async listAnnouncements(): Promise<Announcement[]> {
    this.assertOpen()
    const { announcements } = await this.summaryCache()
    return announcements.map((announcement) => ({ ...announcement }))
  }

  async listRemoteEnvironments(): Promise<RemoteEnvironment[]> {
    this.assertOpen()
    const instances = await this.fetchInstances()
    const result: RemoteEnvironment[] = []
    for (const instance of instances) {
      result.push(await this.toRemoteEnvironment(instance, { proxy: true }))
    }
    return result
  }

  async getRemoteEnvironment(id: string): Promise<RemoteEnvironment | null> {
    this.assertOpen()
    const instances = await this.fetchInstances()
    const instance = instances.find((item) => item.name === id)
    if (!instance) return null
    return this.toRemoteEnvironment(instance, { proxy: true })
  }

  async destroyRemoteEnvironment(id: string): Promise<void> {
    this.assertOpen()
    const instances = await this.fetchInstances()
    const instance = instances.find((item) => item.name === id)
    if (instance) {
      this.tunnels.closeByChallenge(String(instance.challenge_id))
      const gameId = await this.resolveGameId()
      try {
        await this.request({
          path: `/game/${gameId}/challenge/${instance.challenge_id}/instance`,
          method: "DELETE",
        })
      } catch (err) {
        if (
          err instanceof R2SError &&
          (err.code === "not_found" || err.code === "conflict" || err.code === "precondition")
        ) {
          return // already stopped or nothing to stop
        }
        throw err
      }
      return
    }
    // Instance already gone: nothing to destroy.
  }

  async bindChallenge(challengeId: string): Promise<ChallengeCapability> {
    this.assertOpen()
    if (!/^[1-9]\d*$/.test(challengeId)) {
      throw new R2SError("config", `invalid challenge id: ${challengeId}`)
    }
    return new Ret2ShellChallenge(this, challengeId)
  }

  async close(): Promise<void> {
    if (this.closedFlag) return
    this.closedFlag = true
    this.tunnels.close()
    this.state = {}
  }

  // -- environment helpers --------------------------------------------------

  private wsUrlFor(instance: R2SInstance, port: number): string {
    const url = new URL(this.baseUrl)
    const scheme = url.protocol === "https:" ? "wss" : "ws"
    const host = url.host
    const apiPath = apiBaseOf(this.baseUrl).replace(url.origin, "")
    return `${scheme}://${host}${apiPath}/traffic/${encodeURIComponent(instance.traffic)}?port=${port}`
  }

  async toRemoteEnvironment(
    instance: R2SInstance,
    options: { proxy: boolean },
  ): Promise<RemoteEnvironment> {
    const status = mapInstanceStatus(instance.state)
    let endpoint: string | undefined
    const notes: string[] = []

    const exposed = instance.exposed_ports ?? []
    const proxied: string[] = []

    if (options.proxy && instance.ports.length > 0) {
      for (const port of instance.ports) {
        const wsUrl = this.wsUrlFor(instance, port)
        try {
          const local = await this.tunnels.ensure(wsUrl, {
            traffic: instance.traffic,
            port,
            challengeId: String(instance.challenge_id),
          })
          proxied.push(`port ${port}: ${local} (wsrx tunnel ${wsUrl})`)
          if (!endpoint) endpoint = local
        } catch (err) {
          notes.push(
            `port ${port}: wsrx tunnel unavailable (${err instanceof Error ? err.message : String(err)}), raw ${wsUrl}`,
          )
          if (!endpoint) endpoint = wsUrl
        }
      }
    } else if (exposed.length > 0) {
      endpoint = exposed[0]?.address
      for (const item of exposed) {
        notes.push(`${item.name}: ${item.address}`)
      }
    } else {
      const port = instance.ports[0]
      if (port !== undefined) {
        endpoint = this.wsUrlFor(instance, port)
        notes.push(
          "no traffic mapper: environment is reachable over the wsrx WebSocket tunnel only",
        )
      }
    }

    return {
      id: instance.name,
      challengeId: String(instance.challenge_id),
      status,
      endpoint,
    }
  }
}

// ---------------------------------------------------------------------------
// Challenge capability
// ---------------------------------------------------------------------------

class Ret2ShellChallenge implements ChallengeCapability {
  private readonly project: Ret2ShellProject
  private readonly challengeId: string

  constructor(project: Ret2ShellProject, challengeId: string) {
    this.project = project
    this.challengeId = challengeId
  }

  private async gameId(): Promise<number> {
    return this.project.resolveGameId()
  }

  async getInfo(): Promise<ChallengeInfo> {
    const gameId = await this.gameId()
    const path = `/game/${gameId}/challenge/${this.challengeId}`

    const [challenge, files, env, submitStatus] = await Promise.all([
      this.project.getJson<R2SChallenge>(path),
      this.project.getJson<R2SFile[]>(`${path}/file`).catch((err: unknown) => {
        if (err instanceof R2SError && err.code === "not_found") return []
        throw err
      }),
      this.project.getJson<R2SEnv | null>(`${path}/env`).catch((err: unknown) => {
        if (err instanceof R2SError && err.code === "not_found") return null
        throw err
      }),
      this.project.getJson<R2SSolvesStatus>(`${path}/submit`).catch((err: unknown) => {
        if (err instanceof R2SError && (err.code === "not_found" || err.code === "permission")) {
          return { solved: false, solves: 0 }
        }
        throw err
      }),
    ])

    const hasEnv =
      env !== null && env !== undefined && Array.isArray(env.images) && env.images.length > 0

    const attachments: Attachment[] = (Array.isArray(files) ? files : []).map((file) => ({
      id: `${file.folder}:${file.file}`,
      name: file.file,
    }))

    return {
      id: String(challenge.id),
      title: challenge.name,
      category: primaryTag(challenge.tag),
      score: challenge.score,
      solved: submitStatus?.solved === true,
      needsEnv: hasEnv,
      description: challenge.content ?? "",
      attachments,
      environmentGuide: hasEnv ? buildEnvGuide(env, challenge) : undefined,
    }
  }

  async downloadAttachment(
    attachmentId: string,
  ): Promise<{ attachment: Attachment; content: Uint8Array }> {
    const separator = attachmentId.indexOf(":")
    if (separator <= 0) {
      throw new R2SError("config", `invalid attachment id: ${attachmentId}`)
    }
    const folder = attachmentId.slice(0, separator)
    const file = attachmentId.slice(separator + 1)
    if (folder !== "static" && folder !== "mapped") {
      throw new R2SError("config", `attachment ${attachmentId} is not a downloadable player file`)
    }
    const gameId = await this.gameId()
    const data = await this.project.request({
      path: `/game/${gameId}/challenge/${this.challengeId}/file`,
      query: { folder, file },
    })
    const sizeHeader = data.headers.get("content-length")
    const size = sizeHeader ? Number(sizeHeader) : undefined
    return {
      attachment: { id: attachmentId, name: file, size: Number.isFinite(size) ? size : undefined },
      content: data.bytes,
    }
  }

  async submitFlag(flag: string): Promise<FlagSubmission> {
    if (typeof flag !== "string" || flag.trim().length === 0) {
      throw new R2SError("config", "flag must be a non-empty string")
    }
    const gameId = await this.gameId()
    const path = `/game/${gameId}/challenge/${this.challengeId}`

    const statusBefore = await this.project
      .getJson<R2SSolvesStatus>(`${path}/submit`)
      .catch((err: unknown) => {
        if (err instanceof R2SError && err.code === "not_found") return { solved: false, solves: 0 }
        throw err
      })
    if (statusBefore?.solved === true) {
      return {
        status: "already_solved",
        message: "this challenge was already solved",
      }
    }

    const submitted = await this.project.request({
      path: `${path}/submit`,
      method: "POST",
      body: { content: flag },
    })
    const submission = parseJson<R2SSubmission>(submitted, `${path}/submit`)
    const submissionId = submission?.id
    if (typeof submissionId !== "number" || submissionId <= 0) {
      throw new R2SError("protocol", "submission response did not include an id")
    }

    for (let attempt = 0; attempt < SUBMIT_POLL_MAX_TRIES; attempt += 1) {
      await sleep(SUBMIT_POLL_INTERVAL_MS)
      const polled = await this.project.getJson<R2SSubmission>(`${path}/submit`, {
        id: submissionId,
      })
      if (polled && typeof polled.solved === "boolean") {
        if (polled.solved === true) {
          return { status: "accepted", message: polled.result ?? "flag accepted" }
        }
        return { status: "rejected", message: polled.result ?? "flag rejected" }
      }
    }
    throw new R2SError(
      "protocol",
      "timed out waiting for the submission result (the checker did not answer in time)",
    )
  }

  readonly instance = {
    start: async (signal?: AbortSignal): Promise<RemoteEnvironment> => {
      throwIfAborted(signal)
      const challengeId = this.challengeId
      const gameId = await this.gameId()
      const path = `/game/${gameId}/challenge/${challengeId}`
      const deadline = Date.now() + INSTANCE_START_TIMEOUT_MS

      // 1. Reuse an existing instance for this challenge if present.
      let instance = (
        await this.project.fetchInstances(signal, remainingRequestTime(deadline))
      ).find((item) => String(item.challenge_id) === challengeId)

      // 2. Otherwise request one.
      if (!instance) {
        try {
          await this.project.request({
            path: `${path}/instance`,
            method: "POST",
            signal,
            timeoutMs: remainingRequestTime(deadline),
          })
        } catch (err) {
          if (err instanceof R2SError && err.code === "conflict") {
            // already launched concurrently
          } else if (err instanceof R2SError && err.retryable) {
            // The POST may have reached the platform before its response was
            // lost. Re-read once before surfacing the non-idempotent failure.
            try {
              instance = (
                await this.project.fetchInstances(signal, remainingRequestTime(deadline))
              ).find((item) => String(item.challenge_id) === challengeId)
            } catch {
              // Preserve the original start failure and its retryability.
            }
            if (!instance) throw err
          } else {
            throw err
          }
        }
      }

      // 3. Wait until the pod is running.
      while (Date.now() < deadline) {
        throwIfAborted(signal)
        const fresh = (
          await this.project.fetchInstances(signal, remainingRequestTime(deadline))
        ).find((item) => String(item.challenge_id) === challengeId)
        if (fresh) {
          instance = fresh
          if (fresh.state === "Running") {
            return await this.project.toRemoteEnvironment(fresh, { proxy: true })
          }
          if (fresh.state === "Succeeded" || fresh.state === "Failed") {
            throw new R2SError("precondition", `challenge instance entered state ${fresh.state}`)
          }
        }
        await sleep(Math.min(INSTANCE_POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())), signal)
      }
      throwIfAborted(signal)
      throw new R2SError(
        "network",
        instance
          ? `timed out waiting for challenge instance to become ready (last state: ${instance.state})`
          : "challenge instance did not appear before the startup deadline",
      )
    },

    status: async (): Promise<RemoteEnvironment | null> => {
      const challengeId = this.challengeId
      const instance = (await this.project.fetchInstances()).find(
        (item) => String(item.challenge_id) === challengeId,
      )
      if (!instance) return null
      return this.project.toRemoteEnvironment(instance, { proxy: true })
    },

    destroy: async (): Promise<void> => {
      const challengeId = this.challengeId
      const gameId = await this.gameId()
      this.project.tunnels.closeByChallenge(challengeId)
      try {
        await this.project.request({
          path: `/game/${gameId}/challenge/${challengeId}/instance`,
          method: "DELETE",
        })
      } catch (err) {
        if (
          err instanceof R2SError &&
          (err.code === "not_found" || err.code === "conflict" || err.code === "precondition")
        ) {
          return
        }
        throw err
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

function primaryTag(tags: R2STag[] | undefined): string {
  if (!Array.isArray(tags) || tags.length === 0) return "Uncategorized"
  const primary = tags.find((tag) => tag.primary)
  return (primary ?? tags[0])?.name || "Uncategorized"
}

function webSocketPayload(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

function mapChallengeSummary(challenge: R2SChallenge, solves: Set<number>): ChallengeSummary {
  return {
    id: String(challenge.id),
    title: challenge.name,
    category: primaryTag(challenge.tag),
    score: challenge.score,
    solved: solves.has(challenge.id),
  }
}

function mapAnnouncement(notification: R2SNotification): Announcement {
  return {
    id: String(notification.id),
    title: notification.title,
    content: notification.content,
    publishedAt: new Date(notification.published_at * 1000).toISOString(),
    kind: "normal",
  }
}

function mapInstanceStatus(state: string): RemoteEnvironment["status"] {
  if (state === "Running") return "running"
  if (state === "Pending") return "starting"
  return "stopped"
}

function imageProtocol(image: R2SEnvImage): string {
  if (image.app_protocol) return image.app_protocol.toUpperCase()
  if (image.protocol) return image.protocol.toUpperCase()
  if (image.service_type) return image.service_type.toUpperCase()
  return "TCP"
}

function buildEnvGuide(env: R2SEnv, challenge: R2SChallenge): string {
  const lines: string[] = ["Online environment (start an instance to get connection endpoints):"]
  for (const image of env.images) {
    const name = image.name || challenge.name
    const tag = image.tag && image.tag !== "ret.sh.cn/shadowed:latest" ? `:${image.tag}` : ""
    const port = image.port != null ? `, port ${image.port}` : ""
    const desc = image.description ? ` — ${image.description}` : ""
    lines.push(`- ${name}${tag} (${imageProtocol(image)}${port})${desc}`)
  }
  if (env.internet) {
    lines.push("- Internet access: enabled")
  }
  return lines.join("\n")
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("aborted", "AbortError"))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException("aborted", "AbortError"))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

function remainingRequestTime(deadline: number): number {
  return Math.max(1, Math.min(REQUEST_TIMEOUT_MS, deadline - Date.now()))
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason
  return new DOMException("aborted", "AbortError")
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("aborted", "AbortError")
  }
}

function makeAuthHeader(
  config: PluginConfig,
  resolveSecret: (name: string) => string | undefined,
): string {
  if (config.auth.type === "bearer") {
    const token = resolveSecret("R2S_TOKEN")
    if (!token) {
      throw new R2SError("config", "R2S_TOKEN secret is required for bearer auth")
    }
    return `Bearer ${token.trim()}`
  }
  const account = resolveSecret("R2S_ACCOUNT")
  const password = resolveSecret("R2S_PASSWORD")
  if (!account || password === undefined) {
    throw new R2SError("config", "R2S_ACCOUNT and R2S_PASSWORD secrets are required for basic auth")
  }
  return `Basic ${Buffer.from(`${account}:${password}`, "utf8").toString("base64")}`
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const setup = {
  label: "Ret2Shell",
  description: "Connect to a Ret2Shell CTF contest (e.g. https://ctf.xidian.edu.cn).",
  defaultConfig: {
    baseUrl: "https://ctf.xidian.edu.cn",
    auth: { type: "basic" },
  },
  fields: [
    {
      key: "baseUrl",
      label: "Site URL",
      type: "url",
      required: true,
      placeholder: "https://ctf.xidian.edu.cn",
    },
    {
      key: "gameId",
      label: "Game ID (number from /games/<id>; optional if the project id is the game id)",
      type: "integer",
      required: false,
      minimum: 1,
      placeholder: "37",
    },
  ],
  authStrategies: [
    {
      id: "basic",
      label: "Account + password",
      config: { auth: { type: "basic" } },
      secrets: [
        {
          name: "R2S_ACCOUNT",
          label: "Account (login name)",
          type: "text",
          required: true,
        },
        {
          name: "R2S_PASSWORD",
          label: "Password",
          type: "password",
          required: true,
        },
      ],
    },
    {
      id: "bearer",
      label: "Session token (Bearer JWT from the web UI)",
      config: { auth: { type: "bearer" } },
      secrets: [
        {
          name: "R2S_TOKEN",
          label: "Bearer token",
          type: "token",
          required: true,
        },
      ],
    },
  ],
} satisfies PlatformSetupDescriptor

export const platformPlugin: PlatformPlugin = {
  id: "ret2shell",
  setup,
  config: {
    parse(value: unknown): unknown {
      return parseConfig(value)
    },
  },
  async connect(options) {
    const config = parseConfig(options.config)
    const authHeader = makeAuthHeader(config, options.resolveSecret)
    return new Ret2ShellProject({
      baseUrl: config.baseUrl,
      authHeader,
      gameId: config.gameId,
      project: options.project,
    })
  },
}

export const ret2shellPlatform = platformPlugin

export default platformPlugin
