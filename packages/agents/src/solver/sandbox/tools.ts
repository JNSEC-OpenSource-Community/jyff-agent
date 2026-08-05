import type { ChallengeCapability, FlagSubmission } from "@ctf-agent/platform"
import {
  DockerExecutionEnv,
  RtkRewriter,
  type Sandbox,
} from "@ctf-agent/sandbox"
import {
  type AgentHarnessTool,
  type AgentTool,
  type AgentToolResult,
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  type ExecutionToolContext,
} from "@earendil-works/pi-agent-core"
import { type TSchema, Type } from "typebox"

function result(details: object): AgentToolResult<Record<string, unknown>> {
  const value = details as Record<string, unknown>
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    details: value,
  }
}

export interface SolverToolOptions {
  capability: ChallengeCapability
  sandbox: Sandbox
  onTerminalSubmission(submission: FlagSubmission): void
}

export interface SubagentToolOptions {
  sandbox: Sandbox
  cwd: string
}

export interface SandboxToolOptions {
  sandbox: Sandbox
  cwd?: string
}

/** Container-native tools reusable by the main Solver and isolated worker sessions. */
export function createSandboxTools(options: SandboxToolOptions): AgentTool[] {
  const env = new DockerExecutionEnv(options.sandbox, { cwd: options.cwd })
  const context: ExecutionToolContext = { env }
  const rtk = new RtkRewriter(env)
  return [
    bindExecutionTool(createBashTool({ prepare: rtk.prepare() }), context),
    bindExecutionTool(createReadTool(), context),
    bindExecutionTool(createWriteTool(), context),
    bindExecutionTool(createEditTool(), context),
    createListTool(env),
  ]
}

/** Workers share the prepared workspace, but cannot submit or own remote-instance lifecycle. */
export function createSubagentTools(options: SubagentToolOptions): AgentTool[] {
  return createSandboxTools(options)
}

/** Every capability closure is bound to one challenge and one Docker environment. */
export function createSolverTools(options: SolverToolOptions): AgentTool[] {
  const tools: AgentTool[] = [
    ...createSandboxTools(options),
    {
      name: "ctf_submit_flag",
      label: "Submit Flag",
      description: "Submit a flag for the current challenge.",
      parameters: Type.Object({ flag: Type.String({ minLength: 1 }) }),
      executionMode: "sequential",
      async execute(_id, params) {
        const submission = await options.capability.submitFlag(
          (params as { flag: string }).flag,
        )
        const terminal =
          submission.status === "accepted" ||
          submission.status === "already_solved"
        if (terminal) options.onTerminalSubmission(submission)
        return {
          ...result(submission),
          ...(terminal ? { terminate: true } : {}),
        }
      },
    },
  ]

  if (options.capability.instance) {
    const instance = options.capability.instance
    tools.push(
      {
        name: "ctf_instance_start",
        label: "Start Challenge Instance",
        description: "Start the current challenge instance.",
        parameters: Type.Object({}),
        executionMode: "sequential",
        async execute() {
          return result(
            (await instance.start()) as unknown as Record<string, unknown>,
          )
        },
      },
      {
        name: "ctf_instance_status",
        label: "Challenge Instance Status",
        description: "Read the current challenge instance status.",
        parameters: Type.Object({}),
        executionMode: "sequential",
        async execute() {
          return result({ instance: await instance.status() })
        },
      },
      {
        name: "ctf_instance_destroy",
        label: "Destroy Challenge Instance",
        description: "Destroy the current challenge instance.",
        parameters: Type.Object({}),
        executionMode: "sequential",
        async execute() {
          await instance.destroy()
          return result({ destroyed: true })
        },
      },
    )
  }

  return tools
}

function createListTool(env: DockerExecutionEnv): AgentTool {
  return {
    name: "list",
    label: "List Workspace Directory",
    description:
      "List a directory below /workspace. Prefer read when inspecting files.",
    parameters: Type.Object({ path: Type.String() }),
    executionMode: "sequential",
    async execute(_id, params, signal) {
      const listed = await env.listDir(
        (params as { path: string }).path,
        signal,
      )
      if (!listed.ok)
        throw new Error(listed.error.message, { cause: listed.error })
      return result({
        entries: listed.value.map(({ name, kind, size }) => ({
          name,
          type: kind,
          size,
        })),
      })
    },
  }
}

function bindExecutionTool<TParameters extends TSchema, TDetails>(
  tool: AgentHarnessTool<ExecutionToolContext, TParameters, TDetails>,
  context: ExecutionToolContext,
): AgentTool<TParameters, TDetails> {
  return {
    ...tool,
    execute(toolCallId, params, signal, onUpdate) {
      return tool.execute(toolCallId, params, signal, onUpdate, context)
    },
  }
}
