import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type ProjectConfig, parseProjectConfig } from "../project/config.ts";

export class ProjectConfigStore {
	readonly path: string;
	readonly legacyPath: string;

	constructor(readonly root: string) {
		this.path = join(root, ".ctf-agent", "project-config.json");
		this.legacyPath = join(root, ".pi", "ctf-config.json");
	}

	async load(): Promise<ProjectConfig | undefined> {
		const current = await readConfig(this.path);
		if (current) return current;
		return await readConfig(this.legacyPath);
	}

	async save(config: ProjectConfig): Promise<ProjectConfig> {
		const validated = parseProjectConfig(config);
		await mkdir(dirname(this.path), { recursive: true });
		const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`;
		await writeFile(
			temporary,
			`${JSON.stringify(validated, null, 2)}\n`,
			"utf8",
		);
		await rename(temporary, this.path);
		return validated;
	}
}

async function readConfig(path: string): Promise<ProjectConfig | undefined> {
	try {
		return parseProjectConfig(JSON.parse(await readFile(path, "utf8")));
	} catch (error) {
		if (hasCode(error, "ENOENT")) return undefined;
		throw new Error(`无法读取项目配置: ${path}`, { cause: error });
	}
}

function hasCode(error: unknown, code: string): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === code
	);
}
