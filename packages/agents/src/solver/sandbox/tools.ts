import { posix } from "node:path"
import type { ChallengeCapability, FlagSubmission } from "@ctf-agent/platform"
import {
  DockerBashExecutionEnv,
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
  onTerminalSubmission(submission: FlagSubmission, flag: string): void
  submissionRateLimiter?: FlagSubmissionRateLimiter
}

export interface SubagentToolOptions {
  sandbox: Sandbox
  cwd: string
  /** Shared run-scoped capability; workers may start/status but never destroy it. */
  capability?: ChallengeCapability
}

export interface SandboxToolOptions {
  sandbox: Sandbox
  cwd?: string
}

export const FLAG_SUBMISSION_WINDOW_MS = 60_000
export const FLAG_SUBMISSION_LIMIT = 5

/** 平台提交额度耗尽时抛出，避免无意义请求继续打到 CTF 平台。 */
export class FlagSubmissionRateLimitError extends Error {
  readonly code = "flag_submission_rate_limited"
  readonly retryAfterMs: number

  constructor(retryAfterMs: number) {
    super(
      `Flag 提交受限：每分钟最多 ${FLAG_SUBMISSION_LIMIT} 次，请在 ${Math.ceil(retryAfterMs / 1_000)} 秒后重试`,
    )
    this.name = "FlagSubmissionRateLimitError"
    this.retryAfterMs = retryAfterMs
  }
}

/** 进程内共享的滑动窗口，记录所有已发起的 Flag 提交。 */
export class FlagSubmissionRateLimiter {
  private timestamps: number[] = []

  constructor(
    private readonly now: () => number = Date.now,
    private readonly limit = FLAG_SUBMISSION_LIMIT,
    private readonly windowMs = FLAG_SUBMISSION_WINDOW_MS,
  ) {}

  acquire(): void {
    const now = this.now()
    this.timestamps = this.timestamps.filter((timestamp) => now - timestamp < this.windowMs)
    const oldestTimestamp = this.timestamps[0]
    if (oldestTimestamp !== undefined && this.timestamps.length >= this.limit) {
      throw new FlagSubmissionRateLimitError(oldestTimestamp + this.windowMs - now)
    }
    this.timestamps.push(now)
  }
}

/** Container-native tools reusable by the main Solver and isolated worker sessions. */
export function createSandboxTools(options: SandboxToolOptions): AgentTool[] {
  const env = new DockerExecutionEnv(options.sandbox, { cwd: options.cwd })
  const context: ExecutionToolContext = { env }
  const rtk = new RtkRewriter(env)
  return [
    bindDynamicExecutionTool(createBashTool({ prepare: rtk.prepare() }), () => ({
      env: new DockerBashExecutionEnv(options.sandbox, { cwd: options.cwd }),
    })),
    bindExecutionTool(createReadTool(), context),
    bindExecutionTool(createWriteTool(), context),
    bindExecutionTool(createEditTool(), context),
    createListTool(env),
  ]
}

/** Workers share the prepared workspace, but cannot submit or own remote-instance lifecycle. */
export function createReadonlySandboxTools(options: SandboxToolOptions): AgentTool[] {
  const env = new DockerExecutionEnv(options.sandbox, { cwd: options.cwd })
  const context: ExecutionToolContext = { env }
  return [bindExecutionTool(createReadTool(), context), createListTool(env)]
}

export function createSubagentTools(options: SubagentToolOptions): AgentTool[] {
  return [
    ...createSandboxTools(options),
    ...(options.capability?.instance
      ? createRemoteEnvironmentTools(options.capability.instance, false)
      : []),
  ]
}

