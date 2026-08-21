import { Buffer } from "node:buffer"
import { randomUUID } from "node:crypto"
import { posix } from "node:path"
import {
  type ExecutionEnv,
  ExecutionError,
  err,
  FileError,
  type FileErrorCode,
  type FileInfo,
  ok,
  type Result,
  type ShellExecOptions,
} from "@earendil-works/pi-agent-core"
import { type CommandResult, type Sandbox, SandboxCommandError } from "./docker-sandbox.ts"

const WORKSPACE = "/workspace"
const MAX_TIMER_MS = 2_147_483_647
const BASH_CAPTURE_FLUSH_BYTES = 512 * 1024
const FILE_HELPER_MAX_ATTEMPTS = 3
const COMMAND_TIMEOUT_MARKER = "__CTF_AGENT_COMMAND_TIMED_OUT__"
const COMMAND_TIMEOUT_GRACE_MS = 5_000
// V8 字符串最长 0x1fffffe8（536,870,888）字符，base64 膨胀 4/3：一次性给超过
// ~384 MiB 的内容做 toString("base64") 会抛 "Cannot create a string longer than
// 0x1fffffe8 characters"。超过该块大小的内容分多次 helper 调用传输。
export const FILE_TRANSFER_CHUNK_BYTES = 32 * 1024 * 1024
// 大附件哈希比对可能要读多个 GB，放宽到 120s。
const FILE_HASH_TIMEOUT_MS = 120_000

const FILE_HELPER = String.raw`
import base64, hashlib, json, os, shutil, stat, sys, uuid
from pathlib import Path

def addressed(raw):
    if not isinstance(raw, str) or not raw.startswith('/') or '\\' in raw:
        raise ValueError('path must be an absolute POSIX path')
    return Path(os.path.normpath(raw))

def resolved_file(raw):
    return addressed(raw).resolve()

def info(path):
    value = path.lstat()
    kind = 'symlink' if stat.S_ISLNK(value.st_mode) else ('directory' if stat.S_ISDIR(value.st_mode) else 'file')
    return {
        'name': path.name,
        'path': str(path),
        'kind': kind,
        'size': value.st_size,
        'mtimeMs': value.st_mtime * 1000,
    }

def fail(error, raw):
    if isinstance(error, FileNotFoundError): code = 'not_found'
    elif isinstance(error, PermissionError): code = 'permission_denied'
    elif isinstance(error, NotADirectoryError): code = 'not_directory'
    elif isinstance(error, IsADirectoryError): code = 'is_directory'
    elif isinstance(error, (ValueError, TypeError)): code = 'invalid'
    elif isinstance(error, NotImplementedError): code = 'not_supported'
    else: code = 'unknown'
    print(json.dumps({'ok': False, 'code': code, 'message': str(error), 'path': raw}))

payload = json.loads(sys.stdin.read())
raw = payload.get('path')
try:
    op = payload['op']
    if op == 'read_text':
        path = resolved_file(raw)
        if not path.is_file(): raise ValueError('path is not a regular file')
        text = path.read_text(encoding='utf-8')
        max_lines = payload.get('maxLines')
        value = text.splitlines()[:max_lines] if isinstance(max_lines, int) else text
    elif op == 'read_binary':
        path = resolved_file(raw)
        if not path.is_file(): raise ValueError('path is not a regular file')
        value = base64.b64encode(path.read_bytes()).decode('ascii')
    elif op == 'sha256':
        path = resolved_file(raw)
        if not path.is_file(): raise ValueError('path is not a regular file')
        digest = hashlib.sha256()
        with path.open('rb') as source:
            for block in iter(lambda: source.read(1024 * 1024), b''):
                digest.update(block)
        value = digest.hexdigest()
    elif op in ('write', 'append'):
        path = addressed(raw)
        path.parent.mkdir(parents=True, exist_ok=True)
        resolved = path.resolve()
        data = base64.b64decode(payload['base64'], validate=True)
        with resolved.open('ab' if op == 'append' else 'wb') as output:
            output.write(data)
        value = None
    elif op == 'replace':
        path = addressed(raw)
        path.parent.mkdir(parents=True, exist_ok=True)
        resolved = path.resolve()
        temporary = resolved.with_name(f'.{resolved.name}.{uuid.uuid4().hex}.tmp')
        data = base64.b64decode(payload['base64'], validate=True)
        try:
            with temporary.open('wb') as output:
                output.write(data)
            os.replace(temporary, resolved)
        finally:
            temporary.unlink(missing_ok=True)
        value = None
    elif op == 'rename':
        source = addressed(payload['from'])
        target = addressed(payload['to'])
        target.parent.mkdir(parents=True, exist_ok=True)
        os.replace(source, target)
        value = None
    elif op == 'info':
        value = info(addressed(raw))
    elif op == 'list':
        path = resolved_file(raw)
        if not path.is_dir(): raise NotADirectoryError('path is not a directory')
        value = [info(child) for child in sorted(path.iterdir(), key=lambda item: item.name)]
    elif op == 'canonical':
        path = addressed(raw).resolve(strict=True)
        value = str(path)
    elif op == 'exists':
        path = addressed(raw)
        value = path.exists() or path.is_symlink()
    elif op == 'mkdir':
        addressed(raw).mkdir(parents=payload.get('recursive', True), exist_ok=payload.get('recursive', True))
        value = None
    elif op == 'remove':
        path = addressed(raw)
        if path.is_symlink() or path.is_file(): path.unlink(missing_ok=payload.get('force', False))
        elif path.is_dir():
            if payload.get('recursive', False): shutil.rmtree(path)
            else: path.rmdir()
        elif not payload.get('force', False): raise FileNotFoundError(raw)
        value = None
    else:
        raise NotImplementedError(f'unknown file operation: {op}')
    print(json.dumps({'ok': True, 'value': value}))
except Exception as error:
    fail(error, raw)
`

