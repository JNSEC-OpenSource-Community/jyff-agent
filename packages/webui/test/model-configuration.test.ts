import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSecretStore } from "@ctf-agent/core";
import { afterEach, describe, expect, it } from "vitest";
import { createFileModelConfiguration } from "../src/model-configuration.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

describe("file model configuration", () => {
	it("只把 API Key 写入 Secret Store", async () => {
		const root = await mkdtemp(join(tmpdir(), "ctf-model-config-"));
		roots.push(root);
		const storagePath = join(root, "model-config.json");
		const secretsPath = join(root, "secrets.json");
		const configuration = await createFileModelConfiguration({
			storagePath,
			secretStore: await FileSecretStore.open(secretsPath),
		});

		const view = await configuration.update({
			provider: "custom-openai",
			modelId: "solver-model",
			baseUrl: "https://models.example.test/v1",
			contextWindow: 64_000,
			maxTokens: 4_096,
			thinkingEnabled: true,
			reasoningEffort: "high",
			passthroughThinking: false,
			apiKey: "secret-key",
		});

		expect(view).toMatchObject({
			configured: true,
			apiKeyConfigured: true,
			apiKeySource: "secret-store",
		});
		expect(JSON.stringify(view)).not.toContain("secret-key");
		expect(await readFile(storagePath, "utf8")).not.toContain("secret-key");
		expect(await readFile(secretsPath, "utf8")).toContain("secret-key");
	});

	it("把旧模型配置中的明文 Key 迁移到 Secret Store", async () => {
		const root = await mkdtemp(join(tmpdir(), "ctf-model-migration-"));
		roots.push(root);
		const storagePath = join(root, "model-config.json");
		const secretsPath = join(root, "secrets.json");
		await writeFile(
			storagePath,
			JSON.stringify({ modelId: "solver-model", apiKey: "legacy-key" }),
		);

		const configuration = await createFileModelConfiguration({
			storagePath,
			secretStore: await FileSecretStore.open(secretsPath),
		});

		expect(configuration.snapshot().apiKeySource).toBe("secret-store");
		expect(await readFile(storagePath, "utf8")).not.toContain("legacy-key");
		expect(await readFile(secretsPath, "utf8")).toContain("legacy-key");
	});
});
