import { join, resolve } from "node:path";
import type {
	PlatformPlugin,
	PlatformProject,
	PlatformSetupDescriptor,
} from "@ctf-agent/platform";
import type { ContestScheduler } from "../orchestration/contest-scheduler.ts";
import { type ProjectConfig, parseProjectConfig } from "../project/config.ts";
import { type OpenProjectOptions, Project } from "../project/project.ts";
import { ProjectConfigStore } from "./config-store.ts";
import { FileSecretStore, type SecretStore } from "./secret-store.ts";

export type ControlPlanePhase =
	| "unconfigured"
	| "disconnected"
	| "connecting"
	| "ready"
	| "degraded"
	| "closing";

export interface ControlPlaneSnapshot {
	phase: ControlPlanePhase;
	configured: boolean;
	projectId: string | null;
	projectName: string | null;
	platformId: string | null;
	lastError: string | null;
	updatedAt: string;
}

export interface PlatformConnectionTest {
	ok: true;
	overview: {
		id: string;
		name: string;
		challenges: number;
		announcements: number;
	};
}

export interface ControlPlaneSetupSnapshot {
	state: ControlPlaneSnapshot;
	config: ProjectConfig | null;
	platforms: Array<{ id: string; setup: PlatformSetupDescriptor }>;
	secrets: Record<
		string,
		{ configured: boolean; source: "store" | "environment" | "none" }
	>;
}

export interface ApplyControlPlaneSetup {
	config: ProjectConfig;
	secrets?: Readonly<Record<string, string | undefined>>;
}

export interface ControlPlaneOptions {
	root: string;
	platforms: readonly PlatformPlugin[];
	secretStore?: SecretStore;
	resolveSecret?: (name: string) => string | undefined;
	project?: Omit<OpenProjectOptions, "root" | "platforms" | "resolveSecret">;
	createScheduler?: (project: Project) => ContestScheduler | undefined;
}

/** Owns configuration and the replaceable Project/Scheduler runtime. */
export class ControlPlane {
	readonly root: string;
	private readonly platforms: readonly PlatformPlugin[];
	private readonly configStore: ProjectConfigStore;
	private readonly secretStore: SecretStore;
	private readonly options: ControlPlaneOptions;
	private config?: ProjectConfig;
	private project?: Project;
	private scheduler?: ContestScheduler;
	private phase: ControlPlanePhase = "unconfigured";
	private lastError: string | null = null;
	private updatedAt = new Date().toISOString();
	private transitionTail: Promise<void> = Promise.resolve();

	private constructor(options: ControlPlaneOptions, secretStore: SecretStore) {
		this.options = options;
		this.root = resolve(options.root);
		this.platforms = options.platforms;
		this.configStore = new ProjectConfigStore(this.root);
		this.secretStore = secretStore;
	}

	static async create(options: ControlPlaneOptions): Promise<ControlPlane> {
		const root = resolve(options.root);
		const secretStore =
			options.secretStore ??
			(await FileSecretStore.open(join(root, ".ctf-agent", "secrets.json")));
		const control = new ControlPlane(options, secretStore);
		try {
			control.config = await control.configStore.load();
			control.setPhase(control.config ? "disconnected" : "unconfigured");
		} catch (error) {
			control.lastError = errorText(error);
			control.setPhase("degraded");
		}
		return control;
	}

	snapshot(): ControlPlaneSnapshot {
		return {
			phase: this.phase,
			configured: this.config !== undefined,
			projectId: this.config?.project.id ?? null,
			projectName: this.config?.project.name ?? null,
			platformId: this.config?.platform.plugin ?? null,
			lastError: this.lastError,
			updatedAt: this.updatedAt,
		};
	}

	configuration(): ProjectConfig | undefined {
		return this.config ? structuredClone(this.config) : undefined;
	}

	setupSnapshot(): ControlPlaneSetupSnapshot {
		const platforms = this.platforms.flatMap((plugin) =>
			plugin.setup ? [{ id: plugin.id, setup: plugin.setup }] : [],
		);
		const names = new Set(
			platforms.flatMap(({ setup }) =>
				setup.authStrategies.flatMap((strategy) =>
					strategy.secrets.map((secret) => secret.name),
				),
			),
		);
		return {
			state: this.snapshot(),
			config: this.configuration() ?? null,
			platforms,
			secrets: Object.fromEntries(
				[...names].map((name) => {
					const source = this.secretStore.has(name)
						? "store"
						: (this.options.resolveSecret?.(name) ?? process.env[name])
							? "environment"
							: "none";
					return [name, { configured: source !== "none", source }];
				}),
			),
		};
	}

	currentProject(): Project | undefined {
		return this.project;
	}

	currentScheduler(): ContestScheduler | undefined {
		return this.scheduler;
	}