interface FileResponse<T> {
  ok: boolean
  value?: T
  code?: FileErrorCode
  message?: string
  path?: string
}

/** Pi ExecutionEnv whose filesystem and shell namespace are the run container. */
export class DockerExecutionEnv implements ExecutionEnv {
  readonly cwd: string

  constructor(
    private readonly sandbox: Sandbox,
    options: { cwd?: string } = {},
  ) {
    this.cwd = executionCwd(options.cwd)
  }

  async absolutePath(path: string): Promise<Result<string, FileError>> {
    return this.address(path)
  }

  async joinPath(parts: string[]): Promise<Result<string, FileError>> {
    if (parts.some((part) => part.includes("\\"))) {
      return err(new FileError("invalid", "Path must use POSIX separators"))
    }
    return this.address(posix.join(...parts))
  }

  async exec(
    command: string,
    options: ShellExecOptions = {},
  ): Promise<
    Result<
      {
        stdout: string
        stderr: string
        exitCode: number
      },
      ExecutionError
    >
  > {
    const cwd = this.address(options.cwd ?? this.cwd)
    if (!cwd.ok) {
      return err(new ExecutionError("unknown", cwd.error.message, cwd.error))
    }
    const timeoutSeconds = options.timeout
    if (
      timeoutSeconds !== undefined &&
      (!Number.isFinite(timeoutSeconds) ||
        timeoutSeconds <= 0 ||
        timeoutSeconds * 1000 > MAX_TIMER_MS)
    ) {
      return err(
        new ExecutionError(
          "timeout",
          "Invalid timeout: must be a positive finite number of seconds",
        ),
      )
    }
    const environment = Object.entries(options.env ?? {}).map(([key, value]) => `${key}=${value}`)
    const args = [
      ...(options.inheritEnv === false
        ? ["env", "-i", ...environment]
        : environment.length > 0
          ? ["env", ...environment]
          : []),
      "bash",
      "-lc",
      // timeout 在容器内结束命令进程组；仅杀 docker CLI 无法可靠停止 Docker Desktop 中的 exec。
      'cd -- "$1" && if [ -n "$2" ]; then timeout --kill-after=5s "$2"s bash -lc "$3"; status=$?; if [ "$status" -eq 124 ]; then printf "%s\\n" "__CTF_AGENT_COMMAND_TIMED_OUT__" >&2; fi; exit "$status"; else exec bash -lc "$3"; fi',
      "ctf-agent",
      cwd.value,
      timeoutSeconds === undefined ? "" : String(timeoutSeconds),
      command,
    ]
    try {
      const result = await this.sandbox.exec(args, {
        signal: options.abortSignal,
        // 留出容器内 timeout 上报退出码的时间，避免宿主先杀 docker CLI。
        ...(timeoutSeconds === undefined
          ? {}
          : { timeoutMs: timeoutSeconds * 1000 + COMMAND_TIMEOUT_GRACE_MS }),
        onStdout: options.onStdout,
        onStderr: options.onStderr,
      })
      if (result.stderr.includes(COMMAND_TIMEOUT_MARKER)) {
        return err(
          new ExecutionError("timeout", `Command timed out after ${timeoutSeconds} seconds`),
        )
      }
      return ok({
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.code,
      })
    } catch (cause) {
      return err(executionError(cause))
    }
  }

