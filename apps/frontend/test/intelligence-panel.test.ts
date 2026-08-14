// @vitest-environment jsdom

import { render, screen } from "@testing-library/react"
import { createElement } from "react"
import { describe, expect, it, vi } from "vite-plus/test"
import { IntelligencePanel } from "../src/pages/challenge/IntelligencePanel.tsx"

describe("情报面板", () => {
  it("使用与已确认事实一致的卡片呈现 TLDR", () => {
    render(
      createElement(IntelligencePanel, {
        projectId: "demo",
        challengeId: "pwn-1",
        tldr: {
          challengeId: "pwn-1",
          content: "已定位栈溢出入口。",
          model: "summary-model",
          sessionPath: "/workspace/tldr/session.jsonl",
          updatedAt: "2026-08-09T00:00:00.000Z",
          error: null,
          inputTokens: 128,
          cacheReadTokens: 64,
          cacheWriteTokens: 0,
        },
        blackboard: {
          evidence: [{ id: 1, description: "NX 已开启", runId: "run-1" }],
          opportunities: [],
        },
        onChanged: vi.fn(async () => {}),
      }),
    )

    expect(screen.getByRole("heading", { name: "TLDR 摘要" })).toBeTruthy()
    expect(screen.getByRole("heading", { name: "已确认事实" })).toBeTruthy()
    expect(screen.getByText("已定位栈溢出入口。")).toBeTruthy()
    expect(screen.getByText("summary-model")).toBeTruthy()
    expect(screen.getByText("NX 已开启")).toBeTruthy()
  })
})
