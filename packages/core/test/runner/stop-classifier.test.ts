import { describe, expect, it } from "vitest"
import { classifySolverStop } from "../../src/orchestration/stop-classifier.ts"

describe("classifySolverStop", () => {
  it.each([
    [
      { error: Object.assign(new Error("reset"), { code: "ECONNRESET" }) },
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
      { error: Object.assign(new Error("bad key"), { status: 401 }) },
      "authentication_or_configuration",
    ],
  ] as const)("classifies structured external failure %#", (input, kind) => {
    expect(classifySolverStop(input)).toMatchObject({
      kind,
      blockDelta: 0,
    })
  })

  it("uses bounded string fallback only when structured facts are unavailable", () => {
    expect(classifySolverStop({ error: "socket ECONNRESET" })).toMatchObject({
      kind: "network_transient",
      blockDelta: 0,
      retryable: true,
    })
    expect(classifySolverStop({ error: "HTTP 502 upstream" })).toMatchObject({
      kind: "provider_transient",
      blockDelta: 0,
    })
    expect(
      classifySolverStop({ stopReason: "aborted", error: "Aborted" }),
    ).toMatchObject({
      kind: "network_transient",
      blockDelta: 0,
      retryable: true,
    })
  })

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
