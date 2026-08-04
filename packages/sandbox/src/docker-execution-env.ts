import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { posix } from "node:path";
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
} from "@earendil-works/pi-agent-core";
import {
	type CommandResult,
	type Sandbox,
	SandboxCommandError,
} from "./docker-sandbox.ts";

const WORKSPACE = "/workspace";

const FILE_HELPER = String.raw`
import base64, json, os, shutil, stat, sys
from pathlib import Path

ROOT = Path('/workspace').resolve()

def inside(path):
    try:
        path.relative_to(ROOT)
        return True
    except ValueError:
        return False

def addressed(raw):
    if not isinstance(raw, str) or not raw.startswith('/') or '\\' in raw:
        raise ValueError('path must be an absolute POSIX path')
    path = Path(os.path.normpath(raw))
    if not inside(path):
        raise PermissionError('path escapes /workspace')
    parent = path.parent.resolve()
    if not inside(parent):
        raise PermissionError('path parent escapes /workspace')
    return path

def resolved_file(raw):
    path = addressed(raw).resolve()
    if not inside(path):
        raise PermissionError('path or symlink escapes /workspace')
    return path

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
    elif op in ('write', 'append'):
        path = addressed(raw)
        path.parent.mkdir(parents=True, exist_ok=True)
        resolved = path.resolve()
        if not inside(resolved): raise PermissionError('path or symlink escapes /workspace')
        data = base64.b64decode(payload['base64'], validate=True)
        with resolved.open('ab' if op == 'append' else 'wb') as output:
            output.write(data)
        value = None
    elif op == 'info':
        value = info(addressed(raw))
    elif op == 'list':
        path = resolved_file(raw)
        if not path.is_dir(): raise NotADirectoryError('path is not a directory')
        value = [info(child) for child in sorted(path.iterdir(), key=lambda item: item.name)]
    elif op == 'canonical':
        path = addressed(raw).resolve(strict=True)
        if not inside(path): raise PermissionError('path or symlink escapes /workspace')
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
`;

interface FileResponse<T> {
	ok: boolean;
	value?: T;
	code?: FileErrorCode;
	message?: string;
	path?: string;
}

/** Pi ExecutionEnv whose filesystem and shell namespace are the run container. */
export class DockerExecutionEnv implements ExecutionEnv {
	readonly cwd = WORKSPACE;

	constructor(private readonly sandbox: Sandbox) {}

	async absolutePath(path: string): Promise<Result<string, FileError>> {
		return this.address(path);
	}

	async joinPath(parts: string[]): Promise<Result<string, FileError>> {
		if (parts.some((part) => part.includes("\\"))) {
			return err(new FileError("invalid", "Path must use POSIX separators"));
		}
		return this.address(posix.join(...parts));
	}

	async exec(
		command: string,
		options: ShellExecOptions = {},
	): Promise<
		Result<
			{
				stdout: string;
				stderr: string;
				exitCode: number;
			},
			ExecutionError
		>
	> {
		const cwd = this.address(options.cwd ?? this.cwd);
		if (!cwd.ok) {
			return err(new ExecutionError("unknown", cwd.error.message, cwd.error));
		}
		const environment = Object.entries(options.env ?? {}).map(
			([key, value]) => `${key}=${value}`,
		);
		const args = [
			...(options.inheritEnv === false
				? ["env", "-i", ...environment]
				: environment.length > 0
					? ["env", ...environment]
					: []),
			"bash",
			"-lc",
			'cd -- "$1" && exec bash -lc "$2"',
			"ctf-agent",
			cwd.value,
			command,
		];
		try {
			const result = await this.sandbox.exec(args, {
				signal: options.abortSignal,
				timeoutMs:
					options.timeout === undefined ? undefined : options.timeout * 1000,
				onStdout: options.onStdout,
				onStderr: options.onStderr,
			});
			return ok({
				stdout: result.stdout,
				stderr: result.stderr,
				exitCode: result.code,
			});
		} catch (cause) {
			return err(executionError(cause));
		}
	}

	async readTextFile(
		path: string,
		abortSignal?: AbortSignal,
	): Promise<Result<string, FileError>> {
		return this.fileOperation<string>({ op: "read_text", path }, abortSignal);
	}

	async readTextLines(
		path: string,
		options: {
			maxLines?: number;
			abortSignal?: AbortSignal;
		} = {},
	): Promise<Result<string[], FileError>> {
		return this.fileOperation<string[]>(
			{ op: "read_text", path, maxLines: options.maxLines },
			options.abortSignal,
		);
	}

	async readBinaryFile(
		path: string,
		abortSignal?: AbortSignal,
	): Promise<Result<Uint8Array, FileError>> {
		const response = await this.fileOperation<string>(
			{ op: "read_binary", path },
			abortSignal,
		);
		if (!response.ok) return response;
		try {
			return ok(Buffer.from(response.value, "base64"));
		} catch (cause) {
			return err(
				new FileError(
					"unknown",
					`Invalid binary response for ${path}`,
					path,
					toError(cause),
				),
			);
		}
	}

	writeFile(
		path: string,
		content: string | Uint8Array,
		abortSignal?: AbortSignal,
	): Promise<Result<void, FileError>> {
		return this.fileOperation<void>(
			{ op: "write", path, base64: encoded(content) },
			abortSignal,
		);
	}

