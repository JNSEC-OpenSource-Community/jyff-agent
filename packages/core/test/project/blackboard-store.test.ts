import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it } from "vite-plus/test"
import {
  BLACKBOARD_DESCRIPTION_MAX_LENGTH,
  BLACKBOARD_MAX_EVIDENCE_PER_CHALLENGE,
  BLACKBOARD_SOURCE_MAX_ITEMS,
  RunStore,
} from "../../src/persistence/run-store.js"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function storeFixture(
  options: { persistent?: boolean } = {},
): Promise<{ store: RunStore; path: string }> {
  if (!options.persistent) {
    return { store: await RunStore.open(":memory:"), path: ":memory:" }
  }
  const root = await mkdtemp(join(tmpdir(), "ctf-blackboard-"))
  roots.push(root)
  const path = join(root, "runs.sqlite")
  return { store: await RunStore.open(path), path }
}

describe("RunStore blackboard", () => {
  it("新题目的黑板默认为空", async () => {
    const { store } = await storeFixture()
    store.createRun({
      id: "run-1",
      challengeId: "chal-1",
      workspace: "/tmp/a",
      attempt: 1,
    })

    expect(store.getBlackboardSummary("chal-1")).toEqual({
      evidence: [],
      opportunities: [],
    })
    expect(store.getBlackboardStats()).toEqual([])
    store.close()
  })

  it("记录 Evidence 并可通过 getBlackboardSummary 查询", async () => {
    const { store } = await storeFixture()
    store.createRun({
      id: "run-1",
      challengeId: "chal-1",
      workspace: "/tmp/a",
      attempt: 1,
    })

    const e1 = store.recordEvidence("chal-1", "run-1", "发现 format string 漏洞")
    expect(e1).toMatchObject({
      challengeId: "chal-1",
      runId: "run-1",
      description: "发现 format string 漏洞",
    })

    const e2 = store.recordEvidence("chal-1", "run-1", "GOT 表可写")
    expect(e2.id).toBeGreaterThan(e1.id)

    const summary = store.getBlackboardSummary("chal-1")
    expect(summary.evidence).toHaveLength(2)
    expect(summary.evidence[0]?.description).toBe("发现 format string 漏洞")
    expect(summary.evidence[1]?.description).toBe("GOT 表可写")
    store.close()
  })

  it("recordOpportunity 在事务中写入 opportunity + sources", async () => {
    const { store } = await storeFixture()
    store.createRun({
      id: "run-1",
      challengeId: "chal-1",
      workspace: "/tmp/a",
      attempt: 1,
    })
    const origin = store.recordEvidence("chal-1", "run-1", "已确认格式化字符串漏洞")
    const e2 = store.recordEvidence("chal-1", "run-1", "format string 可泄露栈地址")
    const opp = store.recordOpportunity("chal-1", "run-1", "利用 format string 读栈泄露 ASLR", [
      origin.id,
      e2.id,
    ])
    expect(opp.status).toBe("open")
    expect(opp.sourceEvidenceIds).toEqual([origin.id, e2.id])
    expect(opp.targetEvidenceId).toBeNull()

    const summary = store.getBlackboardSummary("chal-1")
    expect(summary.opportunities).toHaveLength(1)
    expect(summary.opportunities[0]?.sourceEvidenceIds).toEqual([origin.id, e2.id])

    store.close()
  })

  it("更新和删除条目时保持引用关系与 challenge 隔离", async () => {
    const { store } = await storeFixture()
    store.createRun({
      id: "run-1",
      challengeId: "chal-1",
      workspace: "/tmp/a",
      attempt: 1,
    })
    store.createRun({
      id: "run-2",
      challengeId: "chal-2",
      workspace: "/tmp/b",
      attempt: 1,
    })
    const first = store.recordEvidence("chal-1", "run-1", "old evidence")
    const second = store.recordEvidence("chal-1", "run-1", "replacement")
    const opportunity = store.recordOpportunity("chal-1", "run-1", "old opportunity", [first.id])

    expect(store.updateEvidence("chal-1", first.id, " corrected ")).toMatchObject({
      id: first.id,
      description: "corrected",
    })
    expect(() => store.updateEvidence("chal-2", first.id, "cross challenge")).toThrow(
      "not found for challenge chal-2",
    )
    expect(() => store.deleteEvidence("chal-1", first.id)).toThrow(
      `referenced by Opportunity ${opportunity.id}`,
    )

    expect(
      store.updateOpportunity("chal-1", opportunity.id, {
        description: "corrected opportunity",
        sourceEvidenceIds: [second.id],
      }),
    ).toMatchObject({
      description: "corrected opportunity",
      sourceEvidenceIds: [second.id],
    })
    expect(store.deleteEvidence("chal-1", first.id).id).toBe(first.id)
    expect(store.deleteOpportunity("chal-1", opportunity.id)).toMatchObject({
      id: opportunity.id,
      sourceEvidenceIds: [second.id],
    })
    expect(store.deleteEvidence("chal-1", second.id).id).toBe(second.id)
    expect(store.getBlackboardSummary("chal-1")).toEqual({
      evidence: [],
      opportunities: [],
    })
    store.close()
  })

  it("recordOpportunity 拒绝空的 sourceEvidenceIds", async () => {
    const { store } = await storeFixture()
    store.createRun({
      id: "run-1",
      challengeId: "chal-1",
      workspace: "/tmp/a",
      attempt: 1,
    })
    expect(() => store.recordOpportunity("chal-1", "run-1", "test", [])).toThrow(
      "sourceEvidenceIds must not be empty",
    )
    store.close()
  })

  it("限制描述长度和 opportunity source 数量", async () => {
    const { store } = await storeFixture()
    store.createRun({
      id: "run-1",
      challengeId: "chal-1",
      workspace: "/tmp/a",
      attempt: 1,
    })
    const evidence = store.recordEvidence("chal-1", "run-1", "source")

    expect(() =>
      store.recordEvidence("chal-1", "run-1", "A".repeat(BLACKBOARD_DESCRIPTION_MAX_LENGTH + 1)),
    ).toThrow("must not exceed")
    expect(() =>
      store.recordOpportunity(
        "chal-1",
        "run-1",
        "too many sources",
        Array.from({ length: BLACKBOARD_SOURCE_MAX_ITEMS + 1 }, () => evidence.id),
      ),
    ).toThrow("must not contain more than")
    store.close()
  })

  it("限制单题黑板条目总量", async () => {
    const { store } = await storeFixture()
    store.createRun({
      id: "run-1",
      challengeId: "chal-1",
      workspace: "/tmp/a",
      attempt: 1,
    })
    for (let index = 0; index < BLACKBOARD_MAX_EVIDENCE_PER_CHALLENGE; index++) {
      store.recordEvidence("chal-1", "run-1", `evidence-${index}`)
    }
    expect(() => store.recordEvidence("chal-1", "run-1", "overflow")).toThrow(
      `per-challenge limit of ${BLACKBOARD_MAX_EVIDENCE_PER_CHALLENGE}`,
    )
    store.close()
  })

  it("concludeOpportunity 同时创建 evidence 并更新 opportunity", async () => {
    const { store } = await storeFixture()
    store.createRun({
      id: "run-1",
      challengeId: "chal-1",
      workspace: "/tmp/a",
      attempt: 1,
    })
    const origin = store.recordEvidence("chal-1", "run-1", "已确认可控返回地址")
    const opp = store.recordOpportunity("chal-1", "run-1", "测试探索", [origin.id])

    const result = store.concludeOpportunity("chal-1", opp.id, "探索成功，获得 shell", "run-1")
    expect(result.evidence.description).toBe("探索成功，获得 shell")
    expect(result.opportunity.status).toBe("concluded")
    expect(result.opportunity.resolution).toBe("confirmed")
    expect(result.opportunity.targetEvidenceId).toBe(result.evidence.id)

    const summary = store.getBlackboardSummary("chal-1")
    expect(summary.evidence).toHaveLength(2) // 初始证据 + 新 evidence
    expect(summary.opportunities[0]).toMatchObject({
      status: "concluded",
      resolution: "confirmed",
    })

    const deadEnd = store.recordOpportunity("chal-1", "run-1", "测试另一条实验方向", [origin.id])
    const deadEndResult = store.concludeOpportunity(
      "chal-1",
      deadEnd.id,
      "实验表明该方向不可行",
      "run-1",
      "dead_end",
    )
    expect(deadEndResult.opportunity).toMatchObject({
      status: "concluded",
      resolution: "dead_end",
      targetEvidenceId: deadEndResult.evidence.id,
    })

    store.close()
  })

  it("concludeOpportunity 拒绝已 concluded 的 opportunity", async () => {
    const { store } = await storeFixture()
    store.createRun({
      id: "run-1",
      challengeId: "chal-1",
      workspace: "/tmp/a",
      attempt: 1,
    })
    const origin = store.recordEvidence("chal-1", "run-1", "已确认可控返回地址")
    const opp = store.recordOpportunity("chal-1", "run-1", "test", [origin.id])
    store.concludeOpportunity("chal-1", opp.id, "done", "run-1")

    expect(() => store.concludeOpportunity("chal-1", opp.id, "double", "run-1")).toThrow(
      "already concluded",
    )
    store.close()
  })

  it("concludeOpportunity 拒绝跨 challenge 的 opportunity 和 run", async () => {
    const { store } = await storeFixture()
    store.createRun({
      id: "run-1",
      challengeId: "chal-1",
      workspace: "/tmp/a",
      attempt: 1,
    })
    store.createRun({
      id: "run-2",
      challengeId: "chal-2",
      workspace: "/tmp/b",
      attempt: 1,
    })
    const evidence = store.recordEvidence("chal-1", "run-1", "chal-1 evidence")
    const opportunity = store.recordOpportunity("chal-1", "run-1", "chal-1 opportunity", [
      evidence.id,
    ])

    expect(() =>
      store.concludeOpportunity("chal-2", opportunity.id, "cross challenge", "run-2"),
    ).toThrow("not found for challenge chal-2")
    expect(() => store.concludeOpportunity("chal-1", opportunity.id, "wrong run", "run-2")).toThrow(
      "does not belong to challenge chal-1",
    )

    const summary = store.getBlackboardSummary("chal-1")
    expect(summary.evidence).toHaveLength(1)
    expect(summary.opportunities[0]?.status).toBe("open")
    store.close()
  })

  it("旧库 concluded Opportunity 迁移为 confirmed resolution", async () => {
    const { store, path } = await storeFixture({ persistent: true })
    store.createRun({
      id: "legacy-run",
      challengeId: "legacy-challenge",
      workspace: "/tmp/legacy",
      attempt: 1,
    })
    const evidence = store.recordEvidence("legacy-challenge", "legacy-run", "source")
    const opportunity = store.recordOpportunity(
      "legacy-challenge",
      "legacy-run",
      "legacy direction",
      [evidence.id],
    )
    store.concludeOpportunity("legacy-challenge", opportunity.id, "legacy result", "legacy-run")
    store.close()

    const legacy = new DatabaseSync(path)
    legacy.exec("ALTER TABLE challenge_opportunities DROP COLUMN resolution")
    legacy.close()

    const migrated = await RunStore.open(path)
    expect(migrated.getBlackboardSummary("legacy-challenge").opportunities[0]).toMatchObject({
      status: "concluded",
      resolution: "confirmed",
    })
    migrated.close()
  })

  it("写入方法拒绝 challenge 与 run 不一致", async () => {
    const { store } = await storeFixture()
    store.createRun({
      id: "run-1",
      challengeId: "chal-1",
      workspace: "/tmp/a",
      attempt: 1,
    })

    expect(() => store.recordEvidence("chal-2", "run-1", "invalid")).toThrow(
      "does not belong to challenge chal-2",
    )
    const evidence = store.recordEvidence("chal-1", "run-1", "valid")
    expect(() => store.recordOpportunity("chal-2", "run-1", "invalid", [evidence.id])).toThrow(
      "does not belong to challenge chal-2",
    )
    store.close()
  })

  it("外键约束阻止引用不存在的 evidence", async () => {
    const { store } = await storeFixture()
    store.createRun({
      id: "run-1",
      challengeId: "chal-1",
      workspace: "/tmp/a",
      attempt: 1,
    })
    expect(() => store.recordOpportunity("chal-1", "run-1", "test", [99999])).toThrow()
    store.close()
  })

  it("跨 challenge 隔离", async () => {
    const { store } = await storeFixture()
    store.createRun({
      id: "run-1",
      challengeId: "chal-1",
      workspace: "/tmp/a",
      attempt: 1,
    })
    store.createRun({
      id: "run-2",
      challengeId: "chal-2",
      workspace: "/tmp/b",
      attempt: 1,
    })

    store.recordEvidence("chal-1", "run-1", "chal-1 的证据")
    store.recordEvidence("chal-2", "run-2", "chal-2 的证据")

    expect(store.getBlackboardSummary("chal-1").evidence).toHaveLength(1)
    expect(store.getBlackboardSummary("chal-2").evidence).toHaveLength(1)
    store.close()
  })
})