	async start(): Promise<ControlPlaneSnapshot> {
		if (!this.config) return this.snapshot();
		try {
			return await this.connect();
		} catch {
			return this.snapshot();
		}
	}

	async connect(): Promise<ControlPlaneSnapshot> {
		return await this.enqueueTransition(() => this.performConnect());
	}

	async testConnection(
		input: ApplyControlPlaneSetup,
	): Promise<PlatformConnectionTest> {
		const config = this.validateConfig(input.config);
		const plugin = this.plugin(config.platform.plugin);
		const platform = await plugin.connect({
			project: config.project,
			config: plugin.config.parse(config.platform.config),
			resolveSecret: this.secretResolver(input.secrets),
		});
		return await inspectAndClose(platform);
	}

	async applySetup(
		input: ApplyControlPlaneSetup,
	): Promise<ControlPlaneSnapshot> {
		return await this.enqueueTransition(async () => {
			const config = this.validateConfig(input.config);
			await this.testConnection({ config, secrets: input.secrets });
			await this.performDisconnect();
			if (input.secrets) await this.secretStore.set(input.secrets);
			this.config = await this.configStore.save(config);
			return await this.performConnect();
		});
	}

	async disconnect(): Promise<ControlPlaneSnapshot> {
		return await this.enqueueTransition(() => this.performDisconnect());
	}

	async close(): Promise<void> {
		await this.enqueueTransition(async () => {
			this.setPhase("closing");
			await this.performDisconnect();
			return this.snapshot();
		});
	}

	private async performDisconnect(): Promise<ControlPlaneSnapshot> {
		const failures: unknown[] = [];
		const scheduler = this.scheduler;
		const project = this.project;
		this.scheduler = undefined;
		this.project = undefined;
		if (scheduler) {
			try {
				await scheduler.shutdown();
			} catch (error) {
				failures.push(error);
			}
		}
		if (project) {
			try {
				await project.close();
			} catch (error) {
				failures.push(error);
			}
		}
		this.setPhase(this.config ? "disconnected" : "unconfigured");
		if (failures.length > 0) {
			this.lastError = failures.map(errorText).join("\n");
			this.setPhase("degraded");
			throw new AggregateError(failures, "ControlPlane 断开时资源清理失败");
		}
		return this.snapshot();
	}

	private async performConnect(): Promise<ControlPlaneSnapshot> {
		if (!this.config) {
			this.setPhase("unconfigured");
			return this.snapshot();
		}
		if (this.project) return this.snapshot();
		this.lastError = null;
		this.setPhase("connecting");
		try {
			const project = await Project.open({
				...this.options.project,
				root: this.root,
				config: this.config,
				platforms: this.platforms,
				resolveSecret: this.secretResolver(),
			});
			this.project = project;
			this.scheduler = this.options.createScheduler?.(project);
			this.setPhase("ready");
			return this.snapshot();
		} catch (error) {
			this.lastError = errorText(error);
			this.setPhase("degraded");
			throw error;
		}
	}

	private validateConfig(config: ProjectConfig): ProjectConfig {
		const projectConfig = parseProjectConfig(config);
		const validated = this.plugin(projectConfig.platform.plugin).config.parse(
			projectConfig.platform.config,
		);
		return {
			...projectConfig,
			platform: { ...projectConfig.platform, config: validated },
		};
	}

	private plugin(id: string): PlatformPlugin {
		const plugin = this.platforms.find((candidate) => candidate.id === id);
		if (!plugin) throw new Error(`未注册平台插件: ${id}`);
		return plugin;
	}

	private secretResolver(
		overrides: Readonly<Record<string, string | undefined>> = {},
	): (name: string) => string | undefined {
		return (name) =>
			overrides[name] ??
			this.secretStore.get(name) ??
			this.options.resolveSecret?.(name) ??
			process.env[name];
	}

	private setPhase(phase: ControlPlanePhase): void {
		this.phase = phase;
		this.updatedAt = new Date().toISOString();
	}

	private enqueueTransition(
		operation: () => Promise<ControlPlaneSnapshot>,
	): Promise<ControlPlaneSnapshot> {
		const result = this.transitionTail.then(operation, operation);
		this.transitionTail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}
}

async function inspectAndClose(
	platform: PlatformProject,
): Promise<PlatformConnectionTest> {
	let result: PlatformConnectionTest | undefined;
	let failure: unknown;
	try {
		result = { ok: true, overview: await platform.getOverview() };
	} catch (error) {
		failure = error;
	}
	try {
		await platform.close();
	} catch (error) {
		if (failure) {
			throw new AggregateError([failure, error], "平台连接测试和关闭均失败");
		}
		throw error;
	}
	if (failure) throw failure;
	if (!result) throw new Error("平台连接测试未返回结果");
	return result;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
