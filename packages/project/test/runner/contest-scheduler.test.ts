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
import {
	ContestScheduler,
	type ContestSchedulerError,
} from "../../src/contest-scheduler.ts";
import { Project } from "../../src/project.ts";
import { type TestChallenge, TestPlatformPlugin } from "../fake-platform.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

class SandboxTracker {
	active = 0;
	maximum = 0;
	closed = 0;

	create = async (_options: DockerSandboxOptions): Promise<Sandbox> => {
		this.active++;
		this.maximum = Math.max(this.maximum, this.active);
		let closed = false;
		return {
			id: `sandbox-${this.maximum}-${this.active}`,
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

function challenge(
	index: number,
	options: Partial<TestChallenge> = {},
): TestChallenge {
	return {
		id: `challenge-${index}`,
		title: `Challenge ${index}`,
		category: "misc",
		score: 100 + index,
		description: "Mock challenge",
		attachments: [],
		flag: `MOCK{${index}}`,
		...options,
	};
}

function requiredChallenge(item: TestChallenge | undefined): TestChallenge {
	if (!item) throw new Error("调度器引用了未知测试题目");
	return item;
}

async function fixture(challenges: TestChallenge[], tracker: SandboxTracker) {
	const root = await mkdtemp(join(tmpdir(), "ctf-scheduler-"));
	roots.push(root);
	await mkdir(join(root, ".pi"), { recursive: true });
	await writeFile(
		join(root, ".pi", "ctf-config.json"),
		JSON.stringify({
			version: 1,
			project: { id: "scheduler-test", name: "Scheduler Test" },
			platform: { plugin: "test", config: { challenges } },
			sandbox: { image: "unused", privileged: false, networkMode: "none" },
		}),
	);
	const project = await Project.open({
		root,
		platforms: [new TestPlatformPlugin()],
		sandboxFactory: tracker.create,
		telemetry: { level: "full" },
	});
	return project;
}

function solvingAgent(item: TestChallenge, delayMs = 20): AgentOptions {
	const faux = createFauxCore({ provider: `scheduler-${item.id}` });
	faux.setResponses([
		async () => {
			await new Promise((resolve) => setTimeout(resolve, delayMs));
			return fauxAssistantMessage(
				[
					fauxToolCall(
						"bash",
						{ command: `printf '%s' '${item.flag}'` },
						{ id: `bash-${item.id}` },
					),
					fauxToolCall(
						"ctf_submit_flag",
						{ flag: item.flag },
						{ id: `submit-${item.id}` },
					),
				],
				{ stopReason: "toolUse" },
			);
		},
		fauxAssistantMessage("done"),
	]);
	return {
		streamFn: faux.streamSimple as AgentOptions["streamFn"],
		initialState: { model: faux.getModel(), thinkingLevel: "off" },
	};
}

describe("ContestScheduler", () => {
	it("自动模式按并发上限调度全部未解题，并记录 auto 来源", async () => {
		const challenges = [challenge(1), challenge(2), challenge(3), challenge(4)];
		const byId = new Map(challenges.map((item) => [item.id, item]));
		const tracker = new SandboxTracker();
		const project = await fixture(challenges, tracker);
		const scheduler = new ContestScheduler(project, {
			maxConcurrent: 2,
			maxAttempts: 2,
			createAgentOptions: ({ challenge: summary }) =>
				solvingAgent(requiredChallenge(byId.get(summary.id))),
		});

		try {
			await scheduler.startAuto();
			await waitUntil(
				() =>
					project.runs().filter((run) => run.status === "solved").length ===
						4 && scheduler.snapshot().active.length === 0,
			);

			expect(scheduler.snapshot()).toMatchObject({
				autoEnabled: true,
				queued: [],
				active: [],
			});
			expect(project.runs()).toHaveLength(4);
			expect(project.runs().every((run) => run.source === "auto")).toBe(true);
			const [firstRun] = project.runs();
			if (!firstRun) throw new Error("调度器未创建 Run");
			expect(project.runEvents(firstRun.id)).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						type: "tool_started",
						data: expect.objectContaining({
							toolName: "bash",
							args: {
								command: `printf '%s' '${byId.get(firstRun.challengeId)?.flag}'`,
							},
						}),
					}),
					expect.objectContaining({
						type: "flag_submitted",
						data: expect.objectContaining({
							flag: byId.get(firstRun.challengeId)?.flag,
							status: "accepted",
						}),
					}),
				]),
			);
			expect(tracker.maximum).toBeLessThanOrEqual(2);
			expect(tracker.maximum).toBeGreaterThan(1);
		} finally {
			await scheduler.shutdown();
			await project.close();
		}
	});

	it("自主模式暂停时仍允许人工调度，并可取消活跃题目", async () => {
		const item = challenge(1);
		const tracker = new SandboxTracker();
		const project = await fixture([item], tracker);
		const scheduler = new ContestScheduler(project, {
			maxConcurrent: 1,
			maxAttempts: 2,
			createAgentOptions: () => solvingAgent(item, 500),
		});

		try {
			expect(scheduler.snapshot().autoEnabled).toBe(false);
			await scheduler.dispatch(item.id);
			await waitUntil(() => scheduler.snapshot().active[0]?.runId !== null);
			expect(scheduler.snapshot().active[0]?.source).toBe("manual");

			await scheduler.cancel(item.id);
			await waitUntil(() => scheduler.snapshot().active.length === 0);
			expect(project.runs()).toEqual([
				expect.objectContaining({
					challengeId: item.id,
					source: "manual",
					status: "cancelled",
					closeReason: "cancelled",
				}),
			]);
			expect(tracker.active).toBe(0);
		} finally {
			await scheduler.shutdown();
			await project.close();
		}
	});

	it("暂停自主模式后保留自动队列，但不再派发下一题", async () => {
		const challenges = [challenge(1), challenge(2)];
		const tracker = new SandboxTracker();
		const project = await fixture(challenges, tracker);
		const scheduler = new ContestScheduler(project, {
			maxConcurrent: 1,
			maxAttempts: 1,
			createAgentOptions: ({ challenge: summary }) =>
				solvingAgent(
					requiredChallenge(challenges.find((item) => item.id === summary.id)),
					500,
				),
		});

		try {
			await scheduler.startAuto();
			await waitUntil(
				() =>
					scheduler.snapshot().active.length === 1 &&
					scheduler.snapshot().queued.length === 1,
			);
			const activeId = scheduler.snapshot().active[0]?.challengeId;
			const queuedId = scheduler.snapshot().queued[0]?.challengeId;

			scheduler.pauseAuto();
			if (!activeId) throw new Error("自主调度未创建活跃任务");
			await scheduler.cancel(activeId);
			await waitUntil(() => scheduler.snapshot().active.length === 0);

			expect(scheduler.snapshot()).toMatchObject({
				autoEnabled: false,
				queued: [
					expect.objectContaining({
						challengeId: queuedId,
						source: "auto",
					}),
				],
				active: [],
			});
			expect(project.runs({ challengeId: queuedId })).toHaveLength(0);
		} finally {
			await scheduler.shutdown();
			await project.close();
		}
	});

	it("未配置模型时拒绝控制操作", async () => {
		const item = challenge(1);
		const project = await fixture([item], new SandboxTracker());
		const scheduler = new ContestScheduler(project, {
			maxConcurrent: 1,
			available: false,
			unavailableReason: "missing model",
			createAgentOptions: () => solvingAgent(item),
		});
		try {
			await expect(scheduler.startAuto()).rejects.toMatchObject({
				code: "unavailable",
			} satisfies Partial<ContestSchedulerError>);
			await expect(scheduler.dispatch(item.id)).rejects.toMatchObject({
				code: "unavailable",
			} satisfies Partial<ContestSchedulerError>);
		} finally {
			await scheduler.shutdown();
			await project.close();
		}
	});

	it("运行时配置模型后立即开放调度操作", async () => {
		const item = challenge(1);
		const project = await fixture([item], new SandboxTracker());
		let configured = false;
		const scheduler = new ContestScheduler(project, {
			maxConcurrent: 1,
			availability: () => ({
				available: configured,
				...(configured ? {} : { unavailableReason: "missing model" }),
			}),
			createAgentOptions: () => solvingAgent(item),
		});
		try {
			expect(scheduler.snapshot()).toMatchObject({
				available: false,
				unavailableReason: "missing model",
			});
			await expect(scheduler.dispatch(item.id)).rejects.toMatchObject({
				code: "unavailable",
			} satisfies Partial<ContestSchedulerError>);

			configured = true;
			expect(scheduler.snapshot().available).toBe(true);
			await scheduler.dispatch(item.id);
			await waitUntil(
				() =>
					project.runs().some((run) => run.status === "solved") &&
					scheduler.snapshot().active.length === 0,
			);
			expect(project.runs()[0]).toMatchObject({
				challengeId: item.id,
				status: "solved",
			});
		} finally {
			await scheduler.shutdown();
			await project.close();
		}
	});
});

async function waitUntil(
	predicate: () => boolean,
	timeoutMs = 2_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("等待调度状态超时");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}
