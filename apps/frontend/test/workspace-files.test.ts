// @vitest-environment jsdom

import { render, screen } from "@testing-library/react"
import { createElement } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { WorkspaceFilesPanel } from "../src/pages/challenge/WorkspaceFilesPanel.tsx"

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    headers: { "content-type": "application/json" },
  })
}

describe("Workspace 文件面板", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("列出嵌套文件并生成项目隔离的下载地址", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        files: [
          {
            path: "artifacts/exploit.py",
            size: 1536,
            modifiedAt: "2026-08-09T00:00:00.000Z",
          },
        ],
        truncated: false,
      }),
    )
    vi.stubGlobal("fetch", fetchMock)

    render(
      createElement(WorkspaceFilesPanel, {
        projectId: "demo/project",
        challengeId: "pwn/1",
      }),
    )

    expect(await screen.findByText("exploit.py")).toBeTruthy()
    expect(screen.getByText("artifacts")).toBeTruthy()
    expect(screen.getByText("1.5 KiB")).toBeTruthy()
    const download = screen.getByRole("link", {
      name: "下载 artifacts/exploit.py",
    })
    expect(download.getAttribute("href")).toBe(
      "/api/projects/demo%2Fproject/challenges/pwn%2F1/files/download?path=artifacts%2Fexploit.py",
    )
  })
})
