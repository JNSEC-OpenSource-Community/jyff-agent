import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it } from "vite-plus/test"
import { RunStore } from "../../src/persistence/run-store.js"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function storeFixture(): Promise<{
  root: string
  path: string
  store: RunStore
}> {
  const root = await mkdtemp(join(tmpdir(), "ctf-run-store-"))
  roots.push(root)
  const path = join(root, "runs.sqlite")
  return { root, path, store: await RunStore.open(path) }
}

describe("RunStore", () => {
  it("持久化最后一次成功的平台视图", async () => {
    const { path, store } = await storeFixture()
    store.cachePlatformView("overview", {
      id: "contest-1",
      name: "Cached CTF",
      challenges: 1,
      announcements: 1,
    })
    store.cachePlatformView("challenges", [
      {
        id: "web-1",
        title: "Cached Web",
        category: "web",
        score: 500,
        solved: false,
      },
    ])
    store.cachePlatformView("announcements", [
      {
        id: "notice-1",
        title: "Hint",
        content: "Attachment updated",
        publishedAt: "2026-08-10T00:00:00.000Z",
      },
    ])
    store.close()

    const reopened = await RunStore.open(path)
    expect(reopened.platformViewCache()).toMatchObject({
      overview: { name: "Cached CTF" },
      challenges: [{ id: "web-1", title: "Cached Web", score: 500 }],
      announcements: [{ id: "notice-1", title: "Hint" }],
    })
    reopened.close()
  })

  it("持久化并清除题目人工调度状态", async () => {
    const { path, store } = await storeFixture()
    expect(store.challengeSchedulingDisposition("web-skip")).toBeNull()
    store.setChallengeSchedulingDisposition("web-skip", "excluded")
    store.setChallengeSchedulingDisposition("crypto-solved", "solved")
    store.close()

    const reopened = await RunStore.open(path)
    expect(reopened.challengeSchedulingDisposition("web-skip")).toBe("excluded")
    expect(reopened.challengeSchedulingDisposition("crypto-solved")).toBe("solved")
    expect(reopened.challengeSchedulingOverrides()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          challengeId: "web-skip",
          disposition: "excluded",
        }),
        expect.objectContaining({
          challengeId: "crypto-solved",
          disposition: "solved",
        }),
      ]),
    )
    reopened.setChallengeSchedulingDisposition("web-skip", null)
    expect(reopened.challengeSchedulingDisposition("web-skip")).toBeNull()
    reopened.close()
  })

  it("持久化远程环境租约并随 Run 删除", async () => {
    const { path, store } = await storeFixture()
    store.createRun({
      id: "run-environment",
      challengeId: "pwn-1",
      workspace: "workspace",
      attempt: 1,
    })
    store.saveEnvironmentLease({
      runId: "run-environment",
      challengeId: "pwn-1",
      environmentId: "environment-1",
      priority: "verification",
      acquiredAt: "2026-01-01T00:00:00.000Z",
    })
    store.close()

    const reopened = await RunStore.open(path)
    expect(reopened.listEnvironmentLeases()).toEqual([
      {
        runId: "run-environment",
        challengeId: "pwn-1",
        environmentId: "environment-1",
        priority: "verification",
        acquiredAt: "2026-01-01T00:00:00.000Z",
      },
    ])
    reopened.deleteEnvironmentLease("run-environment")
    expect(reopened.listEnvironmentLeases()).toEqual([])
    reopened.close()
  })

  it("持久化 Run 状态、attempt 和事件，并可在重开后查询", async () => {
    const { path, store } = await storeFixture()
    store.createRun({
      id: "run-1",
      challengeId: "web-1",
      workspace: "workspace",
      attempt: 1,
    })
    store.updateRun(
      "run-1",
      { status: "running", startedAt: "2026-01-01T00:00:00.000Z" },
      "run_started",
    )
    store.updateRun(
      "run-1",
      {
        status: "solved",
        closeReason: "submitted",
        finishedAt: "2026-01-01T00:01:00.000Z",
      },
      "run_finished",
    )

    expect(store.isSolved("web-1")).toBe(true)
    expect(store.nextAttempt("web-1")).toBe(2)
    expect(store.events("run-1").map((event) => event.type)).toEqual([
      "run_created",
      "run_started",
      "run_finished",
    ])
    store.close()

    const reopened = await RunStore.open(path)
    expect(reopened.listRuns({ challengeId: "web-1" })).toEqual([
      expect.objectContaining({
        id: "run-1",
        status: "solved",
        closeReason: "submitted",
        attempt: 1,
      }),
    ])
    reopened.close()
  })

  it("agent_thinking 事件可持久化与读取(data 原文保留)", async () => {
    const { path, store } = await storeFixture()
    store.createRun({
      id: "run-1",
      challengeId: "web-1",
      workspace: "workspace",
      attempt: 1,
    })
    const thinking = { text: "先枚举 /robots.txt，再看响应头", ts: "chunk-1" }

    const appended = store.appendEvent("run-1", "agent_thinking", thinking)
    expect(appended).toMatchObject({
      runId: "run-1",
      type: "agent_thinking",
      data: thinking,
    })
    expect(appended.createdAt).toBeTruthy()

    const persisted = store.events("run-1").find((event) => event.type === "agent_thinking")
    expect(persisted).toEqual(
      expect.objectContaining({
        runId: "run-1",
        type: "agent_thinking",
        data: thinking,
      }),
    )
    store.close()

    const reopened = await RunStore.open(path)
    const afterReopen = reopened.events("run-1").find((event) => event.type === "agent_thinking")
    expect(afterReopen).toEqual(
      expect.objectContaining({
        type: "agent_thinking",
        data: thinking,
      }),
    )
    reopened.close()
  })

  it("tool_started 事件可持久化与读取(含屏蔽后的命令参数)", async () => {
    const { store } = await storeFixture()
    store.createRun({
      id: "run-tool",
      challengeId: "misc-1",
      workspace: "workspace",
      attempt: 1,
    })

    const event = store.appendEvent("run-tool", "tool_started", {
      toolName: "bash",
      args: { command: "[omitted]" },
    })
    expect(event).toMatchObject({ runId: "run-tool", type: "tool_started" })
    expect(store.events("run-tool").at(-1)?.data).toEqual({
      toolName: "bash",
      args: { command: "[omitted]" },
    })
    store.close()
  })

  it("可直接读取最后事件，避免 Dashboard 扫描完整时间线", async () => {
    const { store } = await storeFixture()
    store.createRun({
      id: "run-latest",
      challengeId: "misc-1",
      workspace: "workspace",
      attempt: 1,
    })
    store.appendEvent("run-latest", "agent_thinking", { text: "first" })
    const latest = store.appendEvent("run-latest", "agent_message", {
      text: "done",
    })

    expect(store.latestEvent("run-latest")).toEqual(latest)
    expect(store.latestEvent("missing")).toBeUndefined()
    store.close()
  })

  it("agent_usage 事件可持久化与读取(data 原文保留,含 cost 与 reasoning)", async () => {
    const { path, store } = await storeFixture()
    store.createRun({
      id: "run-1",
      challengeId: "web-1",
      workspace: "workspace",
      attempt: 1,
    })
    const usage = {
      input: 1200,
      output: 340,
      cacheRead: 800,
      cacheWrite: 0,
      reasoning: 200,
      totalTokens: 1540,
      cost: {
        input: 0.01,
        output: 0.02,
        cacheRead: 0.001,
        cacheWrite: 0,
        total: 0.031,
      },
      ts: "2026-08-02T12:00:00.000Z",
    }

    const appended = store.appendEvent("run-1", "agent_usage", usage)
    expect(appended).toMatchObject({
      runId: "run-1",
      type: "agent_usage",
      data: usage,
    })
    expect(appended.createdAt).toBeTruthy()

    const persisted = store.events("run-1").find((event) => event.type === "agent_usage")
    expect(persisted).toEqual(
      expect.objectContaining({
        runId: "run-1",
        type: "agent_usage",
        data: usage,
      }),
    )
    store.close()

    const reopened = await RunStore.open(path)
    const afterReopen = reopened.events("run-1").find((event) => event.type === "agent_usage")
    expect(afterReopen).toEqual(
      expect.objectContaining({
        type: "agent_usage",
        data: usage,
      }),
    )
    reopened.close()
  })

  it("启动恢复时把遗留 preparing/running Run 标记为 interrupted", async () => {
    const { store } = await storeFixture()
    store.createRun({
      id: "preparing",
      challengeId: "pwn-1",
      workspace: "a",
      attempt: 1,
    })
    store.createRun({
      id: "running",
      challengeId: "pwn-2",
      workspace: "b",
      attempt: 1,
    })
    store.updateRun("running", { status: "running" })

    const interrupted = store.markInterruptedRuns("测试恢复")
    expect(interrupted).toHaveLength(2)
    expect(store.listRuns().map((run) => run.status)).toEqual(["interrupted", "interrupted"])
    expect(
      store
        .listRuns()
        .every((run) => run.closeReason === "interrupted" && run.error === "测试恢复"),
    ).toBe(true)
    store.close()
  })

  it("只把调度来源计入重试预算，并为直接运行保留兼容默认值", async () => {
    const { store } = await storeFixture()
    store.createRun({
      id: "direct",
      challengeId: "rev-1",
      workspace: "a",
      attempt: 1,
    })
    store.updateRun("direct", { status: "closed", closeReason: "manual" })
    store.createRun({
      id: "test",
      challengeId: "rev-1",
      workspace: "b",
      attempt: 2,
      source: "test",
    })
    store.updateRun("test", { status: "closed", closeReason: "manual" })
    store.createRun({
      id: "manual",
      challengeId: "rev-1",
      workspace: "c",
      attempt: 3,
      source: "manual",
    })
    store.updateRun("manual", { status: "closed", closeReason: "manual" })
    store.createRun({
      id: "retry",
      challengeId: "rev-1",
      workspace: "d",
      attempt: 4,
      source: "retry",
    })

    expect(store.getRun("direct")?.source).toBe("direct")
    expect(store.schedulerAttemptCount("rev-1")).toBe(2)
    store.close()
  })

  it("平台瞬时故障的创建失败不消耗调度 attempt", async () => {
    const { store } = await storeFixture()
    store.createRun({
      id: "infra-failure",
      challengeId: "web-1",
      workspace: "workspace",
      attempt: 1,
      source: "auto",
    })
    store.updateRun(
      "infra-failure",
      { status: "failed", error: "HTTP 502" },
      "run_creation_failed",
      { error: "HTTP 502", retryable: true },
    )

    expect(store.schedulerAttemptCount("web-1")).toBe(0)
    expect(store.nextAttempt("web-1")).toBe(2)
    store.close()
  })

  it("同一 session 内处理的瞬时错误仍计为一个调度 attempt", async () => {
    const { store } = await storeFixture()
    store.createRun({
      id: "same-attempt-retry",
      challengeId: "web-retry",
      workspace: "workspace",
      attempt: 1,
      source: "auto",
    })
    store.appendEvent("same-attempt-retry", "run_transient_failure", {
      retryable: true,
      sameAttempt: true,
      retryScheduled: true,
    })
    store.updateRun("same-attempt-retry", {
      status: "solved",
      closeReason: "submitted",
    })

    expect(store.schedulerAttemptCount("web-retry")).toBe(1)
    store.close()
  })

  it("持久化 Session 中断计数和 blocked，并支持人工重置", async () => {
    const { store } = await storeFixture()
    store.createRun({
      id: "interrupted",
      challengeId: "web-blocked",
      workspace: "a",
      attempt: 1,
      source: "auto",
    })
    store.updateRun("interrupted", {
      status: "interrupted",
      closeReason: "interrupted",
    })
    store.createRun({
      id: "blocked",
      challengeId: "web-blocked",
      workspace: "b",
      attempt: 2,
      source: "retry",
    })
    store.updateRun("blocked", {
      status: "blocked",
      closeReason: "blocked",
    })

    expect(store.sessionInterruptionCount("web-blocked")).toBe(2)
    expect(store.challengeRuntimeState("web-blocked")).toMatchObject({
      blockScore: 2,
      blocked: true,
      blockedRunId: "blocked",
    })
    expect(store.isChallengeBlocked("web-blocked")).toBe(true)
    expect(store.schedulerAttemptCount("web-blocked")).toBe(0)

    store.resetSessionInterruptions("web-blocked")
    expect(store.sessionInterruptionCount("web-blocked")).toBe(0)
    expect(store.challengeRuntimeState("web-blocked")).toMatchObject({
      blockScore: 0,
      blocked: false,
      blockedAt: null,
      blockedRunId: null,
    })
    expect(store.isChallengeBlocked("web-blocked")).toBe(false)
    expect(store.events("blocked").at(-1)?.type).toBe("session_interruptions_reset")
    store.close()
  })

  it("公告 delivery outbox 对 Run 幂等，并允许 failed 重试", async () => {
    const { store } = await storeFixture()
    store.persistContestAnnouncement({
      key: "notice:revision",
      platformAnnouncementId: "notice",
      revisionHash: "revision",
      title: "Hint",
      content: "Cookie Jar",
      publishedAt: "2026-01-01T00:00:00.000Z",
      kind: "hint",
    })
    store.createRun({
      id: "delivery-run",
      challengeId: "web-1",
      workspace: "workspace",
      attempt: 1,
    })
    const input = {
      challengeId: "web-1",
      announcementKey: "notice:revision",
      runId: "delivery-run",
    }
    expect(store.enqueueAnnouncementDelivery(input)).toBe(true)
    expect(store.enqueueAnnouncementDelivery(input)).toBe(false)
    expect(
      store.observeAnnouncementDelivery({
        ...input,
        status: "failed",
        error: "busy",
      }),
    ).toMatchObject({ status: "failed", attempts: 1, lastError: "busy" })
    expect(store.enqueueAnnouncementDelivery(input)).toBe(true)
    expect(store.announcementDeliveries("web-1")).toEqual([
      expect.objectContaining({ status: "queued", attempts: 1 }),
    ])
    store.close()
  })

  it("持久化题目级 TLDR 并在更新时覆盖旧错误", async () => {
    const { path, store } = await storeFixture()
    expect(
      store.upsertTldr({
        challengeId: "web-1",
        model: "cheap-model",
        sessionPath: "/tmp/tldr/session.jsonl",
        error: "provider unavailable",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toMatchObject({ content: "", error: "provider unavailable" })
    expect(
      store.upsertTldr({
        challengeId: "web-1",
        content: "# TLDR\\nConfirmed: cookie is reflected.",
        model: "cheap-model-v2",
        sessionPath: "/tmp/tldr/session.jsonl",
        updatedAt: "2026-01-01T00:02:00.000Z",
        error: null,
        inputTokens: 200,
        cacheReadTokens: 800,
        cacheWriteTokens: 50,
      }),
    ).toEqual({
      challengeId: "web-1",
      content: "# TLDR\\nConfirmed: cookie is reflected.",
      model: "cheap-model-v2",
      sessionPath: "/tmp/tldr/session.jsonl",
      updatedAt: "2026-01-01T00:02:00.000Z",
      error: null,
      inputTokens: 200,
      cacheReadTokens: 800,
      cacheWriteTokens: 50,
    })
    expect(
      store.upsertTldr({
        challengeId: "web-1",
        model: "cheap-model-v2",
        sessionPath: "/tmp/tldr/session.jsonl",
        error: "temporary failure",
      }),
    ).toMatchObject({
      content: "# TLDR\\nConfirmed: cookie is reflected.",
      cacheReadTokens: 800,
      error: "temporary failure",
    })
    store.close()
    const reopened = await RunStore.open(path)
    expect(reopened.tldr("web-1")?.content).toContain("cookie")
    reopened.close()
  })

  it("幂等持久化公告 revision 和题目关联", async () => {
    const { path, store } = await storeFixture()
    const input = {
      key: "notice-1:hash-a",
      platformAnnouncementId: "notice-1",
      revisionHash: "hash-a",
      title: "New hint",
      content: "Hint for Cookie Jar",
      publishedAt: "2026-01-01T00:00:00.000Z",
      kind: "hint",
      classificationReason: "platform_kind",
      seenAt: "2026-01-01T00:01:00.000Z",
    }
    store.persistContestAnnouncement(input)
    store.persistContestAnnouncement({
      ...input,
      seenAt: "2026-01-01T00:02:00.000Z",
    })
    expect(
      store.linkChallengeAnnouncement({
        challengeId: "web-1",
        announcementKey: input.key,
        matchType: "title",
        matchedValue: "Cookie Jar",
        matchedKeywords: ["hint"],
      }),
    ).toBe(true)
    expect(
      store.linkChallengeAnnouncement({
        challengeId: "web-1",
        announcementKey: input.key,
        matchType: "title",
        matchedValue: "Cookie Jar",
      }),
    ).toBe(false)
    expect(store.challengeAnnouncements("web-1")).toEqual([])
    expect(store.announcementCandidates()).toEqual([
      expect.objectContaining({
        key: input.key,
        challengeId: "web-1",
        lastSeenAt: "2026-01-01T00:02:00.000Z",
        matchType: "title",
        matchedKeywords: ["hint"],
        approvalStatus: "pending",
      }),
    ])
    expect(
      store.reviewChallengeAnnouncement({
        challengeId: "web-1",
        announcementKey: input.key,
        status: "approved",
        reviewedAt: "2026-01-01T00:03:00.000Z",
      }),
    ).toMatchObject({
      approvalStatus: "approved",
      reviewedAt: "2026-01-01T00:03:00.000Z",
    })
    expect(store.challengeAnnouncements("web-1")).toHaveLength(1)
    store.close()

    const reopened = await RunStore.open(path)
    expect(reopened.challengeAnnouncements("web-1")).toHaveLength(1)
    reopened.close()
  })

  it("打开旧数据库时自动补充公告审核字段并默认为待审核", async () => {
    const { path, store } = await storeFixture()
    store.close()
    const legacy = new DatabaseSync(path)
    legacy.exec("ALTER TABLE challenge_announcements DROP COLUMN reviewed_at")
    legacy.exec("ALTER TABLE challenge_announcements DROP COLUMN approval_status")
    legacy.exec("ALTER TABLE challenge_announcements DROP COLUMN matched_keywords_json")
    legacy.close()

    const migrated = await RunStore.open(path)
    const announcementKey = "legacy-notice:hash-a"
    migrated.persistContestAnnouncement({
      key: announcementKey,
      platformAnnouncementId: "legacy-notice",
      revisionHash: "hash-a",
      title: "Legacy hint",
      content: "A useful hint for Cookie Jar",
      publishedAt: "2026-01-01T00:00:00.000Z",
      kind: "hint",
      classificationReason: "platform_kind",
      seenAt: "2026-01-01T00:01:00.000Z",
    })
    expect(
      migrated.linkChallengeAnnouncement({
        challengeId: "web-1",
        announcementKey,
        matchType: "title",
        matchedValue: "Cookie Jar",
      }),
    ).toBe(true)
    expect(migrated.announcementCandidates()).toEqual([
      expect.objectContaining({
        key: announcementKey,
        matchedKeywords: [],
        approvalStatus: "pending",
        reviewedAt: null,
      }),
    ])
    expect(migrated.challengeAnnouncements("web-1")).toEqual([])
    migrated.close()
  })

  it("持久化 normal/blocked 队列、支持乐观锁重排和人工跨 lane 提前", async () => {
    const { path, store } = await storeFixture()
    const normal1 = store.enqueueSchedulerChallenge({
      challengeId: "normal-1",
      source: "auto",
    })
    store.enqueueSchedulerChallenge({
      challengeId: "normal-2",
      source: "auto",
    })
    const blocked = store.enqueueSchedulerChallenge({
      challengeId: "blocked-1",
      source: "revival",
      lane: "blocked",
    })

    expect(store.schedulerQueue().map((item) => item.challengeId)).toEqual([
      "normal-1",
      "normal-2",
      "blocked-1",
    ])
    const moved = store.moveSchedulerChallenge({
      challengeId: "normal-1",
      position: 2,
      expectedVersion: normal1.version,
    })
    expect(moved).toMatchObject({ position: 2, version: 2 })
    expect(() =>
      store.moveSchedulerChallenge({
        challengeId: "normal-1",
        position: 1,
        expectedVersion: normal1.version,
      }),
    ).toThrow("version conflict")

    store.moveSchedulerChallenge({
      challengeId: "blocked-1",
      position: 1,
      expectedVersion: blocked.version,
      overrideBlockedLane: true,
    })
    expect(store.schedulerQueue()[0]).toMatchObject({
      challengeId: "blocked-1",
      lane: "blocked",
      manualOverride: true,
    })
    expect(store.removeSchedulerChallenge("normal-2")).toBe(true)
    store.close()

    const reopened = await RunStore.open(path)
    expect(reopened.schedulerQueue().map((item) => item.challengeId)).toEqual([
      "blocked-1",
      "normal-1",
    ])
    reopened.close()
  })

  it("blocked 复活保留 score、增加阈值和 lifecycle generation", async () => {
    const { store } = await storeFixture()
    store.createRun({
      id: "revive-run",
      challengeId: "revive-challenge",
      workspace: "workspace",
      attempt: 1,
    })
    for (let index = 0; index < 6; index += 1) {
      store.recordChallengeBlockEvent({
        challengeId: "revive-challenge",
        runId: "revive-run",
        eventKey: `revive-score:${index}`,
        delta: 2,
        reason: "compact_boundary",
      })
    }
    const revived = store.reviveChallenge("revive-challenge")
    expect(revived).toMatchObject({
      blockScore: 12,
      revivalCount: 1,
      effectiveBlockThreshold: 14,
      lifecycleGeneration: 1,
      blocked: false,
    })
    store.close()
  })

  it("从数据库层拒绝同题创建两个 active Run", async () => {
    const { store } = await storeFixture()
    store.createRun({
      id: "active-1",
      challengeId: "same-challenge",
      workspace: "a",
      attempt: 1,
    })
    expect(() =>
      store.createRun({
        id: "active-2",
        challengeId: "same-challenge",
        workspace: "b",
        attempt: 2,
      }),
    ).toThrow()

    store.updateRun("active-1", {
      status: "interrupted",
      closeReason: "interrupted",
    })
    expect(
      store.createRun({
        id: "active-2",
        challengeId: "same-challenge",
        workspace: "b",
        attempt: 2,
      }).id,
    ).toBe("active-2")
    store.close()
  })

  it("以幂等 block event ledger 计分，并仅在 score 大于阈值时 blocked", async () => {
    const { store } = await storeFixture()
    store.createRun({
      id: "score-run",
      challengeId: "crypto-score",
      workspace: "workspace",
      attempt: 1,
    })

    for (let index = 1; index <= 5; index += 1) {
      store.recordChallengeBlockEvent({
        challengeId: "crypto-score",
        runId: "score-run",
        eventKey: `compact:${index}`,
        delta: 2,
        reason: "compact_boundary",
        compactPerformed: true,
      })
    }
    expect(store.challengeRuntimeState("crypto-score")).toMatchObject({
      blockScore: 10,
      effectiveBlockThreshold: 10,
      blocked: false,
    })

    const blocked = store.recordChallengeBlockEvent({
      challengeId: "crypto-score",
      runId: "score-run",
      eventKey: "stop:5",
      delta: 1,
      reason: "model_stop",
    })
    expect(blocked).toMatchObject({
      scoreBefore: 10,
      scoreAfter: 11,
      threshold: 10,
    })
    expect(store.challengeRuntimeState("crypto-score")).toMatchObject({
      blockScore: 11,
      blocked: true,
      blockedRunId: "score-run",
    })

    const replay = store.recordChallengeBlockEvent({
      challengeId: "crypto-score",
      runId: "score-run",
      eventKey: "stop:5",
      delta: 1,
      reason: "model_stop",
    })
    expect(replay).toEqual(blocked)
    expect(store.challengeBlockEvents("crypto-score")).toHaveLength(6)
    expect(store.challengeRuntimeState("crypto-score").blockScore).toBe(11)
    store.updateRun("score-run", {
      status: "blocked",
      closeReason: "blocked",
    })
    expect(store.challengeRuntimeState("crypto-score")).toMatchObject({
      blockScore: 11,
      sessionInterruptions: 0,
    })
    store.close()
  })

  it("打开现行旧数据库时只提高尚未 blocked 任务的基础阈值", async () => {
    const { path, store } = await storeFixture()
    store.createRun({
      id: "active-threshold-run",
      challengeId: "active-threshold",
      workspace: "workspace",
      attempt: 1,
    })
    store.recordChallengeBlockEvent({
      challengeId: "active-threshold",
      runId: "active-threshold-run",
      eventKey: "seed-runtime-state",
      delta: 0,
      reason: "migration_fixture",
    })
    store.close()

    const legacy = new DatabaseSync(path)
    legacy.exec(`
      UPDATE challenge_runtime_state
      SET base_block_threshold = 8
      WHERE challenge_id = 'active-threshold'
    `)
    legacy.close()

    const migrated = await RunStore.open(path)
    expect(migrated.challengeRuntimeState("active-threshold")).toMatchObject({
      baseBlockThreshold: 10,
      effectiveBlockThreshold: 10,
      blocked: false,
    })
    migrated.close()
  })

  it("打开旧 runtime state 时迁移 block score 且保留 blocked 事实", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctf-run-store-legacy-runtime-"))
    roots.push(root)
    const path = join(root, "runs.sqlite")
    const legacy = new DatabaseSync(path)
    legacy.exec(`
      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        challenge_id TEXT NOT NULL,
        workspace TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        status TEXT NOT NULL,
        close_reason TEXT,
        error TEXT,
        cleanup_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      ) STRICT;
      INSERT INTO runs (
        id, challenge_id, workspace, attempt, status, close_reason,
        created_at, updated_at
      ) VALUES (
        'legacy-blocked', 'legacy-challenge', 'workspace', 1, 'blocked', 'blocked',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:01:00.000Z'
      );
      CREATE TABLE challenge_runtime_state (
        challenge_id TEXT PRIMARY KEY,
        session_interruptions INTEGER NOT NULL DEFAULT 0,
        blocked INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO challenge_runtime_state (
        challenge_id, session_interruptions, blocked, updated_at
      ) VALUES (
        'legacy-challenge', 2, 1, '2026-01-01T00:01:00.000Z'
      );
    `)
    legacy.close()

    const migrated = await RunStore.open(path)
    expect(migrated.getRun("legacy-blocked")?.source).toBe("direct")
    expect(migrated.challengeRuntimeState("legacy-challenge")).toEqual({
      challengeId: "legacy-challenge",
      blockScore: 9,
      baseBlockThreshold: 8,
      revivalCount: 0,
      effectiveBlockThreshold: 8,
      blocked: true,
      blockedAt: "2026-01-01T00:01:00.000Z",
      blockedRunId: "legacy-blocked",
      lifecycleGeneration: 0,
      sessionInterruptions: 2,
      updatedAt: "2026-01-01T00:01:00.000Z",
    })
    migrated.close()

    const reopened = await RunStore.open(path)
    expect(reopened.challengeRuntimeState("legacy-challenge").blockScore).toBe(9)
    reopened.close()
  })

  it("打开旧数据库时自动补充 run source 字段", async () => {
    const { path, store } = await storeFixture()
    store.close()
    const legacy = new DatabaseSync(path)
    legacy.exec("ALTER TABLE runs DROP COLUMN source")
    legacy.exec(`
      INSERT INTO runs (
        id, challenge_id, workspace, attempt, status, created_at, updated_at
      ) VALUES (
        'legacy', 'misc-1', 'workspace', 1, 'closed',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      )
    `)
    legacy.close()

    const migrated = await RunStore.open(path)
    expect(migrated.getRun("legacy")).toMatchObject({
      id: "legacy",
      source: "direct",
    })
    migrated.close()
  })
})