/** Every capability closure is bound to one challenge and one Docker environment. */
export function createSolverTools(options: SolverToolOptions): AgentTool[] {
  const submissionRateLimiter = options.submissionRateLimiter ?? new FlagSubmissionRateLimiter()
  const platformFiles = new DockerExecutionEnv(options.sandbox)
  const tools: AgentTool[] = [
    ...createSandboxTools(options),
    {
      name: "ctf_challenge_info",
      label: "Refresh Challenge Details",
      description:
        "Refresh and return the current challenge details. Use when an announcement says the statement, score, environment guidance, or attachment list changed.",
      parameters: Type.Object({}),
      executionMode: "sequential",
      async execute() {
        return result({
          ...((await options.capability.getInfo()) as unknown as Record<string, unknown>),
          score: undefined,
        })
      },
    },
    {
      name: "ctf_download_attachment",
      label: "Download Challenge Attachment",
      description:
        "Download or refresh one attachment into /workspace/attachments. Use when the challenge attachment list or file content may have been updated; call ctf_challenge_info first to obtain the current attachment ID.",
      parameters: Type.Object({
        attachmentId: Type.String({ minLength: 1 }),
      }),
      executionMode: "sequential",
      async execute(_id, params, signal) {
        const payload = await options.capability.downloadAttachment(
          (params as { attachmentId: string }).attachmentId,
        )
        const path = refreshedAttachmentPath(payload.attachment.name)
        const saved = await platformFiles.replaceFile(path, payload.content, signal)
        if (!saved.ok)
          throw new Error(`无法保存题目附件: ${saved.error.message}`, {
            cause: saved.error,
          })
        return result({
          attachment: payload.attachment,
          path,
          size: payload.content.byteLength,
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
        submissionRateLimiter?.acquire()
        const flag = (params as { flag: string }).flag
        const submission = await options.capability.submitFlag(flag)
        const terminal = submission.status === "accepted" || submission.status === "already_solved"
        if (terminal) options.onTerminalSubmission(submission, flag)
        return {
          ...result(submission),
          ...(terminal ? { terminate: true } : {}),
        }
      },
    },
  ]

  if (options.capability.instance) {
    tools.push(...createRemoteEnvironmentTools(options.capability.instance, true))
  }

  return tools
}

function createRemoteEnvironmentTools(
  instance: NonNullable<ChallengeCapability["instance"]>,
  includeDestroy: boolean,
): AgentTool[] {
  const tools: AgentTool[] = [
    {
      name: "ctf_instance_start",
      label: "Start Challenge Instance",
      description:
        "Start or atomically reopen the current challenge instance. Call once, then wait; concurrent Solver/SubAgent calls share one platform request.",
      parameters: Type.Object({}),
      executionMode: "sequential",
      async execute(_id, _params, signal) {
        return result((await instance.start(signal)) as unknown as Record<string, unknown>)
      },
    },
    {
      name: "ctf_instance_status",
      label: "Challenge Instance Status",
      description:
        "Read the authoritative current instance, endpoint, and expiry. A null result means the old endpoint is invalid and ctf_instance_start may reopen it.",
      parameters: Type.Object({}),
      executionMode: "sequential",
      async execute() {
        return result({ instance: await instance.status() })
      },
    },
  ]
  if (includeDestroy) {
    tools.push({
      name: "ctf_instance_destroy",
      label: "Destroy Challenge Instance",
      description: "Destroy the current challenge instance.",
      parameters: Type.Object({}),
      executionMode: "sequential",
      async execute() {
        await instance.destroy()
        return result({ destroyed: true })
      },
    })
  }
  return tools
}

function refreshedAttachmentPath(name: string): string {
  const basename = posix.basename(name.replaceAll("\\", "/"))
  const safe = basename.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 160)
  return `/workspace/attachments/${safe && !/^\.+$/.test(safe) ? safe : "download.bin"}`
}

function createListTool(env: DockerExecutionEnv): AgentTool {
  return {
    name: "list",
    label: "List Workspace Directory",
    description: "List a directory in the container. Prefer read for files.",
    parameters: Type.Object({ path: Type.String() }),
    executionMode: "sequential",
    async execute(_id, params, signal) {
      const listed = await env.listDir((params as { path: string }).path, signal)
      if (!listed.ok) throw new Error(listed.error.message, { cause: listed.error })
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

function bindDynamicExecutionTool<TParameters extends TSchema, TDetails>(
  tool: AgentHarnessTool<ExecutionToolContext, TParameters, TDetails>,
  context: () => ExecutionToolContext,
): AgentTool<TParameters, TDetails> {
  return {
    ...tool,
    execute(toolCallId, params, signal, onUpdate) {
      return tool.execute(toolCallId, params, signal, onUpdate, context())
    },
  }
}
