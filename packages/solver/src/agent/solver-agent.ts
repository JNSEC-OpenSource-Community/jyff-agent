import { Agent, type AgentMessage, type AgentOptions, type ThinkingLevel } from "@earendil-works/pi-agent-core"
import type { ChallengeCapability, ChallengeInfo, FlagSubmission } from "@ctf-agent/platform"
import type { Sandbox } from "../sandbox/docker-sandbox.ts"
import type { RunStore } from "../project/run-store.ts"
import { compactMessages, convertSolverMessages, shouldCompact, type CompactionOptions } from "./compaction.ts"
import { buildSkillsCatalog, createLoadSkillTool, type AgentSkill } from "../skills/project-skills.ts"
import { createSolverTools } from "../sandbox/tools.ts"

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
  blackboard?: {
    runStore: RunStore
    challengeId: string
    runId: string
  }
  onClosed?: (details: SolverCloseDetails) => Promise<void> | void
}

export type SolverCloseReason = "submitted" | "manual" | "failed" | "timed_out" | "cancelled"

export interface SolverCloseDetails {
  reason: SolverCloseReason
  error?: string
  cleanupErrors: string[]
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
  private readonly capability: ChallengeCapability
  private readonly onClosed?: (details: SolverCloseDetails) => Promise<void> | void
  private closeReason: SolverCloseReason = "manual"
  private closed = false
  private finalSubmission?: FlagSubmission
  private closing?: Promise<void>
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
        blackboard: options.blackboard,
      }),
      ...(loadSkill ? [loadSkill] : []),
    ]
    const {
      initialState,
      transformContext: inheritedTransform,
      convertToLlm: inheritedConvert,
      prepareNextTurn: inheritedPrepareNextTurn,
      ...agentOptions
    } = options.agent
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
      // 每 turn 边界把 state.thinkingLevel 注入下一轮请求:setThinkingLevel 的
      // 运行中切换即可在当前 run 的下一 turn 生效(agent-loop 把 "off" 转 undefined)。
      prepareNextTurn: async (context) => {
        const inherited = inheritedPrepareNextTurn ? await inheritedPrepareNextTurn(context) : undefined
        return { ...(inherited ?? {}), thinkingLevel: this.state.thinkingLevel }
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
    this.capability = options.capability
    this.sandbox = options.sandbox
    this.onClosed = options.onClosed
    this.compaction = options.features?.compaction === false ? false : (options.features?.compaction ?? {})
    markTerminal = (submission) => {
      this.finalSubmission = submission
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
      if (event.type === "agent_end" && this.finalSubmission) await this.close("submitted")
    })
  }

  static async create(options: CreateCtfSolverAgentOptions): Promise<CtfSolverAgent> {
    return new CtfSolverAgent(options)
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

  /**
   * 运行时切换思考强度:当前 run 的下一 turn 边界生效(prepareNextTurn 包装注入)。
   * 注意:模型 reasoning=false(思考开关关)时档位会被 pi 钳制为 off,开关属于模型级配置。
   */
  setThinkingLevel(level: ThinkingLevel): void {
    this.state.thinkingLevel = level
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

  /**
   * 所有终止路径都先销毁题目远程实例，再删除本地 sandbox。
   * 清理步骤互相独立；某一步失败不会阻止后续步骤或 Run 状态持久化。
   */
  async close(reason: SolverCloseReason = this.closeReason, error?: string): Promise<void> {
    if (this.closing) return this.closing
    if (this.finalSubmission) reason = "submitted"
    this.closed = true
    this.closeReason = reason
    if (this.state.isStreaming) this.abort()
    this.closing = this.performClose(reason, error)
    return this.closing
  }

  private async performClose(reason: SolverCloseReason, error?: string): Promise<void> {
    const cleanupErrors: string[] = []
    if (this.capability.instance) {
      try {
        await this.capability.instance.destroy()
      } catch (cleanupError) {
        cleanupErrors.push(`远程实例销毁失败: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`)
      }
    }
    try {
      await this.sandbox.close()
    } catch (cleanupError) {
      cleanupErrors.push(`Sandbox 关闭失败: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`)
    }

    let persistenceError: unknown
    try {
      await this.onClosed?.({ reason, error, cleanupErrors })
    } catch (closeError) {
      persistenceError = closeError
    }

    if (persistenceError || cleanupErrors.length > 0) {
      throw new AggregateError(
        [...cleanupErrors.map((message) => new Error(message)), ...(persistenceError ? [persistenceError] : [])],
        `Solver ${this.runId} 关闭时发生错误`,
      )
    }
  }
}
