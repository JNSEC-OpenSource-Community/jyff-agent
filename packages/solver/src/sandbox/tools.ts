import { posix } from "node:path"
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  type AgentHarnessTool,
  type AgentTool,
  type AgentToolResult,
  type ExecutionToolContext,
} from "@earendil-works/pi-agent-core"
import { Type, type TSchema } from "typebox"
import type { ChallengeCapability, FlagSubmission } from "@ctf-agent/platform"
import {
  DockerExecutionEnv,
  RtkRewriter,
  type Sandbox,
} from "@ctf-agent/sandbox"
import type { RunStore } from "../project/run-store.ts"
import { createBlackboardTools } from "../blackboard/index.ts"

function result(details: object): AgentToolResult<Record<string, unknown>> {
  const value = details as Record<string, unknown>
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], details: value }
}

export interface SolverToolOptions {
  capability: ChallengeCapability
  sandbox: Sandbox
  onTerminalSubmission(submission: FlagSubmission): void
  blackboard?: {
    runStore: RunStore
    challengeId: string
    runId: string
  }
}

/** Every capability closure is bound to one challenge and one Docker environment. */
export function createSolverTools(options: SolverToolOptions): AgentTool[] {
  const env = new DockerExecutionEnv(options.sandbox)
  const context: ExecutionToolContext = { env }
  const rtk = new RtkRewriter(env)
  const tools: AgentTool[] = [
    bindExecutionTool(createBashTool({ prepare: rtk.prepare() }), context),
    bindExecutionTool(createReadTool(), context),
    bindExecutionTool(createWriteTool(), context),
    bindExecutionTool(createEditTool(), context),
    {
      name: "list",
      label: "List Workspace Directory",
      description: "List a directory below /workspace. Prefer read when inspecting files.",
      parameters: Type.Object({ path: Type.String() }),
      executionMode: "sequential",
      async execute(_id, params, signal) {
        const listed = await env.listDir((params as { path: string }).path, signal)
        if (!listed.ok) throw new Error(listed.error.message, { cause: listed.error })
        return result({ entries: listed.value.map(({ name, kind, size }) => ({ name, type: kind, size })) })
      },
    },
    {
      name: "ctf_challenge_info",
      label: "Challenge Info",
      description: "Get the current challenge description and attachments.",
      parameters: Type.Object({}),
      executionMode: "sequential",
      async execute() { return result(await options.capability.getInfo()) },
    },
    {
      name: "ctf_download_attachment",
      label: "Download Attachment",
      description: "Download an attachment into the current Docker workspace.",
      parameters: Type.Object({ attachmentId: Type.String() }),
      executionMode: "sequential",
      async execute(_id, params, signal) {
        const { attachmentId } = params as { attachmentId: string }
        const downloaded = await options.capability.downloadAttachment(attachmentId)
        const path = attachmentPath(downloaded.attachment.id, downloaded.attachment.name)
        const saved = await env.writeFile(path, downloaded.content, signal)
        if (!saved.ok) throw new Error(saved.error.message, { cause: saved.error })
        return result({
          attachment: downloaded.attachment,
          path,
          bytes: downloaded.content.byteLength,
        })
      },
    },
    {
      name: "ctf_submit_flag",
      label: "Submit Flag",
      description: "Submit a flag for the current challenge.",
      parameters: Type.Object({ flag: Type.String({ minLength: 1 }) }),
      executionMode: "sequential",
      async execute(_id, params) {
        const submission = await options.capability.submitFlag((params as { flag: string }).flag)
        const terminal = submission.status === "accepted" || submission.status === "already_solved"
        if (terminal) options.onTerminalSubmission(submission)
        return { ...result(submission), ...(terminal ? { terminate: true } : {}) }
      },
    },
  ]

  if (options.capability.instance) {
    const instance = options.capability.instance
    tools.push(
      {
        name: "ctf_instance_start", label: "Start Challenge Instance", description: "Start the current challenge instance.", parameters: Type.Object({}), executionMode: "sequential",
        async execute() { return result(await instance.start() as unknown as Record<string, unknown>) },
      },
      {
        name: "ctf_instance_status", label: "Challenge Instance Status", description: "Read the current challenge instance status.", parameters: Type.Object({}), executionMode: "sequential",
        async execute() { return result({ instance: await instance.status() }) },
      },
      {
        name: "ctf_instance_destroy", label: "Destroy Challenge Instance", description: "Destroy the current challenge instance.", parameters: Type.Object({}), executionMode: "sequential",
        async execute() { await instance.destroy(); return result({ destroyed: true }) },
      },
    )
  }

  if (options.blackboard) {
    tools.push(...createBlackboardTools({
      runStore: options.blackboard.runStore,
      challengeId: options.blackboard.challengeId,
      runId: options.blackboard.runId,
    }))
  }

  return tools
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

function attachmentPath(id: string, name: string): string {
  const safeId = sanitizeSegment(id) || "attachment"
  const basename = sanitizeSegment(posix.basename(name.replaceAll("\\", "/"))) || "download.bin"
  return `attachments/${safeId}/${basename}`
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, "_").replace(/^\.+$/, "").slice(0, 160)
}
