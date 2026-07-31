import { describe, expect, it, vi } from "vitest"
import { createBlackboardTools, serializeBlackboard } from "../../src/blackboard/index.js"
import type { RunStore } from "../../src/project/run-store.js"

describe("serializeBlackboard", () => {
  it("正确的黑板输出包含所有段", () => {
    const text = serializeBlackboard({
      evidence: [
        { id: 1, description: "发现 format string 漏洞", runId: "run-1" },
        { id: 3, description: "GOT 表可写", runId: "run-1" },
      ],
      opportunities: [
        { id: 1, description: "尝试通过 %n 写 GOT", status: "open", sourceEvidenceIds: [1, 3], targetEvidenceId: null },
        { id: 2, description: "尝试 format string 读栈", status: "concluded", sourceEvidenceIds: [1], targetEvidenceId: 4 },
      ],
    })
    expect(text).toContain("## Confirmed Evidence")
    expect(text).toContain('- [e1] "发现 format string 漏洞"')
    expect(text).toContain('- [e3] "GOT 表可写"')
    expect(text).toContain("## Open Opportunities")
    expect(text).toContain('- [o1] from e1, e3: "尝试通过 %n 写 GOT"')
    expect(text).toContain("## Concluded Opportunities")
    expect(text).toContain('- [o2] from e1 → e4: "尝试 format string 读栈"')
    expect(text).toContain("Use ctf_blackboard_record")
  })

  it("仅有 evidence 时省略 opportunity 段", () => {
    const text = serializeBlackboard({
      evidence: [{ id: 1, description: "发现漏洞", runId: "run-1" }],
      opportunities: [],
    })
    expect(text).toContain("## Confirmed Evidence")
    expect(text).not.toContain("## Open Opportunities")
    expect(text).not.toContain("## Concluded Opportunities")
  })

  it("全部为空时仅返回使用提示", () => {
    const text = serializeBlackboard({ evidence: [], opportunities: [] })
    // 无 evidence 段，无 opportunity 段，但有尾部提示
    expect(text).not.toContain("## Confirmed Evidence")
    expect(text.trim()).toBe("Use ctf_blackboard_record to add new evidence or opportunities as you discover them.")
  })

  it("超边（多源）正确渲染为逗号分隔", () => {
    const text = serializeBlackboard({
      evidence: [
        { id: 1, description: "发现注入点", runId: "run-1" },
        { id: 2, description: "获得凭据", runId: "run-1" },
        { id: 5, description: "发现后台", runId: "run-1" },
      ],
      opportunities: [
        { id: 3, description: "三源探索", status: "open", sourceEvidenceIds: [1, 2, 5], targetEvidenceId: null },
      ],
    })
    expect(text).toContain('- [o3] from e1, e2, e5: "三源探索"')
  })

  it("按字符预算截断超长快照", () => {
    const text = serializeBlackboard({
      evidence: [{ id: 1, description: "A".repeat(1_000), runId: "run-1" }],
      opportunities: [],
    }, { maxCharacters: 256 })
    expect(text.length).toBeLessThanOrEqual(256)
    expect(text).toContain("snapshot truncated")

    const tiny = serializeBlackboard({
      evidence: [{ id: 1, description: "B".repeat(100), runId: "run-1" }],
      opportunities: [],
    }, { maxCharacters: 10 })
    expect(tiny).toHaveLength(10)
  })
})

describe("createBlackboardTools", () => {
  function fakeRunStore(overrides: Partial<RunStore> = {}): RunStore {
    return {
      recordEvidence: () => ({ id: 1, challengeId: "c1", description: "ok", runId: "r1", createdAt: "now" }),
      ensureOrigin: () => ({ id: 1, challengeId: "c1", description: "origin", runId: "r1", createdAt: "now" }),
      recordOpportunity: () => ({
        id: 1, challengeId: "c1", description: "opp", status: "open", runId: "r1",
        sourceEvidenceIds: [1], targetEvidenceId: null, createdAt: "now", concludedAt: null,
      }),
      concludeOpportunity: () => ({
        evidence: { id: 2, challengeId: "c1", description: "result", runId: "r1", createdAt: "now" },
        opportunity: {
          id: 1, challengeId: "c1", description: "opp", status: "concluded", runId: "r1",
          sourceEvidenceIds: [1], targetEvidenceId: 2, createdAt: "now", concludedAt: "now",
        },
      }),
      getBlackboardSummary: () => ({
        evidence: [{ id: 1, description: "test", runId: "r1" }],
        opportunities: [],
      }),
      ...overrides,
    } as unknown as RunStore
  }

  it("创建 read 和 record 两个工具", () => {
    const tools = createBlackboardTools({
      runStore: fakeRunStore(),
      challengeId: "c1",
      runId: "r1",
    })
    expect(tools).toHaveLength(2)
    expect(tools[0]!.name).toBe("ctf_blackboard_read")
    expect(tools[1]!.name).toBe("ctf_blackboard_record")
  })

  it("read 工具返回序列化文本", async () => {
    const tools = createBlackboardTools({
      runStore: fakeRunStore(),
      challengeId: "c1",
      runId: "r1",
    })
    const result = await tools[0]!.execute("call", {})
    const text = (result.content[0] as { type: string; text: string }).text
    expect(text).toContain("## Confirmed Evidence")
    expect(text).toContain('- [e1] "test"')
  })

  it("record 工具记录 evidence 成功", async () => {
    const tools = createBlackboardTools({
      runStore: fakeRunStore(),
      challengeId: "c1",
      runId: "r1",
    })
    const result = await tools[1]!.execute("call", {
      evidence: { description: "new finding" },
    })
    expect((result.details as Record<string, unknown>).evidence).toBeDefined()
    expect(((result.details as Record<string, unknown>).evidence as { id: number }).id).toBe(1)
  })

  it("record 工具全空参数抛出错误", async () => {
    const tools = createBlackboardTools({
      runStore: fakeRunStore(),
      challengeId: "c1",
      runId: "r1",
    })
    await expect(tools[1]!.execute("call", {})).rejects.toThrow("At least one")
  })

  it("record 工具三个操作组合调用", async () => {
    const concludeOpportunity = vi.fn(() => ({
      evidence: { id: 2, challengeId: "c1", description: "result", runId: "r1", createdAt: "now" },
      opportunity: {
        id: 1, challengeId: "c1", description: "opp", status: "concluded" as const, runId: "r1",
        sourceEvidenceIds: [1], targetEvidenceId: 2, createdAt: "now", concludedAt: "now",
      },
    }))
    const tools = createBlackboardTools({
      runStore: fakeRunStore({ concludeOpportunity } as Partial<RunStore>),
      challengeId: "c1",
      runId: "r1",
    })
    const result = await tools[1]!.execute("call", {
      evidence: { description: "证据" },
      opportunity: { description: "机会", sourceEvidenceIds: [1] },
      concludeOpportunity: { opportunityId: 2, resultDescription: "结论" },
    })
    const details = result.details as Record<string, unknown>
    expect(details.evidence).toBeDefined()
    expect(details.opportunity).toBeDefined()
    expect(details.concluded).toBeDefined()
    expect(concludeOpportunity).toHaveBeenCalledWith("c1", 2, "结论", "r1")
  })
})
