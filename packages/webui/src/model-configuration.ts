import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SecretStore } from "@ctf-agent/core";
import type {
	DashboardModelConfiguration,
	ModelConfigurationUpdate,
	ModelConfigurationView,
} from "./types.ts";

const MODEL_API_KEY_SECRET = "CTF_MODEL_API_KEY";
const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"];

interface StoredModelConfiguration {
	provider?: string;
	modelId?: string;
	baseUrl?: string;
	contextWindow?: number;
	maxTokens?: number;
	thinkingEnabled?: boolean;
	reasoningEffort?: string;
	passthroughThinking?: boolean;
}

export interface FileModelConfigurationOptions {
	storagePath: string;
	secretStore: SecretStore;
}

/**
 * Persists public model parameters separately from the API key. The API key is
 * always resolved from SecretStore and is never included in snapshots.
 */
export async function createFileModelConfiguration(
	options: FileModelConfigurationOptions,
): Promise<DashboardModelConfiguration> {
	const parsed = await readStoredConfiguration(options.storagePath);
	if (parsed.legacyApiKey !== undefined) {
		if (parsed.legacyApiKey && !options.secretStore.has(MODEL_API_KEY_SECRET)) {
			await options.secretStore.set({
				[MODEL_API_KEY_SECRET]: parsed.legacyApiKey,
			});
		}
		await persistConfiguration(options.storagePath, parsed.configuration);
	}
	return new PersistentModelConfiguration(options, parsed.configuration);
}

class PersistentModelConfiguration implements DashboardModelConfiguration {
	constructor(
		private readonly options: FileModelConfigurationOptions,
		private values: StoredModelConfiguration,
	) {}

	snapshot(): ModelConfigurationView {
		const apiKeyConfigured = this.options.secretStore.has(MODEL_API_KEY_SECRET);
		const modelId = this.values.modelId ?? "";
		return {
			provider: this.values.provider ?? "openrouter",
			modelId,
			baseUrl: this.values.baseUrl ?? "",
			contextWindow: this.values.contextWindow ?? 64_000,
			maxTokens: this.values.maxTokens ?? 4_096,
			apiKeyConfigured,
			apiKeySource: apiKeyConfigured ? "secret-store" : "none",
			thinkingEnabled: this.values.thinkingEnabled ?? false,
			reasoningEffort: this.values.reasoningEffort ?? "max",
			passthroughThinking: this.values.passthroughThinking ?? false,
			supportedThinkingLevels: [...THINKING_LEVELS],
			configured: apiKeyConfigured && modelId !== "",
			...(!apiKeyConfigured || modelId === ""
				? {
						unavailableReason: !apiKeyConfigured
							? "未配置模型 API Key，调度操作已禁用"
							: "未配置 Model ID，调度操作已禁用",
					}
				: {}),
		};
	}

	async update(
		configuration: ModelConfigurationUpdate,
	): Promise<ModelConfigurationView> {
		const next: StoredModelConfiguration = {
			provider: configuration.provider,
			modelId: configuration.modelId,
			baseUrl: configuration.baseUrl,
			contextWindow: configuration.contextWindow,
			maxTokens: configuration.maxTokens,
			thinkingEnabled: configuration.thinkingEnabled,
			reasoningEffort: configuration.reasoningEffort,
			passthroughThinking: configuration.passthroughThinking,
		};
		await persistConfiguration(this.options.storagePath, next);
		if (configuration.clearApiKey) {
			await this.options.secretStore.set({
				[MODEL_API_KEY_SECRET]: undefined,
			});
		} else if (configuration.apiKey !== undefined) {
			await this.options.secretStore.set({
				[MODEL_API_KEY_SECRET]: configuration.apiKey,
			});
		}
		this.values = next;
		return this.snapshot();
	}
}

async function readStoredConfiguration(path: string): Promise<{
	configuration: StoredModelConfiguration;
	legacyApiKey?: string;
}> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		if (hasCode(error, "ENOENT")) return { configuration: {} };
		throw new Error(`无法读取模型配置: ${path}`, { cause: error });
	}
	if (!isRecord(parsed)) throw new Error(`模型配置格式无效: ${path}`);
	return {
		configuration: {
			...(typeof parsed.provider === "string"
				? { provider: parsed.provider }
				: {}),
			...(typeof parsed.modelId === "string"
				? { modelId: parsed.modelId }
				: {}),
			...(typeof parsed.baseUrl === "string"
				? { baseUrl: parsed.baseUrl }
				: {}),
			...(positiveInteger(parsed.contextWindow)
				? { contextWindow: parsed.contextWindow }
				: {}),
			...(positiveInteger(parsed.maxTokens)
				? { maxTokens: parsed.maxTokens }
				: {}),
			...(typeof parsed.thinkingEnabled === "boolean"
				? { thinkingEnabled: parsed.thinkingEnabled }
				: {}),
			...(typeof parsed.reasoningEffort === "string"
				? { reasoningEffort: parsed.reasoningEffort }
				: {}),
			...(typeof parsed.passthroughThinking === "boolean"
				? { passthroughThinking: parsed.passthroughThinking }
				: {}),
		},
		...(typeof parsed.apiKey === "string"
			? { legacyApiKey: parsed.apiKey }
			: {}),
	};
}

async function persistConfiguration(
	path: string,
	configuration: StoredModelConfiguration,
): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(temporary, `${JSON.stringify(configuration, null, 2)}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
	await chmod(temporary, 0o600);
	await rename(temporary, path);
}

function positiveInteger(value: unknown): value is number {
	return Number.isInteger(value) && Number(value) > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasCode(error: unknown, code: string): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === code
	);
}
