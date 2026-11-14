import { describe, expect, it, vi } from "vite-plus/test"
import { createBlackboardTools, serializeBlackboard } from "../../src/collaboration/blackboard.js"
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
    expect(text).toContain("## Recorded Evidence")
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
      updateEvidence: (_challengeId: string, evidenceId: number, description: string) => ({
        id: evidenceId,
        challengeId: "c1",
        description,
        runId: "r1",
        createdAt: "now",
      }),
      deleteEvidence: (_challengeId: string, evidenceId: number) => ({
        id: evidenceId,
        challengeId: "c1",
        description: "deleted",
        runId: "r1",
        createdAt: "now",
      }),
      updateOpportunity: (
        _challengeId: string,
        opportunityId: number,
        input: { description?: string; sourceEvidenceIds?: number[] },
      ) => ({
        id: opportunityId,
        challengeId: "c1",
        description: input.description ?? "opp",
        status: "open" as const,
        resolution: null,
        runId: "r1",
        sourceEvidenceIds: input.sourceEvidenceIds ?? [1],
        targetEvidenceId: null,
        createdAt: "now",
        concludedAt: null,
      }),
      deleteOpportunity: (_challengeId: string, opportunityId: number) => ({
        id: opportunityId,
        challengeId: "c1",
        description: "deleted",
        status: "open" as const,
        resolution: null,
        runId: "r1",
        sourceEvidenceIds: [1],
        targetEvidenceId: null,
        createdAt: "now",
        concludedAt: null,
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
    expect(text).toContain("## Recorded Evidence")
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
    expect(((result.details as Record<string, unknown>).evidence as { id: number }).id).toBe(1)
  })

  it("record 工具把同批次 evidence 引用解析为持久化 ID", async () => {
    const recordEvidence = vi.fn(() => ({
      id: 57,
      challengeId: "c1",
      description: "new finding",
      runId: "r1",
      createdAt: "now",
    }))
    const recordOpportunity = vi.fn(() => ({
      id: 8,
      challengeId: "c1",
      description: "follow up",
      status: "open" as const,
      resolution: null,
      runId: "r1",
      sourceEvidenceIds: [57],
      targetEvidenceId: null,
      createdAt: "now",
      concludedAt: null,
    }))
    const tools = createBlackboardTools({
      runStore: fakeRunStore({ recordEvidence, recordOpportunity } as Partial<RunStore>),
      challengeId: "c1",
      runId: "r1",
    })
    const recordTool = tools[1]
    if (!recordTool) throw new Error("blackboard_record 工具未创建")
    const input = {
      evidence: { description: "new finding" },
      opportunity: { description: "follow up", sourceEvidenceIds: [1] },
    }

    const result = await recordTool.execute("call", input)

    expect(recordOpportunity).toHaveBeenCalledWith("c1", "r1", "follow up", [57])
    expect((result.details as Record<string, unknown>).opportunity).toBeDefined()
    expect((result.details as Record<string, unknown>).opportunityError).toBeUndefined()
  })

  it("record 工具在没有同批次 evidence 时保留持久化 ID", async () => {
    const recordOpportunity = vi.fn(() => ({
      id: 8,
      challengeId: "c1",
      description: "follow up",
      status: "open" as const,
      resolution: null,
      runId: "r1",
      sourceEvidenceIds: [1],
      targetEvidenceId: null,
      createdAt: "now",
      concludedAt: null,
    }))
    const tools = createBlackboardTools({
      runStore: fakeRunStore({ recordOpportunity } as Partial<RunStore>),
      challengeId: "c1",
      runId: "r1",
    })
    const recordTool = tools[1]
    if (!recordTool) throw new Error("blackboard_record 工具未创建")

    const result = await recordTool.execute("call", {
      opportunity: { description: "follow up", sourceEvidenceIds: [1] },
    })

    expect(recordOpportunity).toHaveBeenCalledWith("c1", "r1", "follow up", [1])
    expect((result.details as Record<string, unknown>).opportunity).toBeDefined()
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
    expect(concludeOpportunity).toHaveBeenCalledWith("c1", 2, "结论", "r1", "dead_end")
  })

  it("manage 工具按 ID 更新与删除条目", async () => {
    const updateOpportunity = vi.fn((_challengeId: string, opportunityId: number) => ({
      id: opportunityId,
      challengeId: "c1",
      description: "updated",
      status: "open" as const,
      resolution: null,
      runId: "r1",
      sourceEvidenceIds: [2],
      targetEvidenceId: null,
      createdAt: "now",
      concludedAt: null,
    }))
    const deleteEvidence = vi.fn(() => {
      throw new Error("Evidence 1 is referenced")
    })
    const tools = createBlackboardTools({
      runStore: fakeRunStore({
        updateOpportunity,
        deleteEvidence,
      } as Partial<RunStore>),
      challengeId: "c1",
      runId: "r1",
    })
    const manage = tools.find((tool) => tool.name === "blackboard_manage")
    if (!manage) throw new Error("blackboard_manage 工具未创建")

    const updated = await manage.execute("update", {
      action: "update_opportunity",
      opportunityId: 3,
      description: "updated",
      sourceEvidenceIds: [2],
    })
    expect((updated.details as { record?: { id: number } }).record?.id).toBe(3)
    expect(updateOpportunity).toHaveBeenCalledWith("c1", 3, {
      description: "updated",
      sourceEvidenceIds: [2],
    })

    const rejected = await manage.execute("delete", {
      action: "delete_evidence",
      evidenceId: 1,
    })
    expect((rejected.details as { error?: string }).error).toContain("is referenced")
  })
})
