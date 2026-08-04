// 真实平台批量解题入口。
// CLI: --only <id> 只跑单题(便于冒烟);不传则跑全部未解决题目。
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ctfdPlatform, gzctfPlatform } from "@ctf-agent/platform";
import {
	ContestRunner,
	Project,
	type ProjectConfig,
	parseProjectConfig,
} from "@ctf-agent/project";
import type { AgentOptions } from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { getModel, type Model } from "@earendil-works/pi-ai/compat";
import {
	deepseekThinkingLevelMap,
	thinkingEnabledFromEnv,
	thinkingLevelFromEnv,
} from "./agent-config.ts";

// 从项目根目录的 .env 文件加载环境变量(不依赖 dotenv 包)。
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
			if (process.env[key]) continue; // 不覆盖已有的环境变量
			process.env[key] = value;
		}
		return;
	}
}
loadEnvFile();

// 顶层收口:任何前置校验失败都打印干净文案并退出,不抛原始堆栈。
function fail(message: string): never {
	console.error(message);
	process.exit(1);
}

// API Key 前置门控:无 Key 或占位 Key 时打印指引并退出,而不是跑到一半才报错。
// 有效 Key 判定:以 "sk-" 开头且长度 > 20(.env.example 占位符 sk-your-api-key-here 恰为 20 字符)。
const apiKey = process.env.CTF_MODEL_API_KEY ?? process.env.OPENROUTER_API_KEY;
if (!apiKey || !(apiKey.startsWith("sk-") && apiKey.length > 20)) {
	fail(
		"未设置 API Key:请在项目根目录 .env 填入 CTF_MODEL_API_KEY(参考 .env.example),然后重试。",
	);
}

// CLI: --only <id> 只跑单题(便于冒烟)
function parseOnlyArg(): string | undefined {
	const args = process.argv.slice(2);
	const index = args.indexOf("--only");
	if (index === -1) return undefined;
	const value = args[index + 1];
	if (!value || value.startsWith("--")) {
		fail("--only 需要一个题目 id,例如: --only misc-ez-png");
	}
	return value;
}
const onlyId = parseOnlyArg();

const modelId = process.env.CTF_MODEL_ID ?? process.env.OPENROUTER_MODEL;
const provider = process.env.CTF_MODEL_PROVIDER ?? "openrouter";
const baseUrl = process.env.CTF_MODEL_BASE_URL;

if (!modelId) {
	fail(
		"未设置 MODEL。请在项目根目录创建 .env 文件(参考 .env.example):\n" +
			'  CTF_MODEL_ID = "deepseek-chat"\n' +
			"或设置环境变量 CTF_MODEL_ID / OPENROUTER_MODEL",
	);
}

// 模型构造。
const model: Model<"openai-completions"> = baseUrl
	? {
			id: modelId,
			name: modelId,
			api: "openai-completions",
			provider,
			baseUrl: baseUrl.replace(/\/+$/, ""),
			reasoning: thinkingEnabledFromEnv(),
			thinkingLevelMap:
				provider === "deepseek" || baseUrl.includes("deepseek.com")
					? deepseekThinkingLevelMap(modelId)
					: undefined,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: Number(process.env.CTF_MODEL_CONTEXT_WINDOW ?? 64_000),
			maxTokens: Number(process.env.CTF_MODEL_MAX_TOKENS ?? 4_096),
			compat: {
				supportsStore: false,
				supportsDeveloperRole: false,
				supportsUsageInStreaming: false,
				supportsStrictMode: false,
				supportsLongCacheRetention: false,
				maxTokensField: "max_tokens",
			},
		}
	: (() => {
			const builtin = getModel(provider as never, modelId as never) as
				| Model<"openai-completions">
				| undefined;
			if (!builtin)
				throw new Error(
					`Pi 未内置模型: ${provider}/${modelId}。自定义 API 请设置 .env 中的 API-KEY 和 MODEL,脚本会自动使用 ${provider} 的 API endpoint(当前推断: ${baseUrl ?? "未知"})`,
				);
			return {
				...builtin,
				contextWindow: Math.min(
					builtin.contextWindow,
					Number(process.env.CTF_MODEL_CONTEXT_WINDOW ?? 16_000),
				),
				maxTokens: Math.min(
					builtin.maxTokens,
					Number(process.env.CTF_MODEL_MAX_TOKENS ?? 4_096),
				),
				reasoning: thinkingEnabledFromEnv(),
				compat: {
					...builtin.compat,
					supportsDeveloperRole: false,
				},
			};
		})();

