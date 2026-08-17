import { join } from "node:path"
import type { ChallengeCapability, ChallengeInfo, FlagSubmission } from "@ctf-agent/platform"
import { CTF_COMPACTION_PROMPT, SOLVER_SYSTEM_PROMPT } from "@ctf-agent/prompts"
import type { Sandbox } from "@ctf-agent/sandbox"
import type { AgentMessage, AgentOptions, Skill } from "@earendil-works/pi-agent-core"
import type { Model } from "@earendil-works/pi-ai"
import {
  type AgentSkill,
  BaseAgent,
  DEFAULT_SOLVER_THINKING_LEVEL,
  modelsFromAgentOptions,
  type PreparedBaseAgent,
  prepareBaseAgent,
} from "../../base-agent/index.ts"
import { createSolverTools } from "../sandbox/tools.ts"

export interface SolverIdentity {
  projectId: string
  runId: string
  runDirectory: string
  workspace: string
  challenge: ChallengeInfo
}

export interface CreateCtfSolverAgentOptions {
  identity: SolverIdentity
  capability: ChallengeCapability
  sandbox: Sandbox
  agent: AgentOptions
  features?: {
    skills?: readonly AgentSkill[]
    /** `false` disables BaseAgent's native Pi automatic compaction check. */
    compaction?: boolean
    /** Keep the Solver alive after an accepted flag for the writeup turn. */
    closeOnSubmission?: boolean
  }
  /** Runs before remote-instance and shared-sandbox cleanup (for child workers). */
  onBeforeCleanup?: () => Promise<void> | void
  /** Starts immediately after the first accepted submission, before the writeup turn. */
  onTerminalSubmission?: (submission: FlagSubmission) => Promise<void> | void
  onClosed?: (details: SolverCloseDetails) => Promise<void> | void
}

export type SolverCloseReason =
  | "submitted"
  | "manual"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "interrupted"
  | "blocked"

export interface SolverCloseDetails {
  reason: SolverCloseReason
  error?: string
  cleanupErrors: string[]
}

const FALLBACK_MODEL: Model<"openai-completions"> = {
  id: "unconfigured",
  name: "Unconfigured model",
  api: "openai-completions",
  provider: "unconfigured",
  baseUrl: "http://invalid.local",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4_096,
}

function piSkills(skills: readonly AgentSkill[]): Skill[] {
  return skills.map((skill) => ({
    name: skill.name,
    description: skill.description,
    content: skill.content,
    filePath: skill.sandboxPath ?? skill.filePath,
  }))
}

function unsupportedAgentOptions(options: AgentOptions): string[] {
  return [
    "convertToLlm",
    "transformContext",
    "beforeToolCall",
    "afterToolCall",
    "prepareNextTurn",
    "prepareNextTurnWithContext",
    "onPayload",
    "onResponse",
  ].filter((key) => options[key as keyof AgentOptions] !== undefined)
}

/** CTF capability layer. Pi session/runtime behavior is inherited from BaseAgent. */
export class CtfSolverAgent extends BaseAgent {
  readonly projectId: string
  readonly runId: string
  readonly workspace: string
  readonly challenge: ChallengeInfo
  private readonly sandbox: Sandbox
  private readonly capability: ChallengeCapability
  private readonly onClosed?: (details: SolverCloseDetails) => Promise<void> | void
  private readonly onBeforeCleanup?: () => Promise<void> | void
  private readonly onTerminalSubmission?: (submission: FlagSubmission) => Promise<void> | void
  private readonly closeOnSubmission: boolean
  private closeReason: SolverCloseReason = "manual"
  private closed = false
  private finalSubmission?: FlagSubmission
  private terminalSubmissionCleanup?: Promise<void>
  private terminalSubmissionCleanupError?: unknown
  private closing?: Promise<void>

  private constructor(options: CreateCtfSolverAgentOptions, prepared: PreparedBaseAgent) {
    super(prepared, {
      compaction: options.features?.compaction !== false,
      compactionInstructions: CTF_COMPACTION_PROMPT,
    })
    this.projectId = options.identity.projectId
    this.runId = options.identity.runId
    this.workspace = options.identity.workspace
    this.challenge = options.identity.challenge
    this.capability = options.capability
    this.sandbox = options.sandbox
    this.onClosed = options.onClosed
    this.onBeforeCleanup = options.onBeforeCleanup
    this.onTerminalSubmission = options.onTerminalSubmission
    this.closeOnSubmission = options.features?.closeOnSubmission !== false

    this.subscribe(async (event) => {
      if (
        event.type === "agent_end" &&
        this.finalSubmission &&
        this.closeOnSubmission &&
        !this.closing
      ) {
        this.closed = true
        this.closeReason = "submitted"
        this.closing = this.performClose("submitted", undefined, false)
        await this.closing
      }
    })
  }

