// @vitest-environment jsdom

import { render, screen } from "@testing-library/react"
import { userEvent } from "@testing-library/user-event"
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

  it("自动展开小目录并保持大目录折叠", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        files: [
          {
            path: "artifacts/scripts/exploit.py",
            size: 1536,
            modifiedAt: "2026-08-09T00:00:00.000Z",
          },
          ...Array.from({ length: 8 }, (_, index) => ({
            path: `bulk/file-${index}.bin`,
            size: index,
            modifiedAt: "2026-08-09T00:00:00.000Z",
          })),
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

    const user = userEvent.setup()
    const artifacts = await screen.findByRole("button", { name: /artifacts/ })
    expect(screen.queryByText("Workspace 文件")).toBeNull()
    expect(artifacts.getAttribute("aria-expanded")).toBe("true")
    const scripts = screen.getByRole("button", { name: /scripts/ })
    expect(scripts.getAttribute("aria-expanded")).toBe("true")
    expect(screen.getByText("exploit.py")).toBeTruthy()
    expect(screen.getByText("1.5 KiB")).toBeTruthy()
    expect(screen.getByText("9 个文件")).toBeTruthy()

    const bulk = screen.getByRole("button", { name: /bulk/ })
    expect(bulk.getAttribute("aria-expanded")).toBe("false")
    expect(screen.queryByText("file-0.bin")).toBeNull()
    await user.click(bulk)
    expect(screen.getByText("file-0.bin")).toBeTruthy()
    const download = screen.getByRole("link", {
      name: "下载 artifacts/scripts/exploit.py",
    })
    expect(download.getAttribute("href")).toBe(
      "/api/projects/demo%2Fproject/challenges/pwn%2F1/files/download?path=artifacts%2Fscripts%2Fexploit.py",
    )
  })
})
