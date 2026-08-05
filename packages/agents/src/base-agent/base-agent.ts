import {
  AgentHarness,
  type AgentHarnessEvent,
  type AgentMessage,
  type AgentTool,
  type CompactResult,
  DEFAULT_COMPACTION_SETTINGS,
  estimateContextTokens,
  formatSkillsForSystemPrompt,
  type NavigateTreeResult,
  type PromptTemplate,
  type Skill,
  shouldCompact,
  type ThinkingLevel,
} from "@earendil-works/pi-agent-core"
import type { Api, ImageContent, Model, Models } from "@earendil-works/pi-ai"
import { type NativeSessionOptions, openAgentSession } from "./session.ts"
import { resolveThinkingLevel } from "./thinking.ts"

export interface BaseAgentOptions {
  session: NativeSessionOptions
  models: Models
  model: Model<Api>
  systemPrompt?: string
  thinkingLevel?: ThinkingLevel
  tools?: readonly AgentTool[]
  activeToolNames?: readonly string[]
  skills?: readonly Skill[]
  promptTemplates?: readonly PromptTemplate[]
  initialMessages?: readonly AgentMessage[]
  compaction?: boolean
  compactionInstructions?: string
  compactionHooks?: CompactionLifecycleHooks
}

export interface PreparedBaseAgent {
  harness: AgentHarness
  session: Awaited<ReturnType<typeof openAgentSession>>["session"]
  sessionPath: string
  restored: boolean
  systemPrompt: string
  messages: AgentMessage[]
}

export interface ContextPressure {
  tokens: number
  contextWindow: number
  reserveTokens: number
  usableContext: number
  shouldCompact: boolean
}

export interface CompactionLifecycleHooks {
  before?: (pressure: ContextPressure) => Promise<void> | void
  after?: (
    result: CompactResult,
    pressure: ContextPressure,
  ) => Promise<void> | void
}

export interface BaseAgentRuntimeOptions {
  /** Retains the legacy prompt-time automatic check until Core owns turn supervision. */
  compaction?: boolean
  compactionInstructions?: string
  compactionHooks?: CompactionLifecycleHooks
}

