import { join } from "node:path"
import { FATHER_SYSTEM_PROMPT } from "@ctf-agent/prompts"
import type { Sandbox } from "@ctf-agent/sandbox"
import type { AgentMessage, AgentOptions, AgentTool, Skill } from "@earendil-works/pi-agent-core"
import { Type } from "typebox"
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
  onIdentifyPlugin?(input: {
    pluginId: string
    displayName: string
    task: "create" | "repair"
  }): Promise<void>
  onRequestTestAccess?(): Promise<void>
}

/** 全局平台适配 Agent；所有执行工具都绑定到独立 Docker workspace。 */
export class CtfFatherAgent extends BaseAgent {
  readonly id: string
  private readonly sandbox: Sandbox
  private closed = false

  private constructor(options: CreateCtfFatherAgentOptions, prepared: PreparedBaseAgent) {
    super(prepared, { compaction: true })
    this.id = options.sessionId
    this.sandbox = options.sandbox
  }

  static async create(options: CreateCtfFatherAgentOptions): Promise<CtfFatherAgent> {
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
      tools: [...createSandboxTools({ sandbox: options.sandbox }), ...fatherTools(options)],
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

function fatherTools(options: CreateCtfFatherAgentOptions): AgentTool[] {
  return [
    {
      name: "father_identify_plugin",
      label: "Identify Platform Plugin",
      description: "Set the plugin identity once the target platform and task are understood.",
      parameters: Type.Object({
        pluginId: Type.String({ minLength: 3, maxLength: 64 }),
        displayName: Type.String({ minLength: 1, maxLength: 120 }),
        task: Type.Union([Type.Literal("create"), Type.Literal("repair")]),
      }),
      executionMode: "sequential",
      async execute(_id, params) {
        const input = params as {
          pluginId: string
          displayName: string
          task: "create" | "repair"
        }
        await options.onIdentifyPlugin?.(input)
        return {
          content: [{ type: "text", text: JSON.stringify({ updated: true, ...input }) }],
          details: input,
        }
      },
    },
    {
      name: "father_request_test_access",
      label: "Request Test Access",
      description:
        "Request or reuse the user-provided test-site configuration and credentials for the current candidate. Never ask for credentials in chat or shell commands.",
      parameters: Type.Object({}),
      executionMode: "sequential",
      async execute() {
        await options.onRequestTestAccess?.()
        const details = { requested: true, waitingForUser: true }
        return {
          content: [{ type: "text", text: JSON.stringify(details) }],
          details,
        }
      },
    },
  ]
}
