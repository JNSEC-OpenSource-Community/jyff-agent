import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ContestScheduler, ControlPlane } from "@ctf-agent/core";
import { ctfdPlatform, gzctfPlatform } from "@ctf-agent/platform";
import { startWebUi } from "@ctf-agent/webui";
import { loadModelEnvironment } from "./agent-config.ts";

// 与 run-myctf.ts 同款 .env 加载器(webui 此前不读 .env,导致 CTF_SCHEDULER_* 等配置不生效)
function loadEnvFile(): void {
	const candidates = [
		join(resolve(import.meta.dirname), "..", "..", ".env"),
		join(process.cwd(), ".env"),
	];
	for (const path of candidates) {
		if (!existsSync(path)) continue;
		const content = readFileSync(path, "utf-8");
		for (const line of content.split(/\r?\n/)) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("#")) continue;
			const match =
				/^([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*"?([^"#]*?)"?\s*(?:#.*)?$/.exec(
					trimmed,
				);
			if (!match) continue;
			const [, key, value] = match;
			if (key === undefined || value === undefined) continue;
			if (process.env[key]) continue;
			process.env[key] = value;
		}
		return;
	}
}
loadEnvFile();

const root = resolve(import.meta.dirname);
const host = process.env.CTF_WEBUI_HOST ?? "127.0.0.1";
const port = Number(process.env.CTF_WEBUI_PORT ?? 3000);
const pollIntervalMs = Number(process.env.CTF_WEBUI_POLL_INTERVAL_MS ?? 1_000);
const maxConcurrent = Number(process.env.CTF_SCHEDULER_MAX_CONCURRENT ?? 2);
const maxAttempts = Number(process.env.CTF_SCHEDULER_MAX_ATTEMPTS ?? 2);
const autoStart = process.env.CTF_SCHEDULER_AUTO_START === "true";
const workspaceVolume = process.env.CTF_DOCKER_WORKSPACE_VOLUME;
const model = loadModelEnvironment({
	storagePath: resolve(root, ".ctf-agent", "model-config.json"),
});

const controlPlane = await ControlPlane.create({
	root,
	platforms: [ctfdPlatform, gzctfPlatform],
	resolveSecret: (name) => process.env[name],
	project: {
		telemetry: {
			level: process.env.CTF_TELEMETRY_LEVEL === "safe" ? "safe" : "full",
			maxTextLength: Number(process.env.CTF_TELEMETRY_MAX_TEXT_LENGTH ?? 8_000),
		},
		...(workspaceVolume
			? {
					workspaceMount: ({ relativeWorkspace }) => ({
						type: "volume" as const,
						source: workspaceVolume,
						subpath: relativeWorkspace,
					}),
				}
			: {}),
	},
	createScheduler: (project) =>
		new ContestScheduler(project, {
			maxConcurrent,
			maxAttempts,
			challengeTimeoutMs: Number(
				process.env.CTF_SCHEDULER_TIMEOUT_MS ?? 30 * 60_000,
			),
			retryDelayMs: Number(process.env.CTF_SCHEDULER_RETRY_DELAY_MS ?? 2_000),
			availability: () => ({
				available: model.configured,
				...(model.unavailableReason
					? { unavailableReason: model.unavailableReason }
					: {}),
			}),
			createAgentOptions: () => model.createAgentOptions(),
			compaction: true,
		}),
});
await controlPlane.start();
const webui = await startWebUi({
	controlPlane,
	modelConfiguration: model,
	host,
	port,
	pollIntervalMs,
});
let closing = false;

const initialState = controlPlane.snapshot();
console.log(`CTF Agent WebUI 已启动：${webui.url}`);
console.log(
	initialState.phase === "ready"
		? `比赛平台：${initialState.platformId} / ${initialState.projectName}`
		: "比赛平台尚未连接，请在 WebUI 中完成配置",
);
console.log(
	model.configured
		? `调度模型：${model.provider}/${model.modelId}`
		: `调度器已暂停：${model.unavailableReason}`,
);
if (autoStart && model.configured && controlPlane.currentScheduler()) {
	await controlPlane.currentScheduler()?.startAuto();
	console.log("自主调度已自动开启");
}

async function shutdown(signal: string): Promise<void> {
	if (closing) return;
	closing = true;
	console.log(`\n收到 ${signal}，正在关闭 WebUI…`);
	try {
		await webui.close();
		await controlPlane.close();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