  async readTextFile(path: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
    return this.fileOperation<string>({ op: "read_text", path }, abortSignal)
  }

  async readTextLines(
    path: string,
    options: {
      maxLines?: number
      abortSignal?: AbortSignal
    } = {},
  ): Promise<Result<string[], FileError>> {
    return this.fileOperation<string[]>(
      { op: "read_text", path, maxLines: options.maxLines },
      options.abortSignal,
    )
  }

  async readBinaryFile(
    path: string,
    abortSignal?: AbortSignal,
  ): Promise<Result<Uint8Array, FileError>> {
    const response = await this.fileOperation<string>({ op: "read_binary", path }, abortSignal)
    if (!response.ok) return response
    try {
      return ok(Buffer.from(response.value, "base64"))
    } catch (cause) {
      return err(
        new FileError("unknown", `Invalid binary response for ${path}`, path, toError(cause)),
      )
    }
  }

  writeFile(
    path: string,
    content: string | Uint8Array,
    abortSignal?: AbortSignal,
  ): Promise<Result<void, FileError>> {
    return this.transferBuffered("write", path, content, abortSignal)
  }

  /**
   * 通过同目录原子替换写入文件。与直接截断目标文件不同，即使旧 inode 正被进程
   * 执行也不会触发 Linux ETXTBSY，适合跨 attempt 刷新持久化附件。
   */
  replaceFile(
    path: string,
    content: string | Uint8Array,
    abortSignal?: AbortSignal,
  ): Promise<Result<void, FileError>> {
    return this.transferBuffered("replace", path, content, abortSignal)
  }

  appendFile(
    path: string,
    content: string | Uint8Array,
    abortSignal?: AbortSignal,
  ): Promise<Result<void, FileError>> {
    return this.transferBuffered("append", path, content, abortSignal)
  }

  /** 容器内文件的 SHA-256（十六进制）。供大文件等价性校验使用，避免整文件读回。 */
  async readFileHash(path: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
    return this.fileOperation<string>({ op: "sha256", path }, abortSignal, FILE_HASH_TIMEOUT_MS)
  }

  /** 小内容走单次 base64 helper 调用；大内容分块，避免触碰 V8 字符串长度上限。 */
  private async transferBuffered(
    op: "write" | "replace" | "append",
    path: string,
    content: string | Uint8Array,
    abortSignal?: AbortSignal,
  ): Promise<Result<void, FileError>> {
    const buffer = Buffer.from(content)
    if (buffer.byteLength <= FILE_TRANSFER_CHUNK_BYTES) {
      return this.fileOperation<void>({ op, path, base64: buffer.toString("base64") }, abortSignal)
    }
    if (op === "replace") return this.replaceLarge(path, buffer, abortSignal)
    return this.transferChunks(op === "write" ? "write" : "append", path, buffer, abortSignal)
  }

  private async transferChunks(
    firstOp: "write" | "append",
    path: string,
    buffer: Buffer,
    abortSignal?: AbortSignal,
  ): Promise<Result<void, FileError>> {
    for (let offset = 0; offset < buffer.byteLength; offset += FILE_TRANSFER_CHUNK_BYTES) {
      const chunk = buffer.subarray(
        offset,
        Math.min(offset + FILE_TRANSFER_CHUNK_BYTES, buffer.byteLength),
      )
      const transferred = await this.fileOperation<void>(
        { op: offset === 0 ? firstOp : "append", path, base64: chunk.toString("base64") },
        abortSignal,
      )
      if (!transferred.ok) return transferred
    }
    return ok(undefined)
  }

  /** 大文件原子替换：分块写入同目录临时文件，再由 rename（os.replace）提交。 */
  private async replaceLarge(
    path: string,
    buffer: Buffer,
    abortSignal?: AbortSignal,
  ): Promise<Result<void, FileError>> {
    const address = this.address(path)
    if (!address.ok) return address
    const temporary = posix.join(
      posix.dirname(address.value),
      `.${posix.basename(address.value)}.${randomUUID()}.tmp`,
    )
    const staged = await this.transferChunks("write", temporary, buffer, abortSignal)
    const committed = staged.ok
      ? await this.fileOperation<void>(
          { op: "rename", path: address.value, from: temporary, to: address.value },
          abortSignal,
        )
      : staged
    if (!committed.ok) await this.remove(temporary, { force: true })
    return committed
  }

  fileInfo(path: string, abortSignal?: AbortSignal): Promise<Result<FileInfo, FileError>> {
    return this.fileOperation<FileInfo>({ op: "info", path }, abortSignal)
  }