  static async create(options: CreateCtfSolverAgentOptions): Promise<CtfSolverAgent> {
    const unsupported = unsupportedAgentOptions(options.agent)
    if (unsupported.length > 0) {
      throw new Error(
        `AgentHarness migration does not support legacy hooks: ${unsupported.join(", ")}`,
      )
    }
    let solver: CtfSolverAgent | undefined
    const tools = [
      ...(options.agent.initialState?.tools ?? []),
      ...createSolverTools({
        capability: options.capability,
        sandbox: options.sandbox,
        onTerminalSubmission: (submission) => solver?.markTerminal(submission),
      }),
    ]
    const model = options.agent.initialState?.model ?? FALLBACK_MODEL
    const prepared = await prepareBaseAgent({
      session: {
        path: join(options.identity.runDirectory, "session.jsonl"),
        id: options.identity.runId,
        cwd: options.identity.runDirectory,
        metadata: {
          agentType: "ctf-solver",
          projectId: options.identity.projectId,
          challengeId: options.identity.challenge.id,
        },
      },
      models: modelsFromAgentOptions(options.agent, model),
      model,
      systemPrompt: options.agent.initialState?.systemPrompt ?? SOLVER_SYSTEM_PROMPT,
      thinkingLevel: options.agent.initialState?.thinkingLevel ?? DEFAULT_SOLVER_THINKING_LEVEL,
      tools,
      skills: piSkills(options.features?.skills ?? []),
      initialMessages: options.agent.initialState?.messages,
      compaction: options.features?.compaction !== false,
    })
    solver = new CtfSolverAgent(options, prepared)
    return solver
  }

  get isClosed(): boolean {
    return this.closed
  }
  get submission(): FlagSubmission | undefined {
    return this.finalSubmission
  }
  get closedReason(): SolverCloseReason | undefined {
    return this.closed ? this.closeReason : undefined
  }

  async prepareWriteup(): Promise<void> {
    await this.terminalSubmissionCleanup
    await this.setActiveTools(["read", "write", "edit", "list"])
  }

  /** Writeup 校验失败时关闭不得被 accepted submission 改回 solved。 */
  discardTerminalSubmissionForWriteupFailure(): void {
    this.finalSubmission = undefined
  }

  /** Compatibility helper for UIs/runners that need a point-in-time transcript. */
  transcript(): Promise<AgentMessage[]> {
    return this.getMessages()
  }

  private markTerminal(submission: FlagSubmission): void {
    if (this.finalSubmission) return
    this.finalSubmission = submission
    this.closeReason = "submitted"
    this.terminalSubmissionCleanup = Promise.resolve()
      .then(() => this.onTerminalSubmission?.(submission))
      .catch((error: unknown) => {
        // Keep the accepted submission authoritative. The cleanup failure is
        // reported from close(), while writeup waits for this attempt to settle.
        this.terminalSubmissionCleanupError = error
      })
  }

  async close(reason: SolverCloseReason = this.closeReason, error?: string): Promise<void> {
    if (this.closing) return this.closing
    if (this.finalSubmission) reason = "submitted"
    this.closed = true
    this.closeReason = reason
    this.closing = this.performClose(reason, error, true)
    return this.closing
  }

  private async performClose(
    reason: SolverCloseReason,
    error: string | undefined,
    waitForRun: boolean,
  ): Promise<void> {
    const cleanupErrors: string[] = []
    await this.terminalSubmissionCleanup
    if (this.terminalSubmissionCleanupError) {
      cleanupErrors.push(`SubAgent 即时回收失败: ${errorText(this.terminalSubmissionCleanupError)}`)
    }
    if (waitForRun) {
      try {
        await this.abort()
      } catch (cleanupError) {
        cleanupErrors.push(
          `Agent 中止失败: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        )
      }
      try {
        await this.waitForIdle()
      } catch (cleanupError) {
        cleanupErrors.push(
          `Agent 等待结束失败: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        )
      }
    }
    try {
      await this.onBeforeCleanup?.()
    } catch (cleanupError) {
      cleanupErrors.push(
        `SubAgent 回收失败: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
      )
    }
    if (this.capability.instance) {
      try {
        await this.capability.instance.destroy()
      } catch (cleanupError) {
        cleanupErrors.push(
          `远程实例销毁失败: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        )
      }
    }
    try {
      await this.sandbox.close()
    } catch (cleanupError) {
      cleanupErrors.push(
        `Sandbox 关闭失败: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
      )
    }

    let persistenceError: unknown
    try {
      await this.onClosed?.({ reason, error, cleanupErrors })
    } catch (closeError) {
      persistenceError = closeError
    }
    if (persistenceError || cleanupErrors.length > 0) {
      throw new AggregateError(
        [
          ...cleanupErrors.map((message) => new Error(message)),
          ...(persistenceError ? [persistenceError] : []),
        ],
        `Solver ${this.runId} 关闭时发生错误`,
      )
    }
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
