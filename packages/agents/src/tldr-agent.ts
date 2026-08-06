import { dirname } from "node:path"
import type { ChallengeInfo } from "@ctf-agent/platform"
import { TLDR_SYSTEM_PROMPT } from "@ctf-agent/prompts"
import type { Sandbox } from "@ctf-agent/sandbox"
import type { AgentMessage, AgentOptions } from "@earendil-works/pi-agent-core"
import {
  BaseAgent,
  modelsFromAgentOptions,
  type PreparedBaseAgent,
  prepareBaseAgent,
} from "./base-agent/index.ts"
import { createReadonlySandboxTools } from "./solver/sandbox/tools.ts"

export interface CreateTldrAgentOptions {
  projectId: string
  challenge: ChallengeInfo
  sessionPath: string
  agent: AgentOptions
  sandbox: Sandbox
  initialMessages?: readonly AgentMessage[]
}

/** Read-only, non-owning summary agent. The caller owns the shared sandbox. */
export class CtfTldrAgent extends BaseAgent {
  readonly projectId: string
  readonly challenge: ChallengeInfo
  readonly sessionPath: string

  private constructor(
    options: CreateTldrAgentOptions,
    prepared: PreparedBaseAgent,
  ) {
    super(prepared, { compaction: true })
    this.projectId = options.projectId
    this.challenge = options.challenge
    this.sessionPath = options.sessionPath
  }

  static async create(options: CreateTldrAgentOptions): Promise<CtfTldrAgent> {
    const model = options.agent.initialState?.model
    if (!model) throw new Error("TLDR Agent 缺少可用模型")
    const prepared = await prepareBaseAgent({
      session: {
        path: options.sessionPath,
        id: `tldr-${options.challenge.id}`,
        cwd: dirname(options.sessionPath),
        metadata: {
          agentType: "ctf-tldr",
          projectId: options.projectId,
          challengeId: options.challenge.id,
        },
      },
      models: modelsFromAgentOptions(options.agent, model),
      model,
      systemPrompt: TLDR_SYSTEM_PROMPT,
      thinkingLevel: "off",
      tools: createReadonlySandboxTools({
        sandbox: options.sandbox,
        cwd: "/workspace",
      }),
      initialMessages:
        options.initialMessages ?? options.agent.initialState?.messages,
      compaction: true,
    })
    return new CtfTldrAgent(options, prepared)
  }

  transcript(): Promise<AgentMessage[]> {
    return this.getMessages()
  }

  async close(): Promise<void> {
    await this.abort()
    await this.waitForIdle()
  }
}