  listDir(path: string, abortSignal?: AbortSignal): Promise<Result<FileInfo[], FileError>> {
    return this.fileOperation<FileInfo[]>({ op: "list", path }, abortSignal)
  }

  canonicalPath(path: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
    return this.fileOperation<string>({ op: "canonical", path }, abortSignal)
  }

  async exists(path: string, abortSignal?: AbortSignal): Promise<Result<boolean, FileError>> {
    return this.fileOperation<boolean>({ op: "exists", path }, abortSignal)
  }

  createDir(
    path: string,
    options: {
      recursive?: boolean
      abortSignal?: AbortSignal
    } = {},
  ): Promise<Result<void, FileError>> {
    return this.fileOperation<void>(
      { op: "mkdir", path, recursive: options.recursive ?? true },
      options.abortSignal,
    )
  }

  remove(
    path: string,
    options: {
      recursive?: boolean
      force?: boolean
      abortSignal?: AbortSignal
    } = {},
  ): Promise<Result<void, FileError>> {
    return this.fileOperation<void>(
      {
        op: "remove",
        path,
        recursive: options.recursive ?? false,
        force: options.force ?? false,
      },
      options.abortSignal,
    )
  }

  async createTempDir(
    prefix = "tmp-",
    abortSignal?: AbortSignal,
  ): Promise<Result<string, FileError>> {
    const path = `${WORKSPACE}/.ctf-agent-tmp/${safePrefix(prefix)}${randomUUID()}`
    const created = await this.createDir(path, {
      recursive: true,
      abortSignal,
    })
    return created.ok ? ok(path) : created
  }

  async createTempFile(
    options: {
      prefix?: string
      suffix?: string
      abortSignal?: AbortSignal
    } = {},
  ): Promise<Result<string, FileError>> {
    const directory = await this.createDir(`${WORKSPACE}/.ctf-agent-tmp`, {
      recursive: true,
      abortSignal: options.abortSignal,
    })
    if (!directory.ok) return directory
    const path = `${WORKSPACE}/.ctf-agent-tmp/${safePrefix(options.prefix ?? "")}${randomUUID()}${safePrefix(options.suffix ?? "")}`
    const created = await this.writeFile(path, new Uint8Array(), options.abortSignal)
    return created.ok ? ok(path) : created
  }

  async cleanup(): Promise<void> {
    await this.remove(`${WORKSPACE}/.ctf-agent-tmp`, {
      recursive: true,
      force: true,
    })
  }

  private address(path: string): Result<string, FileError> {
    if (typeof path !== "string" || path.includes("\\") || path.includes("\0")) {
      return err(new FileError("invalid", "Path must be a valid POSIX path", path))
    }
    const absolute = posix.resolve(this.cwd, path)
    return ok(absolute)
  }

  private async fileOperation<T>(
    payload: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs = 30_000,
  ): Promise<Result<T, FileError>> {
    const address = this.address(typeof payload.path === "string" ? payload.path : "")
    if (!address.ok) return address
    if (signal?.aborted)
      return err(new FileError("aborted", "File operation aborted", address.value))
    try {
      const input = JSON.stringify({ ...payload, path: address.value })
      let execution: CommandResult | undefined
      for (let attempt = 1; attempt <= FILE_HELPER_MAX_ATTEMPTS; attempt++) {
        execution = await this.sandbox.exec(["python3", "-c", FILE_HELPER], {
          input,
          signal,
          timeoutMs,
        })
        if (
          execution.code === 0 ||
          !isWindowsNativeFailure(execution.code) ||
          attempt === FILE_HELPER_MAX_ATTEMPTS
        ) {
          break
        }
      }
      if (!execution) {
        throw new Error("Container file helper did not start")
      }
      if (execution.code !== 0) return err(fileCommandError(address.value, execution))
      if (execution.stdoutTruncated) {
        return err(
          new FileError(
            "unknown",
            "Container file response exceeded the output limit",
            address.value,
          ),
        )
      }
      const response = JSON.parse(execution.stdout) as FileResponse<T>
      if (response.ok) return ok(response.value as T)
      return err(
        new FileError(
          response.code ?? "unknown",
          response.message ?? "Container file operation failed",
          response.path ?? address.value,
        ),
      )
    } catch (cause) {
      if (cause instanceof SandboxCommandError && cause.code === "aborted") {
        return err(new FileError("aborted", cause.message, address.value, cause))
      }
      return err(
        new FileError(
          "unknown",
          `Container file operation failed: ${toError(cause).message}`,
          address.value,
          toError(cause),
        ),
      )
    }
  }
}

