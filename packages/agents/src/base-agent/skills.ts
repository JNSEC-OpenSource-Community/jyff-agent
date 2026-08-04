import { copyFile, lstat, mkdir, readdir } from "node:fs/promises";
import { basename, dirname, join, posix, relative, resolve } from "node:path";
import {
	type ExecutionEnv,
	ExecutionError,
	err,
	FileError,
	type FileInfo,
	loadSkills,
	ok,
	type Result,
	type ShellExecOptions,
	type Skill,
	type SkillDiagnostic,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";

export interface AgentSkill extends Skill {
	baseDir: string;
	/** Container-visible paths set after materialization. */
	sandboxPath?: string;
	sandboxBaseDir?: string;
}

export interface DiscoveredSkills {
	skills: AgentSkill[];
	diagnostics: SkillDiagnostic[];
}

/** Pi's skill path helpers are POSIX-oriented; expose a stable virtual project root on every host OS. */
class SkillDiscoveryEnv implements ExecutionEnv {
	readonly cwd = "/project";
	private readonly node: NodeExecutionEnv;

	constructor(private readonly root: string) {
		this.node = new NodeExecutionEnv({ cwd: root });
	}

	private host(path: string): Result<string, FileError> {
		const virtual = posix.resolve(this.cwd, path);
		if (virtual !== this.cwd && !virtual.startsWith(`${this.cwd}/`)) {
			return err(
				new FileError("permission_denied", `Path escapes ${this.cwd}`, path),
			);
		}
		return ok(
			join(
				this.root,
				...virtual.slice(this.cwd.length).split("/").filter(Boolean),
			),
		);
	}

	private virtual(path: string): Result<string, FileError> {
		const suffix = relative(this.root, path);
		if (
			suffix === ".." ||
			suffix.startsWith(`..\\`) ||
			suffix.startsWith("../")
		) {
			return err(
				new FileError("permission_denied", `Path escapes ${this.root}`, path),
			);
		}
		return ok(
			suffix ? `${this.cwd}/${suffix.replaceAll("\\", "/")}` : this.cwd,
		);
	}

	async absolutePath(path: string): Promise<Result<string, FileError>> {
		const host = this.host(path);
		return host.ok ? this.virtual(host.value) : host;
	}

	async joinPath(parts: string[]): Promise<Result<string, FileError>> {
		return this.absolutePath(posix.join(...parts));
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
		const cwd = this.host(options.cwd ?? this.cwd);
		if (!cwd.ok)
			return err(new ExecutionError("unknown", cwd.error.message, cwd.error));
		return this.node.exec(command, { ...options, cwd: cwd.value });
	}

	async readTextFile(path: string, signal?: AbortSignal) {
		const host = this.host(path);
		return host.ok ? this.node.readTextFile(host.value, signal) : host;
	}

	async readTextLines(
		path: string,
		options?: { maxLines?: number; abortSignal?: AbortSignal },
	) {
		const host = this.host(path);
		return host.ok ? this.node.readTextLines(host.value, options) : host;
	}

	async readBinaryFile(path: string, signal?: AbortSignal) {
		const host = this.host(path);
		return host.ok ? this.node.readBinaryFile(host.value, signal) : host;
	}

	async writeFile(
		path: string,
		content: string | Uint8Array,
		signal?: AbortSignal,
	) {
		const host = this.host(path);
		return host.ok ? this.node.writeFile(host.value, content, signal) : host;
	}

	async appendFile(
		path: string,
		content: string | Uint8Array,
		signal?: AbortSignal,
	): Promise<Result<void, FileError>> {
		const host = this.host(path);
		if (signal?.aborted)
			return err(new FileError("aborted", "Operation aborted", path));
		return host.ok ? this.node.appendFile(host.value, content) : host;
	}

	async fileInfo(path: string): Promise<Result<FileInfo, FileError>> {
		const host = this.host(path);
		if (!host.ok) return host;
		const result = await this.node.fileInfo(host.value);
		if (!result.ok) return result;
		const virtual = this.virtual(result.value.path);
		return virtual.ok
			? ok({
					...result.value,
					name: basename(result.value.path),
					path: virtual.value,
				})
			: virtual;
	}

	async listDir(
		path: string,
		signal?: AbortSignal,
	): Promise<Result<FileInfo[], FileError>> {
		const host = this.host(path);
		if (!host.ok) return host;
		const result = await this.node.listDir(host.value, signal);
		if (!result.ok) return result;
		const entries: FileInfo[] = [];
		for (const entry of result.value) {
			const virtual = this.virtual(entry.path);
			if (!virtual.ok) return virtual;
			entries.push({
				...entry,
				name: basename(entry.path),
				path: virtual.value,
			});
		}
		return ok(entries);
	}

	async canonicalPath(path: string): Promise<Result<string, FileError>> {
		const host = this.host(path);
		if (!host.ok) return host;
		const result = await this.node.canonicalPath(host.value);
		return result.ok ? this.virtual(result.value) : result;
	}

	async exists(
		path: string,
		signal?: AbortSignal,
	): Promise<Result<boolean, FileError>> {
		const host = this.host(path);
		if (signal?.aborted)
			return err(new FileError("aborted", "Operation aborted", path));
		return host.ok ? this.node.exists(host.value) : host;
	}

	async createDir(
		path: string,
		options?: { recursive?: boolean; abortSignal?: AbortSignal },
	) {
		const host = this.host(path);
		return host.ok ? this.node.createDir(host.value, options) : host;
	}

	async remove(
		path: string,
		options?: {
			recursive?: boolean;
			force?: boolean;
			abortSignal?: AbortSignal;
		},
	) {
		const host = this.host(path);
		return host.ok ? this.node.remove(host.value, options) : host;
	}

	async createTempDir(
		prefix?: string,
		signal?: AbortSignal,
	): Promise<Result<string, FileError>> {
		if (signal?.aborted)
			return err(new FileError("aborted", "Operation aborted"));
		const result = await this.node.createTempDir(prefix);
		return result.ok ? this.virtual(result.value) : result;
	}

	async createTempFile(options?: {
		prefix?: string;
		suffix?: string;
		abortSignal?: AbortSignal;
	}): Promise<Result<string, FileError>> {
		if (options?.abortSignal?.aborted)
			return err(new FileError("aborted", "Operation aborted"));
		const result = await this.node.createTempFile({
			prefix: options?.prefix,
			suffix: options?.suffix,
		});
		return result.ok ? this.virtual(result.value) : result;
	}

	cleanup() {
		return this.node.cleanup();
	}
}

/** Discover project skills with Pi's canonical parser and diagnostics. Earlier roots win by name. */
export async function discoverProjectSkillsWithDiagnostics(
	root: string,
	extraPaths: readonly string[] = [],
): Promise<DiscoveredSkills> {
	const env = new SkillDiscoveryEnv(root);
	const directories = [
		"/project/.pi/skills",
		"/project/.agents/skills",
		...extraPaths.map((path) => {
			const absolute = resolve(root, path);
			const suffix = relative(root, absolute).replaceAll("\\", "/");
			return suffix ? `/project/${suffix}` : "/project";
		}),
	];
	const loaded = await loadSkills(env, directories);
	const byName = new Map<string, AgentSkill>();
	for (const skill of loaded.skills) {
		if (!byName.has(skill.name)) {
			const filePath = join(
				root,
				...skill.filePath.slice("/project/".length).split("/"),
			);
			byName.set(skill.name, {
				...skill,
				filePath,
				baseDir: dirname(filePath),
			});
		}
	}
	return { skills: [...byName.values()], diagnostics: loaded.diagnostics };
}

/** Backward-compatible shorthand for consumers that do not expose diagnostics yet. */
export async function discoverProjectSkills(
	root: string,
	extraPaths: readonly string[] = [],
): Promise<AgentSkill[]> {
	return (await discoverProjectSkillsWithDiagnostics(root, extraPaths)).skills;
}

/**
 * Copy trusted host skills into the run workspace. Symlinks are rejected so a
 * mounted skill cannot escape the container-visible workspace.
 */
export async function materializeSkills(
	skills: readonly AgentSkill[],
	workspace: string,
): Promise<AgentSkill[]> {
	const root = join(workspace, ".skills");
	await mkdir(root, { recursive: true });
	const copyTree = async (source: string, target: string): Promise<void> => {
		const stat = await lstat(source);
		if (stat.isSymbolicLink())
			throw new Error(`skill 包含不允许的符号链接: ${source}`);
		if (stat.isDirectory()) {
			await mkdir(target, { recursive: true });
			for (const entry of await readdir(source, {
				withFileTypes: true,
				encoding: "utf8",
			})) {
				await copyTree(join(source, entry.name), join(target, entry.name));
			}
			return;
		}
		if (!stat.isFile())
			throw new Error(`skill 包含不支持的文件类型: ${source}`);
		await mkdir(dirname(target), { recursive: true });
		await copyFile(source, target);
	};

	const materialized: AgentSkill[] = [];
	for (const [index, skill] of skills.entries()) {
		const directory = join(root, `skill-${index + 1}`);
		const isStandardDirectory =
			basename(skill.filePath).toLowerCase() === "skill.md";
		if (isStandardDirectory) await copyTree(skill.baseDir, directory);
		else {
			await mkdir(directory, { recursive: true });
			await copyTree(skill.filePath, join(directory, "SKILL.md"));
		}
		materialized.push({
			...skill,
			filePath: `/workspace/.skills/skill-${index + 1}/SKILL.md`,
			sandboxBaseDir: `/workspace/.skills/skill-${index + 1}`,
			sandboxPath: `/workspace/.skills/skill-${index + 1}/SKILL.md`,
		});
	}
	return materialized;
}
