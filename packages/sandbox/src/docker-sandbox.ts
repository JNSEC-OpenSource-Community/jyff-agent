import { type SpawnOptionsWithoutStdio, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"

export interface CommandResult {
  code: number
  stdout: string
  stderr: string
  stdoutTruncated?: boolean
  stderrTruncated?: boolean
}

export interface SandboxExecOptions {
  input?: string
  signal?: AbortSignal
  timeoutMs?: number
  onStdout?: (chunk: string) => void
  onStderr?: (chunk: string) => void
}

export type SandboxCommandErrorCode =
  | "aborted"
  | "timeout"
  | "spawn_error"
  | "callback_error"

export class SandboxCommandError extends Error {
  constructor(
    readonly code: SandboxCommandErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = "SandboxCommandError"
  }
}

export interface Sandbox {
  readonly id: string
  exec(args: string[], options?: SandboxExecOptions): Promise<CommandResult>
  close(): Promise<void>
}

export interface DockerSandboxOptions {
  projectId: string
  runId: string
  image: string
  workspace: string
  workspaceMount?: DockerWorkspaceMount
  privileged: boolean
  networkMode: "none" | "bridge" | "host"
  resources?: Partial<DockerSandboxResources>
}

export interface DockerSandboxResources {
  cpus: number
  memoryBytes: number
  memorySwapBytes: number
  pidsLimit: number
}

export const DEFAULT_DOCKER_SANDBOX_RESOURCES: Readonly<DockerSandboxResources> =
  Object.freeze({
    cpus: 2,
    memoryBytes: 4 * 1024 * 1024 * 1024,
    memorySwapBytes: 4 * 1024 * 1024 * 1024,
    pidsLimit: 512,
  })

export type DockerWorkspaceMount =
  | { type: "bind"; source: string }
  | { type: "volume"; source: string; subpath?: string }

const OUTPUT_LIMIT = 8 * 1024 * 1024

/** Execute Docker directly without involving a host shell. */
async function execute(
  args: string[],
  options: SandboxExecOptions = {},
): Promise<CommandResult> {
  if (options.signal?.aborted) {
    throw new SandboxCommandError("aborted", "Docker command aborted")
  }
  return new Promise((resolve, reject) => {
    const spawnOptions: SpawnOptionsWithoutStdio = {
      stdio: ["pipe", "pipe", "pipe"],
    }
    const child = spawn("docker", args, spawnOptions)
    let stdout = ""
    let stderr = ""
    let stdoutTruncated = false
    let stderrTruncated = false
    let timedOut = false
    let aborted = false
    let callbackError: Error | undefined
    let finished = false
    const timeout =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true
            child.kill("SIGKILL")
          }, options.timeoutMs)
    const abort = () => {
      aborted = true
      child.kill("SIGKILL")
    }
    options.signal?.addEventListener("abort", abort, { once: true })

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString()
      try {
        options.onStdout?.(text)
      } catch (cause) {
        callbackError =
          cause instanceof Error ? cause : new Error(String(cause))
        child.kill("SIGKILL")
      }
      if (stdout.length < OUTPUT_LIMIT)
        stdout += text.slice(0, OUTPUT_LIMIT - stdout.length)
      if (stdout.length >= OUTPUT_LIMIT) stdoutTruncated = true
    })
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString()
      try {
        options.onStderr?.(text)
      } catch (cause) {
        callbackError =
          cause instanceof Error ? cause : new Error(String(cause))
        child.kill("SIGKILL")
      }
      if (stderr.length < OUTPUT_LIMIT)
        stderr += text.slice(0, OUTPUT_LIMIT - stderr.length)
      if (stderr.length >= OUTPUT_LIMIT) stderrTruncated = true
    })
    child.on("error", (cause) =>
      finish(() =>
        reject(
          new SandboxCommandError("spawn_error", cause.message, { cause }),
        ),
      ),
    )
    child.on("close", (code) =>
      finish(() => {
        if (callbackError) {
          return reject(
            new SandboxCommandError("callback_error", callbackError.message, {
              cause: callbackError,
            }),
          )
        }
        if (aborted)
          return reject(
            new SandboxCommandError("aborted", "Docker command aborted"),
          )
        if (timedOut)
          return reject(
            new SandboxCommandError("timeout", "Docker command timed out"),
          )
        resolve({
          code: code ?? 1,
          stdout,
          stderr,
          ...(stdoutTruncated ? { stdoutTruncated: true } : {}),
          ...(stderrTruncated ? { stderrTruncated: true } : {}),
        })
      }),
    )
    child.stdin.on("error", (cause) => {
      if ((cause as NodeJS.ErrnoException).code !== "EPIPE") {
        finish(() =>
          reject(
            new SandboxCommandError("spawn_error", cause.message, { cause }),
          ),
        )
      }
    })
    child.stdin.end(options.input)

    function finish(done: () => void) {
      if (finished) return
      finished = true
      if (timeout) clearTimeout(timeout)
      options.signal?.removeEventListener("abort", abort)
      done()
    }
  })
}

