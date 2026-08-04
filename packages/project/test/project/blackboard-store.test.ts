import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  BLACKBOARD_DESCRIPTION_MAX_LENGTH,
  BLACKBOARD_MAX_EVIDENCE_PER_CHALLENGE,
  BLACKBOARD_SOURCE_MAX_ITEMS,
  RunStore,
} from "../../src/run-store.js"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function storeFixture(): Promise<{ store: RunStore; path: string }> {
  const root = await mkdtemp(join(tmpdir(), "ctf-blackboard-"))
  roots.push(root)
  const path = join(root, "runs.sqlite")
  return { store: await RunStore.open(path), path }
}

function fakeChallenge() {
  return {
    title: "Test Challenge",
    category: "pwn",
    score: 100,
    description: "A binary exploitation challenge",
    attachments: [
      { name: "binary.exe", size: 4096 },
      { name: "libc.so", size: 204800 },
    ],
  }
}

describe("RunStore blackboard", () => {
  it("记录 Evidence 并可通过 getBlackboardSummary 查询", async () => {
    const { store } = await storeFixture()
    store.createRun({ id: "run-1", challengeId: "chal-1", workspace: "/tmp/a", attempt: 1 })

    const e1 = store.recordEvidence("chal-1", "run-1", "发现 format string 漏洞")
    expect(e1).toMatchObject({ challengeId: "chal-1", runId: "run-1", description: "发现 format string 漏洞" })

    const e2 = store.recordEvidence("chal-1", "run-1", "GOT 表可写")
    expect(e2.id).toBeGreaterThan(e1.id)

    const summary = store.getBlackboardSummary("chal-1")
    expect(summary.evidence).toHaveLength(2)
    expect(summary.evidence[0]!.description).toBe("发现 format string 漏洞")
    expect(summary.evidence[1]!.description).toBe("GOT 表可写")
    store.close()
  })

  it("ensureOrigin 首次创建 origin，再次调用幂等返回", async () => {
    const { store } = await storeFixture()
    store.createRun({ id: "run-1", challengeId: "chal-1", workspace: "/tmp/a", attempt: 1 })

    const challenge = fakeChallenge()
    const origin1 = store.ensureOrigin("chal-1", "run-1", challenge)
    expect(origin1.description).toContain("Test Challenge")
    expect(origin1.description).toContain("pwn")
    expect(origin1.description).toContain("binary.exe")
    expect(origin1.description).toContain("libc.so")

    // 幂等调用
    store.createRun({ id: "run-2", challengeId: "chal-1", workspace: "/tmp/b", attempt: 2 })
    const origin2 = store.ensureOrigin("chal-1", "run-2", {
      ...challenge,
      title: "Different Title",
    })
    expect(origin2.id).toBe(origin1.id)
    // 描述不变（使用第一次的内容）
    expect(origin2.description).toBe(origin1.description)

    const summary = store.getBlackboardSummary("chal-1")
    expect(summary.evidence).toHaveLength(1)

    store.close()
  })

  it("不同 challenge 的 origin 互不干扰", async () => {
    const { store } = await storeFixture()
    store.createRun({ id: "run-1", challengeId: "chal-1", workspace: "/tmp/a", attempt: 1 })
    store.createRun({ id: "run-2", challengeId: "chal-2", workspace: "/tmp/b", attempt: 1 })

    store.ensureOrigin("chal-1", "run-1", fakeChallenge())
    store.ensureOrigin("chal-2", "run-2", { ...fakeChallenge(), title: "Other" })

    expect(store.getBlackboardSummary("chal-1").evidence).toHaveLength(1)
    expect(store.getBlackboardSummary("chal-2").evidence).toHaveLength(1)
    expect(store.getBlackboardSummary("chal-3").evidence).toHaveLength(0)

    store.close()
  })

  it("recordOpportunity 在事务中写入 opportunity + sources", async () => {
    const { store } = await storeFixture()
    store.createRun({ id: "run-1", challengeId: "chal-1", workspace: "/tmp/a", attempt: 1 })
    store.ensureOrigin("chal-1", "run-1", fakeChallenge())

    const e2 = store.recordEvidence("chal-1", "run-1", "format string 可泄露栈地址")
    const origin = store.getBlackboardSummary("chal-1").evidence[0]!

    const opp = store.recordOpportunity("chal-1", "run-1", "利用 format string 读栈泄露 ASLR", [
      origin.id,
      e2.id,
    ])
    expect(opp.status).toBe("open")
    expect(opp.sourceEvidenceIds).toEqual([origin.id, e2.id])
    expect(opp.targetEvidenceId).toBeNull()

    const summary = store.getBlackboardSummary("chal-1")
    expect(summary.opportunities).toHaveLength(1)
    expect(summary.opportunities[0]!.sourceEvidenceIds).toEqual([origin.id, e2.id])

    store.close()
  })

  it("recordOpportunity 拒绝空的 sourceEvidenceIds", async () => {
    const { store } = await storeFixture()
    store.createRun({ id: "run-1", challengeId: "chal-1", workspace: "/tmp/a", attempt: 1 })
    expect(() => store.recordOpportunity("chal-1", "run-1", "test", [])).toThrow(
      "sourceEvidenceIds must not be empty",
    )
    store.close()
  })

  it("限制描述长度和 opportunity source 数量", async () => {
    const { store } = await storeFixture()
    store.createRun({ id: "run-1", challengeId: "chal-1", workspace: "/tmp/a", attempt: 1 })
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
    store.createRun({ id: "run-1", challengeId: "chal-1", workspace: "/tmp/a", attempt: 1 })
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
    store.createRun({ id: "run-1", challengeId: "chal-1", workspace: "/tmp/a", attempt: 1 })
    store.ensureOrigin("chal-1", "run-1", fakeChallenge())

    const origin = store.getBlackboardSummary("chal-1").evidence[0]!
    const opp = store.recordOpportunity("chal-1", "run-1", "测试探索", [origin.id])

    const result = store.concludeOpportunity("chal-1", opp.id, "探索成功，获得 shell", "run-1")
    expect(result.evidence.description).toBe("探索成功，获得 shell")
    expect(result.opportunity.status).toBe("concluded")
    expect(result.opportunity.targetEvidenceId).toBe(result.evidence.id)

    const summary = store.getBlackboardSummary("chal-1")
    expect(summary.evidence).toHaveLength(2) // origin + 新 evidence
    expect(summary.opportunities[0]!.status).toBe("concluded")

    store.close()
  })

  it("concludeOpportunity 拒绝已 concluded 的 opportunity", async () => {
    const { store } = await storeFixture()
    store.createRun({ id: "run-1", challengeId: "chal-1", workspace: "/tmp/a", attempt: 1 })
    store.ensureOrigin("chal-1", "run-1", fakeChallenge())

    const origin = store.getBlackboardSummary("chal-1").evidence[0]!
    const opp = store.recordOpportunity("chal-1", "run-1", "test", [origin.id])
    store.concludeOpportunity("chal-1", opp.id, "done", "run-1")

    expect(() => store.concludeOpportunity("chal-1", opp.id, "double", "run-1")).toThrow("already concluded")
    store.close()
  })

  it("concludeOpportunity 拒绝跨 challenge 的 opportunity 和 run", async () => {
    const { store } = await storeFixture()
    store.createRun({ id: "run-1", challengeId: "chal-1", workspace: "/tmp/a", attempt: 1 })
    store.createRun({ id: "run-2", challengeId: "chal-2", workspace: "/tmp/b", attempt: 1 })
    const evidence = store.recordEvidence("chal-1", "run-1", "chal-1 evidence")
    const opportunity = store.recordOpportunity("chal-1", "run-1", "chal-1 opportunity", [evidence.id])

    expect(() =>
      store.concludeOpportunity("chal-2", opportunity.id, "cross challenge", "run-2"),
    ).toThrow("not found for challenge chal-2")
    expect(() =>
      store.concludeOpportunity("chal-1", opportunity.id, "wrong run", "run-2"),
    ).toThrow("does not belong to challenge chal-1")

    const summary = store.getBlackboardSummary("chal-1")
    expect(summary.evidence).toHaveLength(1)
    expect(summary.opportunities[0]!.status).toBe("open")
    store.close()
  })

  it("写入方法拒绝 challenge 与 run 不一致", async () => {
    const { store } = await storeFixture()
    store.createRun({ id: "run-1", challengeId: "chal-1", workspace: "/tmp/a", attempt: 1 })

    expect(() => store.recordEvidence("chal-2", "run-1", "invalid")).toThrow(
      "does not belong to challenge chal-2",
    )
    expect(() => store.ensureOrigin("chal-2", "run-1", fakeChallenge())).toThrow(
      "does not belong to challenge chal-2",
    )
    const evidence = store.recordEvidence("chal-1", "run-1", "valid")
    expect(() =>
      store.recordOpportunity("chal-2", "run-1", "invalid", [evidence.id]),
    ).toThrow("does not belong to challenge chal-2")
    store.close()
  })

  it("外键约束阻止引用不存在的 evidence", async () => {
    const { store } = await storeFixture()
    store.createRun({ id: "run-1", challengeId: "chal-1", workspace: "/tmp/a", attempt: 1 })
    expect(() =>
      store.recordOpportunity("chal-1", "run-1", "test", [99999]),
    ).toThrow()
    store.close()
  })

  it("跨 challenge 隔离", async () => {
    const { store } = await storeFixture()
    store.createRun({ id: "run-1", challengeId: "chal-1", workspace: "/tmp/a", attempt: 1 })
    store.createRun({ id: "run-2", challengeId: "chal-2", workspace: "/tmp/b", attempt: 1 })

    store.ensureOrigin("chal-1", "run-1", fakeChallenge())
    store.recordEvidence("chal-1", "run-1", "chal-1 的证据")
    store.recordEvidence("chal-2", "run-2", "chal-2 的证据")

    expect(store.getBlackboardSummary("chal-1").evidence).toHaveLength(2)
    expect(store.getBlackboardSummary("chal-2").evidence).toHaveLength(1)
    store.close()
  })
})
