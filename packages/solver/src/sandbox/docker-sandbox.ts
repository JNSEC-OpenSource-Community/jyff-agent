import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import type { SpawnOptionsWithoutStdio } from "node:child_process"

export interface CommandResult {
  code: number
  stdout: string
  stderr: string
}

export interface Sandbox {
  readonly id: string
  exec(args: string[], options?: SandboxExecOptions): Promise<CommandResult>
  close(): Promise<void>
}

export interface SandboxExecOptions {
  input?: string
  signal?: AbortSignal
  timeoutMs?: number
  /** 容器内工作目录；仅接受调用方已经验证过的绝对容器路径。 */
  workdir?: string
}

export interface DockerSandboxOptions {
  projectId: string
  runId: string
  image: string
  workspace: string
  workspaceMount?: DockerWorkspaceMount
  privileged: boolean
  networkMode: "none" | "bridge" | "host"
}

export type DockerWorkspaceMount =
  | { type: "bind"; source: string }
  | { type: "volume"; source: string; subpath?: string }

const OUTPUT_LIMIT = 1_000_000

/** 不经宿主 shell 执行 Docker；参数始终以数组传递。 */
async function execute(
  args: string[],
  options: { input?: string; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const spawnOptions: SpawnOptionsWithoutStdio = { stdio: ["pipe", "pipe", "pipe"] }
    const child = spawn("docker", args, spawnOptions)
    let stdout = ""
    let stderr = ""
    let timedOut = false
    let finished = false
    const timeout = options.timeoutMs === undefined ? undefined : setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
    }, options.timeoutMs)
    const abort = () => child.kill("SIGKILL")
    options.signal?.addEventListener("abort", abort, { once: true })

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < OUTPUT_LIMIT) stdout += chunk.toString()
    })
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < OUTPUT_LIMIT) stderr += chunk.toString()
    })
    child.on("error", (error) => finish(() => reject(error)))
    child.on("close", (code) => finish(() => {
      if (timedOut) return reject(new Error("Docker 命令超时"))
      resolve({ code: code ?? 1, stdout, stderr })
    }))
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
    const name = `ctf-solver-${options.runId}`
    const workspaceMount = dockerMount(options.workspaceMount ?? {
      type: "bind",
      source: options.workspace,
    })
    const args = [
      "create",
      "--name", name,
      "--label", "ctf-solver.managed=true",
      "--label", `ctf-solver.project=${options.projectId}`,
      "--label", `ctf-solver.run=${options.runId}`,
      "--network", options.networkMode,
      // 唯一允许的宿主机挂载是当前 Run 的 workspace。
      "--mount", workspaceMount,
    ]
    if (options.privileged) args.push("--privileged")
    args.push(options.image, "sleep", "infinity")

    const created = await execute(args)
    if (created.code !== 0) throw new Error(`无法创建 Docker sandbox: ${created.stderr || created.stdout}`)
    const id = created.stdout.trim()
    const started = await execute(["start", id])
    if (started.code !== 0) {
      await execute(["rm", "-f", id]).catch(() => undefined)
      throw new Error(`无法启动 Docker sandbox: ${started.stderr || started.stdout}`)
    }
    return new DockerSandbox(id)
  }

  async exec(args: string[], options?: SandboxExecOptions): Promise<CommandResult> {
    if (this.closed) throw new Error("Docker sandbox 已关闭")
    if (args.length === 0) throw new Error("Docker exec 参数不能为空")
    const dockerArgs = ["exec", "-i"]
    if (options?.workdir) dockerArgs.push("--workdir", options.workdir)
    dockerArgs.push(this.id, ...args)
    const result = await execute(dockerArgs, options)
    if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `容器命令退出码 ${result.code}`)
    return result
  }

  async close(): Promise<void> {
    if (this.closed) return
    if (this.closing) return this.closing
    const operation = (async () => {
      const result = await execute(["rm", "-f", this.id])
      if (result.code !== 0) {
        throw new Error(`无法删除 Docker sandbox: ${result.stderr.trim() || result.stdout.trim() || `退出码 ${result.code}`}`)
      }
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

export function newRunId(): string {
  return randomUUID()
}

function dockerMount(mount: DockerWorkspaceMount): string {
  if (mount.type === "bind") {
    if (!mount.source || mount.source.includes(",")) {
      throw new Error("Docker bind workspace 路径无效")
    }
    return `type=bind,src=${mount.source},dst=/workspace`
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(mount.source)) {
    throw new Error("Docker workspace volume 名称无效")
  }
  const fields = [`type=volume`, `src=${mount.source}`, "dst=/workspace"]
  if (mount.subpath) {
    const normalized = mount.subpath.replaceAll("\\", "/")
    if (
      normalized.startsWith("/") ||
      normalized.split("/").some((segment) => !segment || segment === "." || segment === ".." || segment.includes(","))
    ) {
      throw new Error("Docker workspace volume subpath 无效")
    }
    fields.push(`volume-subpath=${normalized}`)
  }
  return fields.join(",")
}