export class DockerSandbox implements Sandbox {
  readonly id: string
  private closed = false
  private closing?: Promise<void>

  private constructor(id: string) {
    this.id = id
  }

  static async create(options: DockerSandboxOptions): Promise<DockerSandbox> {
    const args = dockerSandboxCreateArguments(options)

    const created = await execute(args)
    if (created.code !== 0) throw commandFailure("create", created)
    const id = created.stdout.trim()
    const started = await execute(["start", id])
    if (started.code !== 0) {
      await execute(["rm", "-f", id]).catch(() => undefined)
      throw commandFailure("start", started)
    }
    return new DockerSandbox(id)
  }

  async exec(
    args: string[],
    options?: SandboxExecOptions,
  ): Promise<CommandResult> {
    if (this.closed) throw new Error("Docker sandbox is closed")
    if (args.length === 0)
      throw new Error("Docker exec arguments must not be empty")
    return execute(["exec", "-i", this.id, ...args], options)
  }

  async close(): Promise<void> {
    if (this.closed) return
    if (this.closing) return this.closing
    const operation = (async () => {
      const result = await execute(["rm", "-f", this.id])
      if (result.code !== 0) throw commandFailure("remove", result)
      this.closed = true
    })()
    this.closing = operation
    try {
      await operation
    } finally {
      if (this.closing === operation) this.closing = undefined
    }
  }
}

export function dockerSandboxCreateArguments(
  options: DockerSandboxOptions,
): string[] {
  const name = `ctf-solver-${options.runId}`
  const workspaceMount = dockerMount(
    options.workspaceMount ?? {
      type: "bind",
      source: options.workspace,
    },
  )
  const resources = resolveDockerSandboxResources(options.resources)
  const args = [
    "create",
    "--name",
    name,
    "--label",
    "ctf-agent.managed=true",
    "--label",
    `ctf-agent.project=${options.projectId}`,
    "--label",
    `ctf-agent.run=${options.runId}`,
    "--network",
    options.networkMode,
    "--cpus",
    String(resources.cpus),
    "--memory",
    String(resources.memoryBytes),
    "--memory-swap",
    String(resources.memorySwapBytes),
    "--pids-limit",
    String(resources.pidsLimit),
    "--mount",
    workspaceMount,
  ]
  if (options.privileged) args.push("--privileged")
  args.push(options.image, "sleep", "infinity")
  return args
}

export function newRunId(): string {
  return randomUUID()
}

function commandFailure(operation: string, result: CommandResult): Error {
  const output = [result.stderr.trim(), result.stdout.trim()]
    .filter(Boolean)
    .join("\n")
  return new Error(
    `Docker ${operation} failed: ${output || `exit code ${result.code}`}`,
  )
}

function dockerMount(mount: DockerWorkspaceMount): string {
  if (mount.type === "bind") {
    if (!mount.source || mount.source.includes(","))
      throw new Error("Invalid Docker bind workspace path")
    return `type=bind,src=${mount.source},dst=/workspace`
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(mount.source)) {
    throw new Error("Invalid Docker workspace volume name")
  }
  const fields = ["type=volume", `src=${mount.source}`, "dst=/workspace"]
  if (mount.subpath) {
    const normalized = mount.subpath.replaceAll("\\", "/")
    if (
      normalized.startsWith("/") ||
      normalized
        .split("/")
        .some(
          (segment) =>
            !segment ||
            segment === "." ||
            segment === ".." ||
            segment.includes(","),
        )
    ) {
      throw new Error("Invalid Docker workspace volume subpath")
    }
    fields.push(`volume-subpath=${normalized}`)
  }
  return fields.join(",")
}

function resolveDockerSandboxResources(
  overrides: Partial<DockerSandboxResources> = {},
): DockerSandboxResources {
  const resources = { ...DEFAULT_DOCKER_SANDBOX_RESOURCES, ...overrides }
  positiveFinite(resources.cpus, "resources.cpus")
  positiveInteger(resources.memoryBytes, "resources.memoryBytes")
  positiveInteger(resources.memorySwapBytes, "resources.memorySwapBytes")
  positiveInteger(resources.pidsLimit, "resources.pidsLimit")
  if (resources.memorySwapBytes < resources.memoryBytes) {
    throw new Error(
      "resources.memorySwapBytes must be >= resources.memoryBytes",
    )
  }
  return resources
}

function positiveFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive finite number`)
  }
}

function positiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`)
  }
}
