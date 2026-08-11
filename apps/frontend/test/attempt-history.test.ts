// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { createElement } from "react"
import { afterEach, describe, expect, it, vi } from "vite-plus/test"
import { AttemptHistory } from "../src/pages/challenge/AttemptHistory.tsx"
import type { DashboardRun } from "../src/types.ts"

afterEach(cleanup)

describe("AttemptHistory", () => {
  it("展示 Solver 创建失败的持久化根因", () => {
    render(
      createElement(AttemptHistory, {
        projectId: "project-1",
        runs: [
          {
            id: "run-1",
            attempt: 1,
            status: "failed",
            createdAt: "2026-08-10T00:00:00.000Z",
            events: [
              {
                id: 1,
                runId: "run-1",
                type: "run_creation_failed",
                data: { error: "Docker daemon 无法连接" },
                createdAt: "2026-08-10T00:00:01.000Z",
              },
            ],
            subagents: [],
            cache: {
              inputTokens: 0,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              cacheRate: null,
            },
            hasConversation: false,
            challengeId: "challenge-1",
            workspace: "workspace",
            source: "manual",
            error: "Docker daemon 无法连接",
            updatedAt: "2026-08-10T00:00:01.000Z",
          } satisfies DashboardRun,
        ],
        onChanged: vi.fn().mockResolvedValue(undefined),
      }),
    )

    fireEvent.click(screen.getByRole("button", { name: "查看运行事件" }))
    expect(screen.getByText("创建 Solver 失败")).toBeTruthy()
    expect(screen.getByText("运行失败原因：Docker daemon 无法连接")).toBeTruthy()
  })
})
