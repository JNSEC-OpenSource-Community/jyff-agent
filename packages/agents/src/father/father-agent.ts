import { join } from "node:path"
import { FATHER_SYSTEM_PROMPT } from "@ctf-agent/prompts"
import type { Sandbox } from "@ctf-agent/sandbox"
import type {
  AgentMessage,
  AgentOptions,
  Skill,
} from "@earendil-works/pi-agent-core"
import {
  BaseAgent,
  modelsFromAgentOptions,
  type PreparedBaseAgent,
  prepareBaseAgent,
} from "../base-agent/index.ts"
import { createSandboxTools } from "../solver/sandbox/tools.ts"

export interface CreateCtfFatherAgentOptions {
  sessionId: string
  sessionDirectory: string
  sandbox: Sandbox
  agent: AgentOptions
  skills?: readonly Skill[]
}

/** 全局平台适配 Agent；所有执行工具都绑定到独立 Docker workspace。 */
export class CtfFatherAgent extends BaseAgent {
  readonly id: string
  private readonly sandbox: Sandbox
  private closed = false

  private constructor(
    options: CreateCtfFatherAgentOptions,
    prepared: PreparedBaseAgent,
  ) {
    super(prepared, { compaction: true })
    this.id = options.sessionId
    this.sandbox = options.sandbox
  }

  static async create(
    options: CreateCtfFatherAgentOptions,
  ): Promise<CtfFatherAgent> {
    const model = options.agent.initialState?.model
    if (!model) throw new Error("Clanker Father 缺少可用模型")
    const prepared = await prepareBaseAgent({
      session: {
        path: join(options.sessionDirectory, "session.jsonl"),
        id: options.sessionId,
        cwd: options.sessionDirectory,
        metadata: { agentType: "ctf-father", sessionId: options.sessionId },
      },
      models: modelsFromAgentOptions(options.agent, model),
      model,
      systemPrompt: FATHER_SYSTEM_PROMPT,
      thinkingLevel: options.agent.initialState?.thinkingLevel,
      tools: createSandboxTools({ sandbox: options.sandbox }),
      skills: options.skills,
      compaction: true,
    })
    return new CtfFatherAgent(options, prepared)
  }

  transcript(): Promise<AgentMessage[]> {
    return this.getMessages()
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.abort()
    await this.waitForIdle()
    await this.sandbox.close()
  }
}
