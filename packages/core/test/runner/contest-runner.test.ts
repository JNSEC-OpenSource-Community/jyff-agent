import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	CommandResult,
	DockerSandboxOptions,
	Sandbox,
} from "@ctf-agent/sandbox";
import type { AgentOptions } from "@earendil-works/pi-agent-core";
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it } from "vitest";
import { ContestRunner } from "../../src/orchestration/contest-runner.js";
import { Project } from "../../src/project/project.js";
import { type TestChallenge, TestPlatformPlugin } from "../fake-platform.ts";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

function requiredChallenge(item: TestChallenge | undefined): TestChallenge {
	if (!item) throw new Error("Runner 引用了未知测试题目");
	return item;
}

class SandboxTracker {
	active = 0;
	maximum = 0;
	created = 0;
	closed = 0;

	create = async (_options: DockerSandboxOptions): Promise<Sandbox> => {
		this.active++;
		this.created++;
		this.maximum = Math.max(this.maximum, this.active);
		let closed = false;
		return {
			id: `sandbox-${this.created}`,
			exec: async (): Promise<CommandResult> => ({
				code: 0,
				stdout: "",
				stderr: "",
			}),
			close: async () => {
				if (closed) return;
				closed = true;
				this.active--;
				this.closed++;
			},
		};
	};
}

async function projectFixture(
	challenges: TestChallenge[],
	tracker: SandboxTracker,
) {
	const root = await mkdtemp(join(tmpdir(), "ctf-runner-"));
	roots.push(root);
	await mkdir(join(root, ".pi"), { recursive: true });
	await writeFile(
		join(root, ".pi", "ctf-config.json"),
		JSON.stringify({
			version: 1,
			project: { id: "runner-test", name: "Runner Test" },
			platform: { plugin: "test", config: { challenges } },
			sandbox: { image: "unused", privileged: false, networkMode: "none" },
		}),
	);
	const plugin = new TestPlatformPlugin();
	const project = await Project.open({
		root,
		platforms: [plugin],
		sandboxFactory: tracker.create,
	});
	return { project, plugin };
}

function solvingAgent(
	challenge: TestChallenge,
	attempt: number,
	responseDelayMs = 25,
): AgentOptions {
	const faux = createFauxCore({
		provider: `runner-${challenge.id}-${attempt}`,
	});
	const calls = [
		...(challenge.remote
			? [
					fauxToolCall(
						"ctf_instance_start",
						{},
						{ id: `start-${challenge.id}-${attempt}` },
					),
				]
			: []),
		fauxToolCall(
			"ctf_submit_flag",
			{ flag: challenge.flag },
			{ id: `submit-${challenge.id}-${attempt}` },
		),
	];
	faux.setResponses([
		async () => {
			await new Promise((resolve) => setTimeout(resolve, responseDelayMs));
			return fauxAssistantMessage(calls, { stopReason: "toolUse" });
		},
		fauxAssistantMessage("本次尝试结束。"),
	]);
	return {
		streamFn: faux.streamSimple as AgentOptions["streamFn"],
		initialState: { model: faux.getModel(), thinkingLevel: "off" },
	};
}

function challenge(
	index: number,
	options: Partial<TestChallenge> = {},
): TestChallenge {
	return {
		id: `challenge-${index}`,
		title: `Challenge ${index}`,
		category: index % 2 === 0 ? "pwn" : "web",
		score: 100 + index,
		description: "Mock challenge",
		attachments: [],
		flag: `MOCK{${index}}`,
		...options,
	};
}

