export type SolverStopKind =
  | "network_transient"
  | "provider_transient"
  | "authentication_or_configuration"
  | "model_stop"
  | "length"
  | "protocol_or_non_transient"
  | "operator_cancel"
  | "process_shutdown"
  | "timeout"
  | "submitted"

export interface SolverStopClassification {
  kind: SolverStopKind
  blockDelta: 0 | 1
  retryable: boolean
  requiresConfiguration: boolean
  detail?: string
}

export interface ClassifySolverStopInput {
  stopReason?: string
  error?: unknown
  submitted?: boolean
  operatorCancel?: boolean
  processShutdown?: boolean
  timedOut?: boolean
}

const NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
])

export function classifySolverStop(input: ClassifySolverStopInput): SolverStopClassification {
  if (input.submitted) return classification("submitted", 0, false)
  if (input.operatorCancel) return classification("operator_cancel", 0, false)
  if (input.processShutdown) return classification("process_shutdown", 0, false)
  if (input.timedOut) return classification("timeout", 1, false)

  const facts = errorFacts(input.error)
  // 配额/账单耗尽不会自行恢复。必须在将 HTTP 429 视作短暂限流前识别它们，
  // 否则调度器会持续发起新的请求，既无意义也可能加剧限流。
  if (
    facts.status === 401 ||
    facts.status === 403 ||
    isConfigurationCode(facts.code) ||
    isConfigurationType(facts.type) ||
    isConfigurationFailure(facts.detail)
  ) {
    return classification("authentication_or_configuration", 0, false, facts.detail, true)
  }
  if (facts.code && NETWORK_CODES.has(facts.code)) {
    return classification("network_transient", 0, true, facts.detail)
  }
  if (facts.status === 429 || (facts.status !== undefined && facts.status >= 500)) {
    return classification("provider_transient", 0, true, facts.detail)
  }
  if (facts.retryable === true) {
    return classification("provider_transient", 0, true, facts.detail)
  }

  // Compatibility fallback for providers that have not exposed structured codes.
  if (
    /\b(?:ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT)\b|websocket disconnected|socket disconnected|network error|fetch failed/i.test(
      facts.detail ?? "",
    )
  ) {
    return classification("network_transient", 0, true, facts.detail)
  }
  if (
    input.stopReason === "aborted" ||
    /(?:^|\b)(?:request |operation )?aborted(?:$|\b)/i.test(facts.detail ?? "")
  ) {
    return classification("network_transient", 0, true, facts.detail)
  }
  if (/\b(?:HTTP\s*)?(?:429|5\d\d)\b/i.test(facts.detail ?? "")) {
    return classification("provider_transient", 0, true, facts.detail)
  }
  if (/\b(?:unauthorized|forbidden|invalid api key|authentication)\b/i.test(facts.detail ?? "")) {
    return classification("authentication_or_configuration", 0, false, facts.detail, true)
  }

  if (input.stopReason === "stop") return classification("model_stop", 1, false)
  if (input.stopReason === "length") return classification("length", 1, false)
  return classification("protocol_or_non_transient", 1, false, facts.detail)
}

function classification(
  kind: SolverStopKind,
  blockDelta: 0 | 1,
  retryable: boolean,
  detail?: string,
  requiresConfiguration = false,
): SolverStopClassification {
  return {
    kind,
    blockDelta,
    retryable,
    requiresConfiguration,
    ...(detail ? { detail } : {}),
  }
}

function errorFacts(error: unknown): {
  code?: string
  type?: string
  status?: number
  retryable?: boolean
  detail?: string
} {
  if (error === undefined || error === null) return {}
  if (typeof error !== "object") return { detail: safeString(error) }
  const value = error as Record<string, unknown>
  const statusValue = value.status ?? value.statusCode
  return {
    ...(typeof value.code === "string" ? { code: value.code.toUpperCase() } : {}),
    ...(typeof value.type === "string" ? { type: value.type.toUpperCase() } : {}),
    ...(typeof statusValue === "number" ? { status: statusValue } : {}),
    ...(typeof value.retryable === "boolean" ? { retryable: value.retryable } : {}),
    detail: error instanceof Error ? error.message : safeString(error),
  }
}

function isConfigurationType(type: string | undefined): boolean {
  return type === "FREEUSAGELIMITERROR" || type === "INSUFFICIENTQUOTAERROR"
}

function safeString(value: unknown): string {
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value)
  }
  try {
    return JSON.stringify(value) ?? ""
  } catch {
    return "[unserializable]"
  }
}

function isConfigurationCode(code: string | undefined): boolean {
  return (
    code === "AUTHENTICATION_ERROR" ||
    code === "INVALID_API_KEY" ||
    code === "MODEL_NOT_FOUND" ||
    code === "INVALID_CONFIGURATION" ||
    code === "INSUFFICIENT_QUOTA" ||
    code === "INSUFFICIENT_BALANCE" ||
    code === "BILLING_NOT_ACTIVE" ||
    code === "CREDIT_BALANCE_TOO_LOW"
  )
}

function isConfigurationFailure(detail: string | undefined): boolean {
  return (
    /\b(?:freeusagelimiterror|insufficientquotaerror|insufficient (?:quota|balance|credits?|funds)|(?:(?:current )?quota (?:has been )?exceeded|exceeded (?:your )?(?:current )?quota)|credit balance too low|billing (?:not active|hard limit|limit exceeded))\b/i.test(
      detail ?? "",
    ) || /余额不足|额度不足|配额不足/.test(detail ?? "")
  )
}