// 与 Project.open 共用 parseProjectConfig 统一 schema 校验。
const root = resolve(import.meta.dirname);
const configPath = join(root, ".pi", "ctf-config.json");
let parsedConfig: ProjectConfig;
try {
	parsedConfig = parseProjectConfig(
		JSON.parse(readFileSync(configPath, "utf-8")),
	);
} catch (error) {
	fail(
		`无法读取 ctf-config.json:${error instanceof Error ? error.message : String(error)}`,
	);
}
const activePlatform = parsedConfig.platform.plugin;

function buildSystemPrompt(): string {
	const lines = [
		"你是 CTF Solver;所有命令和文件操作必须使用 Docker sandbox tools。",
		"请始终使用中文进行思考和推理(reasoning 输出中文)。",
		"开始时必须调用 ctf_blackboard_read 查看共享知识。",
		"必须先调用 ctf_challenge_info,使用 ctf_download_attachment 下载附件,使用 read 读取附件。",
		"必须使用 bash 解码附件,使用 ctf_blackboard_record 记录解码结果,最后调用 ctf_submit_flag。",
		"若当前题提供 ctf_instance_start 工具,先启动实例并根据返回的 endpoint 连接；完成后销毁实例。",
	];
	return lines.join("\n");
}

let project: Project | undefined;
try {
	console.log(`\n[1/3] 打开 CTF Project(平台: ${activePlatform})`);
	project = await Project.open({
		root,
		platforms: [ctfdPlatform, gzctfPlatform],
	});

	console.log(
		`[2/3] 创建 ContestRunner(8 路并发 / maxAttempts 2 / 30min 超时 / retryDelay 2s)${onlyId ? `,仅跑 --only ${onlyId}` : ""}\n`,
	);
	const runner = new ContestRunner(project, {
		maxConcurrent: Number(process.env.CTF_SCHEDULER_MAX_CONCURRENT ?? 6),
		maxAttempts: 2,
		challengeTimeoutMs: 30 * 60_000,
		retryDelayMs: 2_000,
		createAgentOptions: () => ({
			// 原生思维链开关:CTF_MODEL_THINKING=on 时 thinkingLevel 生效(与 webui 同源 agent-config)
			streamFn: streamSimple as AgentOptions["streamFn"],
			getApiKey: (requestedProvider) =>
				requestedProvider === provider ? apiKey : undefined,
			initialState: {
				model,
				thinkingLevel: thinkingLevelFromEnv(),
				systemPrompt: buildSystemPrompt(),
			},
		}),
		compaction: true,
		prompt:
			"解决当前 CTF 题目。严格完成黑板读取、题目信息、附件下载、read 读取、bash 分析、黑板记录和 Flag 提交的完整工具链。",
		selectChallenge: (challenge) => (onlyId ? challenge.id === onlyId : true),
	});

	const summary = await runner.run();
	// 服务器题目列表中不存在 --only 时显式失败，避免 total=0 假通过。
	if (onlyId && summary.total === 0) {
		fail(`未找到题目 id: ${onlyId}`);
	}
	console.log(
		`\n[3/3] 完成: 共 ${summary.total} 题, solved=${summary.solved} failed=${summary.failed} cancelled=${summary.cancelled} skipped=${summary.skipped}, 总尝试 ${summary.attempts} 次`,
	);
	for (const result of summary.results) {
		if (result.status !== "skipped") {
			console.log(
				`  - ${result.challengeId}: ${result.status}${result.error ? ` (${result.error})` : ""}`,
			);
		}
	}

	if (summary.failed > 0) process.exitCode = 1;
} catch (error) {
	console.error(
		`\n批量解题失败:${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
	);
	process.exitCode = 1;
} finally {
	await project?.close();
}
