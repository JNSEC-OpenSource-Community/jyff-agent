import { describe, expect, it } from "vitest"
import { classifySolverStop } from "../../src/orchestration/stop-classifier.ts"

describe("classifySolverStop", () => {
  it.each([
    [
      { error: Object.assign(new Error("reset"), { code: "ECONNRESET" }) },
      "network_transient",
    ],
    [
      { error: Object.assign(new Error("refused"), { code: "ECONNREFUSED" }) },
      "network_transient",
    ],
    [
      { error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }) },
      "network_transient",
    ],
    [
      { error: Object.assign(new Error("rate limited"), { status: 429 }) },
      "provider_transient",
    ],
    [
      { error: Object.assign(new Error("gateway"), { statusCode: 503 }) },
      "provider_transient",
    ],
    [
      { error: Object.assign(new Error("overloaded"), { statusCode: 502 }) },
      "provider_transient",
    ],
    [
      { error: Object.assign(new Error("bad key"), { status: 401 }) },
      "authentication_or_configuration",
    ],
    [
      { error: Object.assign(new Error("forbidden"), { status: 403 }) },
      "authentication_or_configuration",
    ],
  ] as const)("classifies structured external failure %#", (input, kind) => {
    expect(classifySolverStop(input)).toMatchObject({
      kind,
      blockDelta: 0,
    })
  })

  it.each([
    [{ error: "socket ECONNRESET" }, "network_transient", true],
    [{ error: "fetch failed" }, "network_transient", true],
    [{ error: "HTTP 502 upstream" }, "provider_transient", true],
    [{ error: "HTTP 503 unavailable" }, "provider_transient", true],
    [{ error: "HTTP 504 gateway timeout" }, "provider_transient", true],
    [{ stopReason: "aborted", error: "Aborted" }, "network_transient", true],
    [{ error: "rate limit exceeded" }, "protocol_or_non_transient", false, 1],
  ])(
    "uses string fallback for %#",
    (input, kind, retryable, blockDelta = 0) => {
      expect(classifySolverStop(input)).toMatchObject({
        kind,
        blockDelta,
        retryable,
      })
    },
  )

  it.each([
    [{ stopReason: "stop" }, "model_stop"],
    [{ stopReason: "length" }, "length"],
    [
      { stopReason: "error", error: new Error("invalid frame") },
      "protocol_or_non_transient",
    ],
    [{ timedOut: true }, "timeout"],
  ] as const)("scores non-transient stop %#", (input, kind) => {
    expect(classifySolverStop(input)).toMatchObject({ kind, blockDelta: 1 })
  })

  it.each([
    [{ submitted: true }, "submitted"],
    [{ operatorCancel: true }, "operator_cancel"],
    [{ processShutdown: true }, "process_shutdown"],
  ] as const)("does not score lifecycle control %#", (input, kind) => {
    expect(classifySolverStop(input)).toMatchObject({
      kind,
      blockDelta: 0,
      retryable: false,
    })
  })
})