	appendFile(
		path: string,
		content: string | Uint8Array,
		abortSignal?: AbortSignal,
	): Promise<Result<void, FileError>> {
		return this.fileOperation<void>(
			{ op: "append", path, base64: encoded(content) },
			abortSignal,
		);
	}

	fileInfo(
		path: string,
		abortSignal?: AbortSignal,
	): Promise<Result<FileInfo, FileError>> {
		return this.fileOperation<FileInfo>({ op: "info", path }, abortSignal);
	}

	listDir(
		path: string,
		abortSignal?: AbortSignal,
	): Promise<Result<FileInfo[], FileError>> {
		return this.fileOperation<FileInfo[]>({ op: "list", path }, abortSignal);
	}

	canonicalPath(
		path: string,
		abortSignal?: AbortSignal,
	): Promise<Result<string, FileError>> {
		return this.fileOperation<string>({ op: "canonical", path }, abortSignal);
	}

	async exists(
		path: string,
		abortSignal?: AbortSignal,
	): Promise<Result<boolean, FileError>> {
		return this.fileOperation<boolean>({ op: "exists", path }, abortSignal);
	}

	createDir(
		path: string,
		options: {
			recursive?: boolean;
			abortSignal?: AbortSignal;
		} = {},
	): Promise<Result<void, FileError>> {
		return this.fileOperation<void>(
			{ op: "mkdir", path, recursive: options.recursive ?? true },
			options.abortSignal,
		);
	}

	remove(
		path: string,
		options: {
			recursive?: boolean;
			force?: boolean;
			abortSignal?: AbortSignal;
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
		);
	}

	async createTempDir(
		prefix = "tmp-",
		abortSignal?: AbortSignal,
	): Promise<Result<string, FileError>> {
		const path = `${WORKSPACE}/.ctf-agent-tmp/${safePrefix(prefix)}${randomUUID()}`;
		const created = await this.createDir(path, {
			recursive: true,
			abortSignal,
		});
		return created.ok ? ok(path) : created;
	}

	async createTempFile(
		options: {
			prefix?: string;
			suffix?: string;
			abortSignal?: AbortSignal;
		} = {},
	): Promise<Result<string, FileError>> {
		const directory = await this.createDir(`${WORKSPACE}/.ctf-agent-tmp`, {
			recursive: true,
			abortSignal: options.abortSignal,
		});
		if (!directory.ok) return directory;
		const path = `${WORKSPACE}/.ctf-agent-tmp/${safePrefix(options.prefix ?? "")}${randomUUID()}${safePrefix(options.suffix ?? "")}`;
		const created = await this.writeFile(
			path,
			new Uint8Array(),
			options.abortSignal,
		);
		return created.ok ? ok(path) : created;
	}

	async cleanup(): Promise<void> {
		await this.remove(`${WORKSPACE}/.ctf-agent-tmp`, {
			recursive: true,
			force: true,
		});
	}

	private address(path: string): Result<string, FileError> {
		if (
			typeof path !== "string" ||
			path.includes("\\") ||
			path.includes("\0")
		) {
			return err(
				new FileError("invalid", "Path must be a valid POSIX path", path),
			);
		}
		const absolute = posix.resolve(this.cwd, path);
		if (absolute !== WORKSPACE && !absolute.startsWith(`${WORKSPACE}/`)) {
			return err(
				new FileError("permission_denied", "Path escapes /workspace", absolute),
			);
		}
		return ok(absolute);
	}

	private async fileOperation<T>(
		payload: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<Result<T, FileError>> {
		const address = this.address(String(payload.path ?? ""));
		if (!address.ok) return address;
		if (signal?.aborted)
			return err(
				new FileError("aborted", "File operation aborted", address.value),
			);
		try {
			const execution = await this.sandbox.exec(
				["python3", "-c", FILE_HELPER],
				{
					input: JSON.stringify({ ...payload, path: address.value }),
					signal,
					timeoutMs: 30_000,
				},
			);
			if (execution.code !== 0)
				return err(fileCommandError(address.value, execution));
			if (execution.stdoutTruncated) {
				return err(
					new FileError(
						"unknown",
						"Container file response exceeded the output limit",
						address.value,
					),
				);
			}
			const response = JSON.parse(execution.stdout) as FileResponse<T>;
			if (response.ok) return ok(response.value as T);
			return err(
				new FileError(
					response.code ?? "unknown",
					response.message ?? "Container file operation failed",
					response.path ?? address.value,
				),
			);
		} catch (cause) {
			if (cause instanceof SandboxCommandError && cause.code === "aborted") {
				return err(
					new FileError("aborted", cause.message, address.value, cause),
				);
			}
			return err(
				new FileError(
					"unknown",
					`Container file operation failed: ${toError(cause).message}`,
					address.value,
					toError(cause),
				),
			);
		}
	}
}

function encoded(content: string | Uint8Array): string {
	return Buffer.from(content).toString("base64");
}

function safePrefix(value: string): string {
	return value.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 64);
}

function fileCommandError(path: string, result: CommandResult): FileError {
	const message = [result.stderr.trim(), result.stdout.trim()]
		.filter(Boolean)
		.join("\n");
	return new FileError(
		"unknown",
		message || `Container file helper exited with ${result.code}`,
		path,
	);
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
						: "spawn_error";
		return new ExecutionError(code, cause.message, cause);
	}
	return new ExecutionError("unknown", toError(cause).message, toError(cause));
}

function toError(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value));
}