interface BufferedCapture {
  chunks: Uint8Array[]
  size: number
}

/**
 * Pi 会把被截断的 bash 完整输出逐 chunk 追加到临时文件。该专用环境按 512 KiB
 * 合并写入，避免长任务为每个输出 chunk 启动一个 docker CLI 进程。
 * 每次 bash 工具调用必须创建独立实例，避免并行工具之间共享缓冲区。
 */
export class DockerBashExecutionEnv extends DockerExecutionEnv {
  private readonly captures = new Map<string, BufferedCapture>()
  private readonly pendingOperations = new Set<Promise<unknown>>()
  private captureFailure?: FileError

  override createTempFile(
    options: {
      prefix?: string
      suffix?: string
      abortSignal?: AbortSignal
    } = {},
  ): Promise<Result<string, FileError>> {
    const operation = super.createTempFile(options).then((created) => {
      if (created.ok && options.prefix === "bash-" && options.suffix === ".log") {
        this.captures.set(created.value, { chunks: [], size: 0 })
      }
      return created
    })
    return this.track(operation)
  }

  override appendFile(
    path: string,
    content: string | Uint8Array,
    abortSignal?: AbortSignal,
  ): Promise<Result<void, FileError>> {
    const capture = this.captures.get(path)
    if (!capture) return super.appendFile(path, content, abortSignal)
    const operation = this.bufferCapture(path, capture, content, abortSignal)
    return this.track(operation)
  }

  override async exec(
    command: string,
    options: ShellExecOptions = {},
  ): Promise<Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>> {
    const result = await super.exec(command, options)
    await this.drainPendingOperations()
    for (const path of this.captures.keys()) {
      // 命令自身被取消时仍要尽力保存已捕获的输出，不能让已 abort 的 signal
      // 把主执行结果覆盖成 file-helper 错误。
      const flushed = await this.flushCapture(path)
      if (!flushed.ok) break
    }
    if (this.captureFailure) {
      return err(new ExecutionError("unknown", this.captureFailure.message, this.captureFailure))
    }
    return result
  }

  private async bufferCapture(
    path: string,
    capture: BufferedCapture,
    content: string | Uint8Array,
    abortSignal?: AbortSignal,
  ): Promise<Result<void, FileError>> {
    if (abortSignal?.aborted) {
      return err(new FileError("aborted", "File operation aborted", path))
    }
    const chunk = Buffer.from(content)
    capture.chunks.push(chunk)
    capture.size += chunk.byteLength
    return capture.size >= BASH_CAPTURE_FLUSH_BYTES
      ? this.flushCapture(path, abortSignal)
      : ok(undefined)
  }

  private async flushCapture(
    path: string,
    abortSignal?: AbortSignal,
  ): Promise<Result<void, FileError>> {
    const capture = this.captures.get(path)
    if (!capture || capture.size === 0) return ok(undefined)
    const content = Buffer.concat(capture.chunks, capture.size)
    capture.chunks = []
    capture.size = 0
    const flushed = await super.appendFile(path, content, abortSignal)
    if (!flushed.ok) this.captureFailure = flushed.error
    return flushed
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    this.pendingOperations.add(operation)
    void operation.finally(() => this.pendingOperations.delete(operation)).catch(() => undefined)
    return operation
  }

  private async drainPendingOperations(): Promise<void> {
    do {
      await Promise.resolve()
      await Promise.allSettled(this.pendingOperations)
    } while (this.pendingOperations.size > 0)
  }
}

function executionCwd(value: string | undefined): string {
  if (value === undefined) return WORKSPACE
  if (value.includes("\\") || value.includes("\0")) {
    throw new Error("Docker execution cwd must use POSIX separators")
  }
  const cwd = posix.resolve(WORKSPACE, value)
  return cwd
}

function safePrefix(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 64)
}

function fileCommandError(path: string, result: CommandResult): FileError {
  const message = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n")
  return new FileError(
    "unknown",
    message || `Container file helper exited with ${result.code}`,
    path,
  )
}

function isWindowsNativeFailure(code: number): boolean {
  const unsigned = code >>> 0
  return unsigned >= 0xc0000000 && unsigned <= 0xcfffffff
}

function executionError(cause: unknown): ExecutionError {
  if (cause instanceof SandboxCommandError) {
    const code =
      cause.code === "aborted"
        ? "aborted"
        : cause.code === "timeout"
          ? "timeout"
          : cause.code === "callback_error"
            ? "callback_error"
            : "spawn_error"
    return new ExecutionError(code, cause.message, cause)
  }
  return new ExecutionError("unknown", toError(cause).message, toError(cause))
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}
