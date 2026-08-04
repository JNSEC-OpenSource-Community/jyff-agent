import {
  AgentHarness,
  DEFAULT_COMPACTION_SETTINGS,
  estimateContextTokens,
  formatSkillsForSystemPrompt,
  shouldCompact,
  type AgentHarnessEvent,
  type AgentMessage,
  type AgentTool,
  type CompactResult,
  type Skill,
  type ThinkingLevel,
} from "@earendil-works/pi-agent-core"
import type { ImageContent, Model, Models } from "@earendil-works/pi-ai"
import { openAgentSession, type NativeSessionOptions } from "./session.ts"

export interface BaseAgentOptions {
  session: NativeSessionOptions
  models: Models
  model: Model<any>
  systemPrompt?: string
  thinkingLevel?: ThinkingLevel
  tools?: readonly AgentTool[]
  activeToolNames?: readonly string[]
  skills?: readonly Skill[]
  initialMessages?: readonly AgentMessage[]
  compaction?: boolean
}

export interface PreparedBaseAgent {
  harness: AgentHarness
  session: Awaited<ReturnType<typeof openAgentSession>>["session"]
  sessionPath: string
  restored: boolean
  systemPrompt: string
}

export async function prepareBaseAgent(options: BaseAgentOptions): Promise<PreparedBaseAgent> {
  const tools = [...(options.tools ?? [])]
  const opened = await openAgentSession({
    session: options.session,
    models: options.models,
    model: options.model,
    thinkingLevel: options.thinkingLevel,
    tools,
    activeToolNames: options.activeToolNames,
    initialMessages: options.initialMessages,
  })
  const skills = [...(options.skills ?? [])]
  const systemPrompt = [options.systemPrompt, formatSkillsForSystemPrompt(skills)].filter(Boolean).join("\n\n")
  return {
    session: opened.session,
    sessionPath: options.session.path,
    restored: opened.restored,
    systemPrompt,
    harness: new AgentHarness({
      session: opened.session,
      models: options.models,
      model: opened.model,
      thinkingLevel: opened.thinkingLevel,
      tools,
      activeToolNames: opened.activeToolNames,
      resources: { skills },
      systemPrompt,
    }),
  }
}

/** Shared Pi lifecycle for concrete agents. Domain agents add capabilities and cleanup only. */
export abstract class BaseAgent {
  readonly sessionPath: string
  readonly restored: boolean
  readonly systemPrompt: string
  protected readonly harness: AgentHarness
  readonly session: PreparedBaseAgent["session"]
  private readonly autoCompaction: boolean

  protected constructor(prepared: PreparedBaseAgent, options: { compaction?: boolean } = {}) {
    this.harness = prepared.harness
    this.session = prepared.session
    this.sessionPath = prepared.sessionPath
    this.restored = prepared.restored
    this.systemPrompt = prepared.systemPrompt
    this.autoCompaction = options.compaction !== false
  }

  get model(): Model<any> { return this.harness.getModel() }
  get thinkingLevel(): ThinkingLevel { return this.harness.getThinkingLevel() }
  get tools(): AgentTool[] { return this.harness.getTools() as unknown as AgentTool[] }

  async getMessages(): Promise<AgentMessage[]> {
    return (await this.session.buildContext()).messages
  }

  async prompt(text: string, options?: { images?: ImageContent[] }) {
    await this.compactIfNeeded()
    return this.harness.prompt(text, options)
  }

  skill(name: string, additionalInstructions?: string) {
    return this.harness.skill(name, additionalInstructions)
  }

  steer(text: string, options?: { images?: ImageContent[] }) { return this.harness.steer(text, options) }
  followUp(text: string, options?: { images?: ImageContent[] }) { return this.harness.followUp(text, options) }
  nextTurn(text: string, options?: { images?: ImageContent[] }) { return this.harness.nextTurn(text, options) }
  appendMessage(message: AgentMessage) { return this.harness.appendMessage(message) }
  subscribe(listener: (event: AgentHarnessEvent, signal?: AbortSignal) => Promise<void> | void) {
    return this.harness.subscribe(listener)
  }
  async setThinkingLevel(level: ThinkingLevel): Promise<void> { await this.harness.setThinkingLevel(level) }
  async setModel(model: Model<any>): Promise<void> { await this.harness.setModel(model) }
  async compact(customInstructions?: string): Promise<CompactResult> { return this.harness.compact(customInstructions) }
  abort() { return this.harness.abort() }
  waitForIdle() { return this.harness.waitForIdle() }

  private async compactIfNeeded(): Promise<void> {
    if (!this.autoCompaction) return
    const messages = await this.getMessages()
    const tokens = estimateContextTokens(messages).tokens
    if (shouldCompact(tokens, this.model.contextWindow, DEFAULT_COMPACTION_SETTINGS)) {
      await this.harness.compact()
    }
  }
}
