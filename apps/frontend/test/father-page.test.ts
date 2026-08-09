// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { createElement } from "react"
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom"
import { afterEach, describe, expect, it, vi } from "vitest"
import { FatherPage } from "../src/pages/FatherPage.tsx"

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("Clanker Father 入口", () => {
  it("只显示 Session 列表并可无表单新建后进入对话", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async (_input, init) =>
        new Response(
          JSON.stringify(
            init?.method === "POST"
              ? {
                  id: "father-1",
                  title: "amber-otter",
                  status: "draft",
                  modelId: "test/model",
                  updatedAt: new Date().toISOString(),
                }
              : { sessions: [] },
          ),
          {
            status: init?.method === "POST" ? 201 : 200,
            headers: { "content-type": "application/json" },
          },
        ),
    )
    vi.stubGlobal("fetch", fetchMock)
    render(
      createElement(
        MemoryRouter,
        { initialEntries: ["/father"] },
        createElement(
          Routes,
          null,
          createElement(Route, {
            path: "/father",
            element: createElement(FatherPage),
          }),
          createElement(Route, {
            path: "/father/sessions/:sessionId",
            element: createElement(Location),
          }),
        ),
      ),
    )

    expect(await screen.findByText("还没有 Father 会话")).toBeTruthy()
    expect(screen.queryByPlaceholderText("插件 ID，如 rctf")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "新建会话" }))
    await waitFor(() =>
      expect(screen.getByTestId("location").textContent).toBe(
        "/father/sessions/father-1",
      ),
    )
    expect(fetchMock.mock.calls[1]?.[1]?.body).toBe("{}")
  })
})

function Location(): React.ReactElement {
  return createElement(
    "span",
    { "data-testid": "location" },
    useLocation().pathname,
  )
}
