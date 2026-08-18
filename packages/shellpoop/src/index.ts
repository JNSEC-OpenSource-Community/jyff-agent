import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core"
import { Type } from "typebox"

/**
 * ShellPoop —— 反弹 shell 管理器的 Agent 工具。
 *
 * 工具在控制面宿主进程内执行（与 web-access 一致），通过 ShellPoop 的
 * REST API 创建、查询、执行、读取输出并删除反弹 shell。逆向连接由目标
 * 主机主动连回 ShellPoop 监听的端口，因此前提是目标能访问 ShellPoop 的
 * advertise host:port。
 *
 * 每个 run（一个 challenge 的一次求解）通过 {@link createShellPoopSession}
 * 获得一个独立的会话：会话只记录并允许操作本 run 自己创建的 shell，实现
 * challenge 之间的隔离；run 停止时调用会话的 `close()` 删除本 run 全部
 * shell 以释放端口。创建 shell 时会话把所属 challenge 作为 note 写入服务端
 * 记录，绑定在服务端持久可见（配置 `ShellPoopConfig.challengeId` 时）。
 */
export interface ShellPoopConfig {
  /** ShellPoop REST API 基地址，如 http://127.0.0.1:8000 或 http://shellpoop:8000。 */
  baseUrl: string
  /**
   * ShellPoop 服务 API 密钥。服务端配了 `SHELLPOOP_API_KEY` 时必须携带，
   * 请求会带上 `Authorization: Bearer <apiKey>`；未配置则不发认证头。
   */
  apiKey?: string
  /**
   * 每次请求时解析 API 密钥的延迟闭包（优先于 `apiKey`）。与
   * web-access 的 `resolveSecret` 一致：密钥保存在 SecretStore，改动即时
   * 生效，无需等下一个 run 重建会话。
   */
  resolveApiKey?: () => string | undefined
  /** 单次请求超时（毫秒），默认 15_000。 */
  timeoutMs?: number
  /** run 结束 abort → 取消进行中的请求。 */
  sessionSignal?: AbortSignal
  /**
   * 所属 challenge 标识。创建 shell 时作为 note 写入服务端记录，使 shell
   * 与 challenge 的绑定在服务端持久可见（宿主进程重启后仍可对账）。
   */
  challengeId?: string
}

/**
 * 一次 run 的 ShellPoop 会话。`tools` 已绑定到本 run 的 shell 集合；
 * `close()` 在 run 停止时删除本 run 创建的全部 shell（释放端口）。
 */
export interface ShellPoopSession {
  tools: AgentTool[]
  close(): Promise<void>
}

export interface ShellPoopShell {
  id: string
  endpoint?: string
  connected?: boolean
  peer?: string | null
  note?: string | null
}

const DEFAULT_TIMEOUT_MS = 15_000

/** ShellPoop 反弹 shell 工具名（SubAgent 的 role.tools 白名单按此引用）。 */
export const SHELLPOOP_TOOL_NAMES = [
  "shellpoop_create",
  "shellpoop_list",
  "shellpoop_exec",
  "shellpoop_output",
  "shellpoop_delete",
] as const

function result(details: object): AgentToolResult<Record<string, unknown>> {
  const value = details as Record<string, unknown>
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    details: value,
  }
}

/** 服务端 shell 字典中的反弹 payload 字段，不会出现在任何 Agent 工具结果中。 */
const SHELLPOOP_PAYLOAD_FIELDS = new Set(["connect_command", "payloads"])

/**
 * 从服务端返回的 shell 对象中剔除反弹 payload（connect_command / payloads）：
 * Agent 只需要 id 与 ip:port（endpoint）和连接状态，不需要看到具体的反弹命令。
 */
function withoutPayload(shell: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(shell).filter(([key]) => !SHELLPOOP_PAYLOAD_FIELDS.has(key)),
  )
}

/** 解析当前生效的 API 密钥：优先用延迟闭包（每次请求重新读取），否则用静态值。 */
function apiKeyFor(config: ShellPoopConfig): string | undefined {
  return config.resolveApiKey ? config.resolveApiKey() : config.apiKey
}

async function request(
  baseUrl: string,
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: string },
  timeoutMs: number,
  signal: AbortSignal | undefined,
  apiKey?: string,
): Promise<unknown> {
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  signal?.addEventListener("abort", onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...init.headers,
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    }
    const response = await fetch(`${baseUrl}${path}`, {
      method: init.method ?? "GET",
      headers,
      ...(init.body !== undefined ? { body: init.body } : {}),
      signal: controller.signal,
    })
    const text = await response.text()
    let data: unknown
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = text
    }
    if (!response.ok) {
      const detail = typeof data === "string" ? data : JSON.stringify(data)
      throw new Error(`ShellPoop ${response.status} ${response.statusText}: ${detail}`)
    }
    return data
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", onAbort)
  }
}

/** 无作用域约束地创建工具集（供测试与简单场景使用）。 */
export function createShellPoopTools(config: ShellPoopConfig): AgentTool[] {
  return buildShellPoopTools(config)
}

/**
 * 创建一次 run 的 ShellPoop 会话：工具只允许操作本 run 创建的 shell，
 * `close()` 在 run 停止时删除本 run 全部 shell。
 */
export function createShellPoopSession(config: ShellPoopConfig): ShellPoopSession {
  const owned = new Set<string>()
  const tools = buildShellPoopTools(config, owned)
  return {
    tools,
    async close() {
      await closeOwnedShells(config, owned)
    },
  }
}

