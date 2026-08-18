import { join } from "node:path"
import type { ChallengeCapability, ChallengeInfo } from "@ctf-agent/platform"
import { CTF_COMPACTION_PROMPT, subagentTaskContextPrompt } from "@ctf-agent/prompts"
import type { Sandbox } from "@ctf-agent/sandbox"
import type { AgentMessage, AgentOptions, AgentTool, Skill } from "@earendil-works/pi-agent-core"
import type { Api, Model } from "@earendil-works/pi-ai"
import {
  type AgentSkill,
  BaseAgent,
  modelsFromAgentOptions,
  type PreparedBaseAgent,
  prepareBaseAgent,
} from "../base-agent/index.ts"
import { createSubagentTools } from "../solver/sandbox/tools.ts"
import type { SubagentRole } from "./registry.ts"

export interface CreateCtfSubagentOptions {
  projectId: string
  runId: string
  runDirectory: string
  subagentId: string
  containerCwd: string
  challenge: ChallengeInfo
  capability?: ChallengeCapability
  sandbox: Sandbox
  agent: AgentOptions
  role: SubagentRole
  skills?: readonly AgentSkill[]
  /** 可选注入 web-access 工具；role.tools 白名单未包含时不会启用。 */
  webAccessTools?: readonly AgentTool[]
  /** 可选注入 ShellPoop 反弹 shell 工具；role.tools 白名单未包含时不会启用。 */
  shellpoopTools?: readonly AgentTool[]
  compaction?: boolean
}

function piSkills(skills: readonly AgentSkill[]): Skill[] {
  return skills.map((skill) => ({
    name: skill.name,
    description: skill.description,
    content: skill.content,
    filePath: skill.sandboxPath ?? skill.filePath,
  }))
}

/** A non-owning worker: its manager owns lifecycle; the main Solver owns Docker. */
export class CtfSubagent extends BaseAgent {
  readonly id: string
  readonly runId: string
  readonly role: SubagentRole
  readonly containerCwd: string

  private constructor(options: CreateCtfSubagentOptions, prepared: PreparedBaseAgent) {
    super(prepared, {
      compaction: options.compaction !== false,
      compactionInstructions: CTF_COMPACTION_PROMPT,
    })
    this.id = options.subagentId
    this.runId = options.runId
    this.role = options.role
    this.containerCwd = options.containerCwd
  }

  static async create(options: CreateCtfSubagentOptions): Promise<CtfSubagent> {
    const fallbackModel = options.agent.initialState?.model
    if (!fallbackModel) throw new Error("SubAgent 缺少可用模型")
    const models = modelsFromAgentOptions(options.agent, fallbackModel)
    const model = resolveRoleModel(models, fallbackModel, options.role.model)
    const allTools = [
      ...(options.webAccessTools ?? []),
      ...(options.shellpoopTools ?? []),
      ...createSubagentTools({
        sandbox: options.sandbox,
        cwd: options.containerCwd,
        capability: options.capability,
      }),
    ]
    const enabledTools = options.role.tools ? new Set(options.role.tools) : undefined
    const tools = enabledTools ? allTools.filter((tool) => enabledTools.has(tool.name)) : allTools
    if (enabledTools) {
      const known = new Set(allTools.map((tool) => tool.name))
      const unknown = [...enabledTools].filter((name) => !known.has(name))
      if (unknown.length > 0) {
        throw new Error(`SubAgent ${options.role.name} 配置了未知工具: ${unknown.join(", ")}`)
      }
    }
    const prepared = await prepareBaseAgent({
      session: {
        path: join(options.runDirectory, "subagents", options.subagentId, "session.jsonl"),
        id: options.subagentId,
        cwd: options.runDirectory,
        metadata: {
          agentType: "ctf-subagent",
          role: options.role.name,
          projectId: options.projectId,
          runId: options.runId,
          challengeId: options.challenge.id,
          containerCwd: options.containerCwd,
        },
      },
      models,
      model,
      systemPrompt: [
        options.role.systemPrompt,
        subagentTaskContextPrompt({
          title: options.challenge.title,
          id: options.challenge.id,
          category: options.challenge.category,
          score: options.challenge.score,
          containerCwd: options.containerCwd,
        }),
      ].join("\n\n"),
      thinkingLevel: options.role.thinkingLevel,
      tools,
      skills: piSkills(options.skills ?? []),
      compaction: options.compaction !== false,
    })
    return new CtfSubagent(options, prepared)
  }

  transcript(): Promise<AgentMessage[]> {
    return this.getMessages()
  }

  async close(): Promise<void> {
    await this.abort()
    await this.waitForIdle()
  }
}

function resolveRoleModel(
  models: ReturnType<typeof modelsFromAgentOptions>,
  fallback: Model<Api>,
  configured?: string,
): Model<Api> {
  if (!configured) return fallback
  const separator = configured.indexOf("/")
  if (separator < 1 || separator === configured.length - 1) {
    throw new Error(`SubAgent model 必须使用 provider/model 格式: ${configured}`)
  }
  const provider = configured.slice(0, separator)
  const id = configured.slice(separator + 1)
  const model = models.getModel(provider, id)
  if (!model) {
    throw new Error(
      `SubAgent 模型未在当前控制面注册: ${configured}; 当前仅可继承 ${fallback.provider}/${fallback.id}`,
    )
  }
  return model
}
