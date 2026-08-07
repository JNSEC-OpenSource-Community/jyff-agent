import { ContestSchedulerError } from "@ctf-agent/core"
import type { Context } from "hono"
import type { AppEnv } from "./types.ts"

/** 带状态码与稳定错误码的 HTTP 错误，由全局 onError 中间件统一序列化。 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = "HttpError"
  }
}

/** 跨包错误契约：按 Error 上的 code 字段匹配（不依赖错误类型）。 */
export function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === code
  )
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 全局错误处理：HttpError / ContestSchedulerError 映射为既有错误契约，其余归为 500。 */
export function errorHandler(error: Error, c: Context<AppEnv>): Response {
  if (error instanceof HttpError) {
    return errorResponse(c, error.status, error.code, error.message)
  }
  if (error instanceof ContestSchedulerError) {
    const status =
      error.code === "challenge_not_found" || error.code === "run_not_found"
        ? 404
        : error.code === "unavailable"
          ? 503
          : 409
    return errorResponse(c, status, error.code, error.message)
  }
  console.error("[webui] 未处理的服务端错误：", error)
  return errorResponse(
    c,
    500,
    "internal_error",
    error instanceof Error ? error.message : String(error),
  )
}

function errorResponse(
  _c: Context<AppEnv>,
  status: number,
  code: string,
  message: string,
): Response {
  return new Response(JSON.stringify({ error: code, message }), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  })
}
