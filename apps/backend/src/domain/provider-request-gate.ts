import { classifySolverStop } from "@ctf-agent/core"
import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  createAssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai"

export const DEFAULT_PROVIDER_REQUEST_INTERVAL_MS = 2_000
export const DEFAULT_PROVIDER_TRANSIENT_COOLDOWN_MS = 15_000

export interface ProviderRequestGateOptions {
  minimumIntervalMs?: number
  transientCooldownMs?: number
}

export type ProviderStream = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream

interface ProviderState {
  nextAllowedAt: number
}

/** Shared start pacing and transient-failure cooldown keyed by model provider. */
export class ProviderRequestGate {
  private readonly states = new Map<string, ProviderState>()
  private readonly minimumIntervalMs: number
  private readonly transientCooldownMs: number

  constructor(options: ProviderRequestGateOptions = {}) {
    this.minimumIntervalMs = duration(
      options.minimumIntervalMs ?? DEFAULT_PROVIDER_REQUEST_INTERVAL_MS,
      "minimumIntervalMs",
    )
    this.transientCooldownMs = duration(
      options.transientCooldownMs ?? DEFAULT_PROVIDER_TRANSIENT_COOLDOWN_MS,
      "transientCooldownMs",
    )
  }

  async acquire(provider: string, signal?: AbortSignal): Promise<void> {
    const state = this.state(provider)
    while (true) {
      throwIfAborted(signal)
      const now = Date.now()
      if (now >= state.nextAllowedAt) {
        state.nextAllowedAt = now + this.minimumIntervalMs
        return
      }
      await waitForDelay(state.nextAllowedAt - now, signal)
    }
  }

  observeResult(provider: string, message: AssistantMessage): void {
    const classification = classifySolverStop({
      stopReason: message.stopReason,
      ...(message.errorMessage ? { error: message.errorMessage } : {}),
    })
    if (classification.kind === "provider_transient") this.defer(provider)
  }

  observeError(provider: string, error: unknown): void {
    const classification = classifySolverStop({ stopReason: "error", error })
    if (classification.kind === "provider_transient") this.defer(provider)
  }

  private defer(provider: string): void {
    const state = this.state(provider)
    state.nextAllowedAt = Math.max(state.nextAllowedAt, Date.now() + this.transientCooldownMs)
  }

  private state(provider: string): ProviderState {
    const existing = this.states.get(provider)
    if (existing) return existing
    const state = { nextAllowedAt: 0 }
    this.states.set(provider, state)
    return state
  }
}

export function gateProviderStream(
  gate: ProviderRequestGate,
  source: ProviderStream,
): ProviderStream {
  return (model, context, options) => {
    const output = createAssistantMessageEventStream()
    void (async () => {
      try {
        await gate.acquire(model.provider, options?.signal)
        const upstream = source(model, context, options)
        for await (const event of upstream) output.push(event)
        const message = await upstream.result()
        gate.observeResult(model.provider, message)
        output.end(message)
      } catch (error) {
        const aborted = options?.signal?.aborted === true || isAbortError(error)
        if (!aborted) gate.observeError(model.provider, error)
        const message = failureMessage(model, error, aborted)
        output.push({
          type: "error",
          reason: aborted ? "aborted" : "error",
          error: message,
        })
        output.end(message)
      }
    })()
    return output
  }
}

function failureMessage(model: Model<Api>, error: unknown, aborted: boolean): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: aborted ? "aborted" : "error",
    errorMessage: error instanceof Error ? error.message : String(error),
    timestamp: Date.now(),
  }
}

function duration(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} 必须是非负有限数`)
  return value
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal)
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException("aborted", "AbortError")
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError"
}

async function waitForDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(finish, delayMs)
    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      reject(signal ? abortReason(signal) : new DOMException("aborted", "AbortError"))
    }
    function finish() {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}
