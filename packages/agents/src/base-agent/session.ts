import {
  type AgentMessage,
  type AgentTool,
  JsonlSessionStorage,
  Session,
  SessionError,
  type ThinkingLevel,
} from "@earendil-works/pi-agent-core"
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node"
import type { Api, Model, Models } from "@earendil-works/pi-ai"
import { DEFAULT_SOLVER_THINKING_LEVEL, isThinkingLevel, resolveThinkingLevel } from "./thinking.ts"

export interface NativeSessionOptions {
  path: string
  id: string
  cwd: string
  metadata?: Record<string, unknown>
}

export interface OpenAgentSessionOptions {
  session: NativeSessionOptions
  models: Models
  model: Model<Api>
  thinkingLevel?: ThinkingLevel
  tools: readonly AgentTool[]
  activeToolNames?: readonly string[]
  initialMessages?: readonly AgentMessage[]
}

export interface OpenedAgentSession {
  session: Session
  model: Model<Api>
  thinkingLevel: ThinkingLevel
  activeToolNames: string[]
  restored: boolean
}

function restoredThinkingLevel(
  value: string,
  fallback: ThinkingLevel,
  model: Model<Api>,
): ThinkingLevel {
  if (!isThinkingLevel(value)) {
    throw new SessionError(
      "invalid_session",
      `Session contains unsupported thinking level: ${value}`,
    )
  }
  return resolveThinkingLevel(model, value || fallback)
}

/** Create a Pi JSONL session, or reopen and restore its persisted runtime settings. */
export async function openAgentSession(
  options: OpenAgentSessionOptions,
): Promise<OpenedAgentSession> {
  const env = new NodeExecutionEnv({ cwd: options.session.cwd })
  const exists = await env.exists(options.session.path)
  if (!exists.ok) throw new SessionError("storage", exists.error.message, exists.error)

  if (!exists.value) {
    const thinkingLevel = resolveThinkingLevel(
      options.model,
      options.thinkingLevel ?? DEFAULT_SOLVER_THINKING_LEVEL,
    )
    const storage = await JsonlSessionStorage.create(env, options.session.path, {
      cwd: options.session.cwd,
      sessionId: options.session.id,
      metadata: options.session.metadata,
    })
    const session = new Session(storage)
    for (const message of options.initialMessages ?? []) await session.appendMessage(message)
    await session.appendModelChange(options.model.provider, options.model.id)
    await session.appendThinkingLevelChange(thinkingLevel)
    await session.appendActiveToolsChange([
      ...(options.activeToolNames ?? options.tools.map((tool) => tool.name)),
    ])
    return {
      session,
      model: options.model,
      thinkingLevel,
      activeToolNames: [...(options.activeToolNames ?? options.tools.map((tool) => tool.name))],
      restored: false,
    }
  }

  const session = new Session(await JsonlSessionStorage.open(env, options.session.path))
  const context = await session.buildContext()
  const model = context.model
    ? options.models.getModel(context.model.provider, context.model.modelId)
    : options.model
  if (!model) {
    throw new SessionError(
      "invalid_session",
      `Session model is unavailable: ${context.model?.provider}/${context.model?.modelId}`,
    )
  }
  const activeToolNames = context.activeToolNames ?? [
    ...(options.activeToolNames ?? options.tools.map((tool) => tool.name)),
  ]
  return {
    session,
    model,
    thinkingLevel: restoredThinkingLevel(
      context.thinkingLevel,
      options.thinkingLevel ?? DEFAULT_SOLVER_THINKING_LEVEL,
      model,
    ),
    activeToolNames,
    restored: true,
  }
}