async function closeOwnedShells(config: ShellPoopConfig, owned: Set<string>): Promise<void> {
  const baseUrl = config.baseUrl.replace(/\/+$/, "")
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  for (const id of [...owned]) {
    try {
      await request(
        baseUrl,
        `/shell/${encodeURIComponent(id)}`,
        { method: "DELETE" },
        timeoutMs,
        undefined,
        apiKeyFor(config),
      )
    } catch {
      // 尽力而为：单个 shell 删除失败不阻塞 run 关闭。
    }
  }
  owned.clear()
}

function assertOwned(owned: Set<string> | undefined, sessionId: string): void {
  if (owned && !owned.has(sessionId)) {
    throw new Error(
      `Shell ${sessionId} 不属于当前 challenge，只有本 challenge 创建的 shell 才可操作`,
    )
  }
}

function buildShellPoopTools(config: ShellPoopConfig, owned?: Set<string>): AgentTool[] {
  const baseUrl = config.baseUrl.replace(/\/+$/, "")
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const signal = config.sessionSignal

  return [
    {
      name: "shellpoop_create",
      label: "Create Reverse Shell",
      description:
        "Create a new reverse-shell session on the ShellPoop server. Returns the session id and the endpoint (ip:port) the target host should connect back to. Use the returned id for shellpoop_exec / shellpoop_output / shellpoop_delete.",
      parameters: Type.Object({ note: Type.Optional(Type.String()) }),
      executionMode: "sequential",
      async execute(_id, params) {
        // 绑定标识：优先使用会话所属 challenge（服务端持久可见），其次允许
        // Agent 自带 note；两者都为空时保持「无 body」现状以兼容旧版服务。
        const note = config.challengeId ?? (params as { note?: string }).note
        const data = (await request(
          baseUrl,
          "/shell",
          { method: "POST", ...(note ? { body: JSON.stringify({ note }) } : {}) },
          timeoutMs,
          signal,
          apiKeyFor(config),
        )) as Record<string, unknown>
        if (owned && typeof data.id === "string") owned.add(data.id)
        return result(withoutPayload(data))
      },
    },
    {
      name: "shellpoop_list",
      label: "List Reverse Shells",
      description:
        "List the reverse-shell sessions owned by the current challenge, including their connection state, endpoint, and peer host. Use to discover an existing session id or check whether a shell has connected back.",
      parameters: Type.Object({}),
      executionMode: "sequential",
      async execute() {
        const data = (await request(
          baseUrl,
          "/shell",
          { method: "GET" },
          timeoutMs,
          signal,
          apiKeyFor(config),
        )) as { shells?: Array<Record<string, unknown>> }
        const shells = (data.shells ?? []).map(withoutPayload)
        if (!owned) return result({ ...(data as object), shells })
        const ownedShells = shells.filter(
          (shell) => typeof shell.id === "string" && owned.has(shell.id),
        )
        return result({
          ...(data as object),
          shells: ownedShells,
          total: ownedShells.length,
          connected: ownedShells.filter((shell) => shell.connected === true).length,
        })
      },
    },
    {
      name: "shellpoop_exec",
      label: "Execute Command on Reverse Shell",
      description:
        "Send one command to a connected reverse shell owned by the current challenge and wait for its output. Fails (409) if the shell is not connected yet; call shellpoop_list first to confirm connected=true.",
      parameters: Type.Object({
        sessionId: Type.String({ minLength: 1 }),
        cmd: Type.String({ minLength: 1 }),
        timeout: Type.Optional(Type.Number({ minimum: 0.1 })),
      }),
      executionMode: "sequential",
      async execute(_id, params) {
        const { sessionId, cmd, timeout } = params as {
          sessionId: string
          cmd: string
          timeout?: number
        }
        assertOwned(owned, sessionId)
        return result(
          (await request(
            baseUrl,
            `/shell/${encodeURIComponent(sessionId)}/exec`,
            {
              method: "POST",
              body: JSON.stringify({ cmd, timeout: timeout ?? 5 }),
            },
            timeoutMs,
            signal,
            apiKeyFor(config),
          )) as object,
        )
      },
    },
    {
      name: "shellpoop_output",
      label: "Read Reverse Shell Output",
      description:
        "Drain pending output from a reverse shell owned by the current challenge without sending a command (incremental polling for interactive use). Returns only output produced since the last read.",
      parameters: Type.Object({ sessionId: Type.String({ minLength: 1 }) }),
      executionMode: "sequential",
      async execute(_id, params) {
        const { sessionId } = params as { sessionId: string }
        assertOwned(owned, sessionId)
        return result(
          (await request(
            baseUrl,
            `/shell/${encodeURIComponent(sessionId)}/output`,
            { method: "GET" },
            timeoutMs,
            signal,
            apiKeyFor(config),
          )) as object,
        )
      },
    },
    {
      name: "shellpoop_delete",
      label: "Delete Reverse Shell",
      description:
        "Close and delete a reverse-shell session owned by the current challenge, releasing its listening port.",
      parameters: Type.Object({ sessionId: Type.String({ minLength: 1 }) }),
      executionMode: "sequential",
      async execute(_id, params) {
        const { sessionId } = params as { sessionId: string }
        assertOwned(owned, sessionId)
        const data = (await request(
          baseUrl,
          `/shell/${encodeURIComponent(sessionId)}`,
          { method: "DELETE" },
          timeoutMs,
          signal,
          apiKeyFor(config),
        )) as object
        owned?.delete(sessionId)
        return result(data)
      },
    },
  ]
}
