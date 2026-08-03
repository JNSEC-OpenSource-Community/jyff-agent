import type { RunEvent, RunRecord } from "@ctf-agent/solver"
import { describe, expect, it } from "vitest"
import { buildSessionMarkdown } from "../src/export.ts"
import { FakeDashboardProject } from "./fake-project.ts"

const base = "2026-08-02T12:00:00.000Z"

function event(id: number, runId: string, type: string, data: unknown): RunEvent {
  return { id, runId, type, data, createdAt: base }
}

function run(id: string, overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id,
    challengeId: "web-1",
    workspace: "/workspace/" + id,
    attempt: 1,
    source: "auto",
    status: "solved",
    closeReason: "submitted",
    createdAt: base,
    updatedAt: base,
    startedAt: "2026-08-02T11:00:00.000Z",
    finishedAt: "2026-08-02T11:00:40.000Z",
    ...overrides,
  }
}

function fixture(): FakeDashboardProject {
  const project = new FakeDashboardProject()
  project.runValues = [
    run("run-with-usage", { attempt: 1, status: "solved" }),
    run("run-no-usage", { attempt: 2, status: "failed", closeReason: "failed", error: "超时" }),
  ]
  project.eventValues = new Map<string, RunEvent[]>([
    [
      "run-with-usage",
      [
        event(1, "run-with-usage", "run_created", { attempt: 1 }),
        event(2, "run-with-usage", "agent_started", {}),
        // 思维链按流式词片持久化,导出端必须拼接
        event(3, "run-with-usage", "agent_thinking", { text: "先查看 ", ts: base }),
        event(4, "run-with-usage", "agent_thinking", { text: "robots.txt", ts: base }),
        event(5, "run-with-usage", "agent_message", { text: "我先检查 robots.txt", ts: base }),
        event(6, "run-with-usage", "tool_started", {
          toolName: "bash",
          args: { command: "curl -s http://x/robots.txt" },
        }),
        event(7, "run-with-usage", "tool_finished", {
          toolName: "bash",
          isError: false,
          result: "moectf{secret-flag-here}\nUser-agent: *",
        }),
        event(8, "run-with-usage", "agent_usage", {
          input: 1200,
          output: 340,
          cacheRead: 800,
          cacheWrite: 0,
          reasoning: 200,
          totalTokens: 1540,
          cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0, total: 0.031 },
        }),
        event(9, "run-with-usage", "agent_usage", {
          input: 500,
          output: 100,
          cacheRead: 50,
          cacheWrite: 10,
          reasoning: 60,
          totalTokens: 600,
          cost: { input: 0.001, output: 0.002, cacheRead: 0.0001, cacheWrite: 0.0002, total: 0.0033 },
        }),
        event(10, "run-with-usage", "flag_submitted", {
          flag: "moectf{secret-flag-here}",
          status: "accepted",
          message: "accepted",
        }),
        event(11, "run-with-usage", "human_message", { text: "不要用 wget", ts: base }),
      ],
    ],
    [
      "run-no-usage",
      [
        event(1, "run-no-usage", "run_created", { attempt: 2 }),
        event(2, "run-no-usage", "agent_message", { text: "没有可用数据", ts: base }),
      ],
    ],
  ])
  return project
}

describe("buildSessionMarkdown(会话复盘导出)", () => {
  it("输出头部与元信息表(含耗时)", () => {
    const markdown = buildSessionMarkdown(fixture(), "web-1")
    expect(markdown).toContain("# CTF Agent 会话复盘：web-1")
    expect(markdown).toContain("## Run run-with（attempt 1 · solved）")
    expect(markdown).toContain("| 题目 | web-1 |")
    expect(markdown).toContain("| 来源 | auto |")
    expect(markdown).toContain("| 耗时 | 0:40 |")
    expect(markdown).toContain("| 错误 | 超时 |")
  })

  it("思维链流式词片按事件序拼接为完整文本", () => {
    const markdown = buildSessionMarkdown(fixture(), "web-1", { runId: "run-with-usage" })
    expect(markdown).toContain("**思维链：**")
    expect(markdown).toContain("先查看 robots.txt")
    // 词片间无多余换行/分隔符
    expect(markdown).not.toContain("先查看 \nrobots.txt")
  })

  it("token 消耗逐轮明细与合计正确", () => {
    const markdown = buildSessionMarkdown(fixture(), "web-1", { runId: "run-with-usage" })
    expect(markdown).toContain("| 1 | 1200 | 340 | 800 | 0 | 200 | 1540 | $0.0310 |")
    expect(markdown).toContain("| 2 | 500 | 100 | 50 | 10 | 60 | 600 | $0.0033 |")
    expect(markdown).toContain("| **合计** | **1700** | **440** | **850** | **10** | **260** | **2140** | **$0.0343** |")
  })

  it("默认脱敏:flag 被替换、明文不在文档中", () => {
    const markdown = buildSessionMarkdown(fixture(), "web-1", { runId: "run-with-usage" })
    expect(markdown).not.toContain("moectf{secret-flag-here}")
    expect(markdown).toContain("[redacted]")
    // flag_submitted 行仍可见(内容已脱敏)
    expect(markdown).toContain("提交 Flag")
  })

  it("full=true 保留明文 flag", () => {
    const markdown = buildSessionMarkdown(fixture(), "web-1", { runId: "run-with-usage", full: true })
    expect(markdown).toContain("moectf{secret-flag-here}")
    expect(markdown).toContain("（accepted）")
  })

  it("多 run 分节导出", () => {
    const markdown = buildSessionMarkdown(fixture(), "web-1")
    expect(markdown.match(/^## /gm)).toHaveLength(2)
    expect(markdown).toContain("## Run run-no-u（attempt 2 · failed）")
  })

  it("runId 过滤只导出指定 run", () => {
    const markdown = buildSessionMarkdown(fixture(), "web-1", { runId: "run-no-usage" })
    expect(markdown.match(/^## /gm)).toHaveLength(1)
    expect(markdown).toContain("run-no-usa")
    expect(markdown).not.toContain("run-with-usage")
  })

  it("无 usage 数据的 run 明确标注", () => {
    const markdown = buildSessionMarkdown(fixture(), "web-1", { runId: "run-no-usage" })
    expect(markdown).toContain("（无记录")
  })

  it("工具调用与人工消息进入时间线", () => {
    const markdown = buildSessionMarkdown(fixture(), "web-1", { runId: "run-with-usage" })
    expect(markdown).toContain("🔧 **bash**")
    expect(markdown).toContain("人工消息**：不要用 wget")
    expect(markdown).toContain("**Agent 回复：**\n\n我先检查 robots.txt")
  })
})
