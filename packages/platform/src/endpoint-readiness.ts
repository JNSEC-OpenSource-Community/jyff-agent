import { connect as connectTcp } from "node:net"
import { connect as connectTls } from "node:tls"

export interface EndpointReadinessOptions {
  timeoutMs?: number
  retryDelayMs?: number
}

const DEFAULT_TIMEOUT_MS = 90_000
const DEFAULT_RETRY_DELAY_MS = 1_000
const ATTEMPT_TIMEOUT_MS = 5_000

/**
 * Wait for the endpoint transport to accept its own protocol. HTTP(S) must
 * return a non-5xx response; non-HTTP endpoints must accept a TCP/TLS
 * connection. Platform adapters may implement a stronger challenge-specific
 * handshake instead of using this helper.
 */
export async function waitForEndpointReachable(
  endpoint: string,
  signal?: AbortSignal,
  options: EndpointReadinessOptions = {},
): Promise<void> {
  const timeoutMs = positiveDuration(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "readiness timeout")
  const retryDelayMs = positiveDuration(
    options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
    "readiness retry delay",
  )
  const timeout = AbortSignal.timeout(timeoutMs)
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
  let lastError: unknown

  while (!combined.aborted) {
    try {
      await probeEndpoint(endpoint, combined)
      return
    } catch (error) {
      if (combined.aborted) break
      lastError = error
      await delay(retryDelayMs, combined)
    }
  }

  if (signal?.aborted) throw signal.reason
  throw Object.assign(
    new Error(
      `远程环境 endpoint 在 ${timeoutMs}ms 内未就绪${lastError instanceof Error ? `: ${lastError.message}` : ""}`,
    ),
    { name: "RemoteEnvironmentReadinessTimeoutError", code: "ETIMEDOUT", retryable: true },
  )
}

async function probeEndpoint(endpoint: string, signal: AbortSignal): Promise<void> {
  const target = parseEndpoint(endpoint)
  if ("url" in target) {
    const attempt = AbortSignal.timeout(ATTEMPT_TIMEOUT_MS)
    const response = await fetch(target.url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.any([signal, attempt]),
    })
    await response.body?.cancel().catch(() => undefined)
    if (response.status >= 500) throw new Error(`HTTP ${response.status}`)
    return
  }
  await connectSocket(target.host, target.port, target.secure, signal)
}

function parseEndpoint(
  endpoint: string,
):
  | { protocol: "http:" | "https:"; url: string }
  | { protocol: "tcp:"; host: string; port: number; secure: boolean } {
  const value = endpoint.trim()
  if (!value) throw new Error("远程环境 endpoint 为空")

  try {
    const url = new URL(value)
    if (url.protocol === "http:" || url.protocol === "https:") {
      return { protocol: url.protocol, url: url.toString() }
    }
    const port = Number(url.port || defaultPort(url.protocol))
    if (!url.hostname || !validPort(port)) throw new Error("endpoint 缺少 host 或 port")
    return {
      protocol: "tcp:",
      host: url.hostname,
      port,
      secure: url.protocol === "tls:" || url.protocol === "wss:",
    }
  } catch (error) {
    if (value.includes("://")) throw error
  }

  const ipv6 = /^\[([^\]]+)]:(\d+)$/.exec(value)
  const hostPort = /^([^:\s]+):(\d+)$/.exec(value)
  const match = ipv6 ?? hostPort
  const host = match?.[1]
  const port = Number(match?.[2])
  if (!host || !validPort(port)) throw new Error("无法识别远程环境 endpoint")
  return { protocol: "tcp:", host, port, secure: false }
}

async function connectSocket(
  host: string,
  port: number,
  secure: boolean,
  signal: AbortSignal,
): Promise<void> {
  const attempt = AbortSignal.timeout(ATTEMPT_TIMEOUT_MS)
  const combined = AbortSignal.any([signal, attempt])
  await new Promise<void>((resolve, reject) => {
    const socket = secure
      ? connectTls({ host, port, rejectUnauthorized: false })
      : connectTcp({ host, port })
    const cleanup = () => {
      combined.removeEventListener("abort", onAbort)
      socket.removeAllListeners()
    }
    const fail = (error: unknown) => {
      cleanup()
      socket.destroy()
      reject(error)
    }
    const ready = () => {
      cleanup()
      socket.destroy()
      resolve()
    }
    const onAbort = () => fail(combined.reason)
    combined.addEventListener("abort", onAbort, { once: true })
    socket.once(secure ? "secureConnect" : "connect", ready)
    socket.once("error", fail)
  })
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    const onAbort = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
      reject(signal.reason)
    }
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

function defaultPort(protocol: string): number {
  if (protocol === "http:" || protocol === "ws:") return 80
  if (protocol === "https:" || protocol === "wss:" || protocol === "tls:") return 443
  if (protocol === "ssh:") return 22
  return 0
}

function validPort(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= 65_535
}

function positiveDuration(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${label} 必须是正整数`)
  return value
}