describe("ContestRunner", () => {
	it("按并发上限解决多题，对平台故障有限重试，并回收全部资源", async () => {
		const challenges = [
			challenge(0, { remote: true }),
			challenge(1),
			challenge(2, { remote: true, failures: { submit: 1 } }),
			challenge(3, { failures: { bind: 1 } }),
			challenge(4, { remote: true }),
			challenge(5),
			challenge(6, { remote: true }),
			challenge(7),
		];
		const byId = new Map(challenges.map((item) => [item.id, item]));
		const tracker = new SandboxTracker();
		const { project, plugin } = await projectFixture(challenges, tracker);

		try {
			const runner = new ContestRunner(project, {
				maxConcurrent: 3,
				maxAttempts: 2,
				challengeTimeoutMs: 2_000,
				retryDelayMs: 1,
				createAgentOptions: ({ challenge: summary, attempt }) =>
					solvingAgent(requiredChallenge(byId.get(summary.id)), attempt),
			});
			const summary = await runner.run();

			expect(summary).toMatchObject({
				total: 8,
				solved: 8,
				failed: 0,
				cancelled: 0,
				attempts: 10,
			});
			expect(
				summary.results.every((result) => result.status === "solved"),
			).toBe(true);
			expect(tracker.maximum).toBeGreaterThan(1);
			expect(tracker.maximum).toBeLessThanOrEqual(3);
			expect(tracker.active).toBe(0);
			expect(tracker.closed).toBe(tracker.created);

			const diagnostics = plugin.diagnostics();
			expect(diagnostics.bindAttempts["challenge-3"]).toBe(2);
			expect(diagnostics.submissions["challenge-2"]).toBe(2);
			expect(diagnostics.activeEnvironments).toBe(0);
			expect(diagnostics.instanceStarts).toBeGreaterThan(0);
			expect(diagnostics.instanceDestroys).toBe(diagnostics.instanceStarts);

			const runs = project.runs();
			expect(runs).toHaveLength(10);
			expect(runs.filter((run) => run.status === "solved")).toHaveLength(8);
			expect(runs.filter((run) => run.status === "failed")).toHaveLength(2);
			expect(
				runs.every((run) => !["preparing", "running"].includes(run.status)),
			).toBe(true);
		} finally {
			await project.close();
		}
	});

	it("硬超时后即使模型尚未返回，也会标记 timed_out 并强制销毁实例和 Sandbox", async () => {
		const remote = challenge(0, { remote: true });
		const tracker = new SandboxTracker();
		const { project, plugin } = await projectFixture([remote], tracker);

		try {
			const runner = new ContestRunner(project, {
				maxConcurrent: 1,
				maxAttempts: 1,
				challengeTimeoutMs: 50,
				abortGraceMs: 5,
				createAgentOptions: () => {
					const faux = createFauxCore({ provider: "runner-timeout" });
					faux.setResponses([
						fauxAssistantMessage(
							fauxToolCall("ctf_instance_start", {}, { id: "start-timeout" }),
							{ stopReason: "toolUse" },
						),
						async () => {
							await new Promise((resolve) => setTimeout(resolve, 250));
							return fauxAssistantMessage("too late");
						},
					]);
					return {
						streamFn: faux.streamSimple as AgentOptions["streamFn"],
						initialState: { model: faux.getModel(), thinkingLevel: "off" },
					};
				},
			});
			const summary = await runner.run();

			expect(summary).toMatchObject({
				total: 1,
				solved: 0,
				failed: 1,
				attempts: 1,
			});
			expect(project.runs()).toEqual([
				expect.objectContaining({
					status: "timed_out",
					closeReason: "timed_out",
				}),
			]);
			expect(tracker.active).toBe(0);
			expect(tracker.closed).toBe(1);
			expect(plugin.diagnostics()).toMatchObject({
				instanceStarts: 1,
				instanceDestroys: 1,
				activeEnvironments: 0,
			});
		} finally {
			await project.close();
		}
	});

	it("stop 会取消活跃 Agent，并等待远程实例与 Sandbox 完成清理", async () => {
		const remote = challenge(0, { remote: true });
		const tracker = new SandboxTracker();
		const { project, plugin } = await projectFixture([remote], tracker);

		try {
			const runner = new ContestRunner(project, {
				maxConcurrent: 1,
				maxAttempts: 1,
				challengeTimeoutMs: 5_000,
				abortGraceMs: 5,
				createAgentOptions: () => {
					const faux = createFauxCore({ provider: "runner-stop" });
					faux.setResponses([
						fauxAssistantMessage(
							fauxToolCall("ctf_instance_start", {}, { id: "start-stop" }),
							{ stopReason: "toolUse" },
						),
						async () => {
							await new Promise((resolve) => setTimeout(resolve, 250));
							return fauxAssistantMessage("too late");
						},
					]);
					return {
						streamFn: faux.streamSimple as AgentOptions["streamFn"],
						initialState: { model: faux.getModel(), thinkingLevel: "off" },
					};
				},
			});

			const running = runner.run();
			await waitUntil(() => plugin.diagnostics().instanceStarts === 1);
			await runner.stop();
			const summary = await running;

			expect(summary).toMatchObject({
				total: 1,
				solved: 0,
				cancelled: 1,
				attempts: 1,
			});
			expect(project.runs()).toEqual([
				expect.objectContaining({
					status: "cancelled",
					closeReason: "cancelled",
				}),
			]);
			expect(tracker.active).toBe(0);
			expect(plugin.diagnostics()).toMatchObject({
				instanceStarts: 1,
				instanceDestroys: 1,
				activeEnvironments: 0,
			});
		} finally {
			await project.close();
		}
	});
});

async function waitUntil(
	predicate: () => boolean,
	timeoutMs = 1_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("等待条件超时");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}
