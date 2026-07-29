import { Agent, type AgentMessage, type AgentOptions } from "@earendil-works/pi-agent-core"
import type { ChallengeCapability, ChallengeInfo, FlagSubmission } from "./platform.ts"
import type { Sandbox } from "./sandbox.ts"
import { compactMessages, convertSolverMessages, shouldCompact, type CompactionOptions } from "./compaction.ts"
import { buildSkillsCatalog, createLoadSkillTool, type AgentSkill } from "./skills.ts"
import { createSolverTools } from "./tools.ts"

export interface SolverIdentity {
  projectId: string
  runId: string
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
    compaction?: false | CompactionOptions
  }
  onClosed?: (reason: "submitted" | "manual") => Promise<void> | void
}

/**
 * Pi Agent 的直接子类：原生 prompt/continue/steer/followUp 等 API 均不改变。
 * Project 负责在创建前准备 capability、workspace 和 Docker sandbox。
 */
export class CtfSolverAgent extends Agent {
  readonly projectId: string
  readonly runId: string
  readonly workspace: string
  readonly challenge: ChallengeInfo
  private readonly sandbox: Sandbox
  private readonly onClosed?: (reason: "submitted" | "manual") => Promise<void> | void
  private closeReason: "submitted" | "manual" = "manual"
  private closed = false
  private terminalSubmission = false
  private readonly compaction: CompactionOptions | false
  private compacting?: Promise<AgentMessage[] | undefined>

  private constructor(options: CreateCtfSolverAgentOptions) {
    // 派生类在 super() 前不能访问 this；callback 会在构造结束后才可能被工具调用。
    let markTerminal: (submission: FlagSubmission) => void = () => {
      throw new Error("Solver Agent 尚未完成初始化")
    }
    let autoCompact: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]> = async (messages) => messages
    const skills = options.features?.skills ?? []
    const loadSkill = createLoadSkillTool(skills)
    const tools = [
      ...createSolverTools({
        capability: options.capability,
        sandbox: options.sandbox,
        onTerminalSubmission: (submission) => markTerminal(submission),
      }),
      ...(loadSkill ? [loadSkill] : []),
    ]
    const { initialState, transformContext: inheritedTransform, convertToLlm: inheritedConvert, ...agentOptions } = options.agent
    const catalog = buildSkillsCatalog(skills)
    super({
      ...agentOptions,
      convertToLlm: async (messages) => {
        const converted = convertSolverMessages(messages)
        return inheritedConvert ? inheritedConvert(converted) : converted
      },
      transformContext: async (messages, signal) => {
        const compacted = await autoCompact(messages, signal)
        return inheritedTransform ? inheritedTransform(compacted, signal) : compacted
      },
      initialState: {
        ...initialState,
        systemPrompt: [initialState?.systemPrompt, catalog].filter(Boolean).join("\n\n"),
        tools,
      },
    })
    this.projectId = options.identity.projectId
    this.runId = options.identity.runId
    this.workspace = options.identity.workspace
    this.challenge = options.identity.challenge
    this.sandbox = options.sandbox
    this.onClosed = options.onClosed
    this.compaction = options.features?.compaction === false ? false : (options.features?.compaction ?? {})
    markTerminal = () => {
      this.terminalSubmission = true
      this.closeReason = "submitted"
    }
    autoCompact = async (messages, signal) => {
      if (this.compaction === false || !shouldCompact({ ...this.state, messages }, this.compaction)) return messages
      if (this.compacting) return (await this.compacting) ?? messages
      const operation = compactMessages({ ...this.state, messages }, this.compaction, signal)
      this.compacting = operation
      try {
        const compacted = await operation
        if (compacted) this.state.messages = compacted
        return compacted ?? messages
      } finally {
        if (this.compacting === operation) this.compacting = undefined
      }
    }

    this.subscribe(async (event) => {
      // accepted / already_solved 后在本轮工具都完成后清理容器，workspace 保留。
      if (event.type === "agent_end" && this.terminalSubmission) await this.close()
    })
  }

  static async create(options: CreateCtfSolverAgentOptions): Promise<CtfSolverAgent> {
    return new CtfSolverAgent(options)
  }

  get isClosed(): boolean {
    return this.closed
  }

  /** 手动压缩会先中断当前推理，确保不会在进行中的 tool turn 中改写 transcript。 */
  async compact(customInstructions?: string): Promise<AgentMessage[] | undefined> {
    if (this.compaction === false) return undefined
    if (this.state.isStreaming) {
      this.abort()
      await this.waitForIdle()
    }
    const compacted = await compactMessages(this.state, this.compaction, undefined, customInstructions, true)
    if (compacted) this.state.messages = compacted
    return compacted
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.sandbox.close()
    await this.onClosed?.(this.closeReason)
  }
}
