import { describe, expect, it, vi } from "vitest"
import {
  createBlackboardTools,
  serializeBlackboard,
} from "../../src/collaboration/blackboard.js"
import type { RunStore } from "../../src/persistence/run-store.js"

describe("serializeBlackboard", () => {
  it("空黑板不生成可注入内容", () => {
    expect(serializeBlackboard({ evidence: [], opportunities: [] })).toBe("")
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

  it("超边（多源）正确渲染为逗号分隔", () => {
    const text = serializeBlackboard({
      evidence: [
        { id: 1, description: "发现注入点", runId: "run-1" },
        { id: 2, description: "获得凭据", runId: "run-1" },
        { id: 5, description: "发现后台", runId: "run-1" },
      ],
      opportunities: [
        {
          id: 3,
          description: "三源探索",
          status: "open",
          resolution: null,
          sourceEvidenceIds: [1, 2, 5],
          targetEvidenceId: null,
        },
      ],
    })
    expect(text).toContain('- [o3] from e1, e2, e5: "三源探索"')
  })

  it("按字符预算截断超长快照", () => {
    const text = serializeBlackboard(
      {
        evidence: [{ id: 1, description: "A".repeat(1_000), runId: "run-1" }],
        opportunities: [],
      },
      { maxCharacters: 256 },
    )
    expect(text.length).toBeLessThanOrEqual(256)
    expect(text).toContain("snapshot truncated")

    const tiny = serializeBlackboard(
      {
        evidence: [{ id: 1, description: "B".repeat(100), runId: "run-1" }],
        opportunities: [],
      },
      { maxCharacters: 10 },
    )
    expect(tiny).toHaveLength(10)
  })
})

describe("createBlackboardTools", () => {
  function fakeRunStore(overrides: Partial<RunStore> = {}): RunStore {
    return {
      recordEvidence: () => ({
        id: 1,
        challengeId: "c1",
        description: "ok",
        runId: "r1",
        createdAt: "now",
      }),
      recordOpportunity: () => ({
        id: 1,
        challengeId: "c1",
        description: "opp",
        status: "open",
        resolution: null,
        runId: "r1",
        sourceEvidenceIds: [1],
        targetEvidenceId: null,
        createdAt: "now",
        concludedAt: null,
      }),
      concludeOpportunity: () => ({
        evidence: {
          id: 2,
          challengeId: "c1",
          description: "result",
          runId: "r1",
          createdAt: "now",
        },
        opportunity: {
          id: 1,
          challengeId: "c1",
          description: "opp",
          status: "concluded",
          resolution: "confirmed",
          runId: "r1",
          sourceEvidenceIds: [1],
          targetEvidenceId: 2,
          createdAt: "now",
          concludedAt: "now",
        },
      }),
      getBlackboardSummary: () => ({
        evidence: [{ id: 1, description: "test", runId: "r1" }],
        opportunities: [],
      }),
      ...overrides,
    } as unknown as RunStore
  }

  it("read 工具返回序列化文本", async () => {
    const tools = createBlackboardTools({
      runStore: fakeRunStore(),
      challengeId: "c1",
      runId: "r1",
    })
    const readTool = tools[0]
    if (!readTool) throw new Error("blackboard_read 工具未创建")
    const result = await readTool.execute("call", {})
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
    const recordTool = tools[1]
    if (!recordTool) throw new Error("blackboard_record 工具未创建")
    const result = await recordTool.execute("call", {
      evidence: { description: "new finding" },
    })
    expect((result.details as Record<string, unknown>).evidence).toBeDefined()
    expect(
      ((result.details as Record<string, unknown>).evidence as { id: number })
        .id,
    ).toBe(1)
  })

  it("record 工具全空参数抛出错误", async () => {
    const tools = createBlackboardTools({
      runStore: fakeRunStore(),
      challengeId: "c1",
      runId: "r1",
    })
    await expect(tools[1]?.execute("call", {})).rejects.toThrow("At least one")
  })

  it("record 工具三个操作组合调用", async () => {
    const concludeOpportunity = vi.fn(() => ({
      evidence: {
        id: 2,
        challengeId: "c1",
        description: "result",
        runId: "r1",
        createdAt: "now",
      },
      opportunity: {
        id: 1,
        challengeId: "c1",
        description: "opp",
        status: "concluded" as const,
        resolution: "dead_end" as const,
        runId: "r1",
        sourceEvidenceIds: [1],
        targetEvidenceId: 2,
        createdAt: "now",
        concludedAt: "now",
      },
    }))
    const tools = createBlackboardTools({
      runStore: fakeRunStore({ concludeOpportunity } as Partial<RunStore>),
      challengeId: "c1",
      runId: "r1",
    })
    const recordTool = tools[1]
    if (!recordTool) throw new Error("blackboard_record 工具未创建")
    const result = await recordTool.execute("call", {
      evidence: { description: "证据" },
      opportunity: { description: "机会", sourceEvidenceIds: [1] },
      concludeOpportunity: {
        opportunityId: 2,
        resolution: "dead_end",
        resultDescription: "结论",
      },
    })
    const details = result.details as Record<string, unknown>
    expect(details.evidence).toBeDefined()
    expect(details.opportunity).toBeDefined()
    expect(details.concluded).toBeDefined()
    expect(concludeOpportunity).toHaveBeenCalledWith(
      "c1",
      2,
      "结论",
      "r1",
      "dead_end",
    )
  })
})