export async function prepareBaseAgent(
  options: BaseAgentOptions,
): Promise<PreparedBaseAgent> {
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
  const systemPrompt = [
    options.systemPrompt,
    formatSkillsForSystemPrompt(skills),
  ]
    .filter(Boolean)
    .join("\n\n")
  const messages = (await opened.session.buildContext()).messages
  return {
    session: opened.session,
    sessionPath: options.session.path,
    restored: opened.restored,
    systemPrompt,
    messages,
    harness: new AgentHarness({
      session: opened.session,
      models: options.models,
      model: opened.model,
      thinkingLevel: opened.thinkingLevel,
      tools,
      activeToolNames: opened.activeToolNames,
      resources: {
        skills,
        promptTemplates: [...(options.promptTemplates ?? [])],
      },
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
  /** Read-only compatibility snapshot; persisted truth remains `session`. */
  readonly state: {
    systemPrompt: string
    model: Model<Api>
    thinkingLevel: ThinkingLevel
    tools: AgentTool[]
    messages: AgentMessage[]
    isStreaming: boolean
  }
  private readonly autoCompaction: boolean
  private readonly compactionInstructions?: string
  private readonly compactionHooks?: CompactionLifecycleHooks
  private queuedMessages = 0

  protected constructor(
    prepared: PreparedBaseAgent,
    options: BaseAgentRuntimeOptions = {},
  ) {
    this.harness = prepared.harness
    this.session = prepared.session
    this.sessionPath = prepared.sessionPath
    this.restored = prepared.restored
    this.systemPrompt = prepared.systemPrompt
    this.autoCompaction = options.compaction !== false
    this.compactionInstructions = options.compactionInstructions
    this.compactionHooks = options.compactionHooks
    this.state = {
      systemPrompt: prepared.systemPrompt,
      model: prepared.harness.getModel(),
      thinkingLevel: prepared.harness.getThinkingLevel(),
      tools: prepared.harness.getTools() as unknown as AgentTool[],
      messages: [...prepared.messages],
      isStreaming: false,
    }
    this.harness.subscribe((event) => {
      if (event.type === "agent_start") this.state.isStreaming = true
      if (event.type === "message_end") this.state.messages.push(event.message)
      if (event.type === "agent_end") this.state.isStreaming = false
      if (event.type === "thinking_level_update")
        this.state.thinkingLevel = event.level
      if (event.type === "model_update") this.state.model = event.model
      if (event.type === "tools_update")
        this.state.tools = this.harness.getTools() as unknown as AgentTool[]
      if (event.type === "queue_update") {
        this.queuedMessages =
          event.steer.length + event.followUp.length + event.nextTurn.length
      }
    })
  }

  get model(): Model<Api> {
    return this.harness.getModel()
  }
  get thinkingLevel(): ThinkingLevel {
    return this.harness.getThinkingLevel()
  }
  get tools(): AgentTool[] {
    return this.harness.getTools() as unknown as AgentTool[]
  }
  get activeTools(): AgentTool[] {
    return this.harness.getActiveTools() as unknown as AgentTool[]
  }

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
  promptFromTemplate(name: string, args?: string[]) {
    return this.harness.promptFromTemplate(name, args)
  }

  steer(text: string, options?: { images?: ImageContent[] }) {
    return this.harness.steer(text, options)
  }
  followUp(text: string, options?: { images?: ImageContent[] }) {
    return this.harness.followUp(text, options)
  }
  nextTurn(text: string, options?: { images?: ImageContent[] }) {
    return this.harness.nextTurn(text, options)
  }
  /** Route human input according to Pi's queue contract. */
  queueUserMessage(text: string, options?: { images?: ImageContent[] }) {
    return this.state.isStreaming
      ? this.harness.steer(text, options)
      : this.harness.nextTurn(text, options)
  }
  appendMessage(message: AgentMessage) {
    return this.harness.appendMessage(message)
  }
  subscribe(
    listener: (
      event: AgentHarnessEvent,
      signal?: AbortSignal,
    ) => Promise<void> | void,
  ) {
    return this.harness.subscribe(listener)
  }
  async setThinkingLevel(level: ThinkingLevel): Promise<void> {
    await this.harness.setThinkingLevel(resolveThinkingLevel(this.model, level))
  }
  async setModel(model: Model<Api>): Promise<void> {
    await this.harness.setModel(model)
  }
  async setTools(
    tools: AgentTool[],
    activeToolNames?: string[],
  ): Promise<void> {
    await this.harness.setTools(
      tools as unknown as Parameters<AgentHarness["setTools"]>[0],
      activeToolNames,
    )
  }
  async setActiveTools(toolNames: string[]): Promise<void> {
    await this.harness.setActiveTools(toolNames)
  }
  async contextPressure(): Promise<ContextPressure> {
    const messages = await this.getMessages()
    const tokens = estimateContextTokens(messages).tokens
    const contextWindow = this.model.contextWindow
    const reserveTokens = DEFAULT_COMPACTION_SETTINGS.reserveTokens
    const usableContext = contextWindow - reserveTokens
    return {
      tokens,
      contextWindow,
      reserveTokens,
      usableContext,
      shouldCompact:
        usableContext > 0 &&
        shouldCompact(tokens, contextWindow, DEFAULT_COMPACTION_SETTINGS),
    }
  }
  async compact(customInstructions?: string): Promise<CompactResult> {
    const pressure = await this.contextPressure()
    await this.compactionHooks?.before?.(pressure)
    const result = await this.harness.compact(
      customInstructions ?? this.compactionInstructions,
    )
    await this.compactionHooks?.after?.(result, pressure)
    return result
  }
  async navigateTree(
    targetId: string,
    options?: {
      summarize?: boolean
      customInstructions?: string
      replaceInstructions?: boolean
      label?: string
    },
  ): Promise<NavigateTreeResult> {
    return this.harness.navigateTree(targetId, options)
  }
  abort() {
    return this.harness.abort()
  }
  waitForIdle() {
    return this.harness.waitForIdle()
  }
  hasQueuedMessages(): boolean {
    return this.queuedMessages > 0
  }

  private async compactIfNeeded(): Promise<void> {
    if (!this.autoCompaction) return
    const pressure = await this.contextPressure()
    // Pi's defaults assume a context window larger than reserveTokens. A
    // smaller model must still run instead of compacting an empty session.
    if (pressure.shouldCompact) await this.compact()
  }
}
