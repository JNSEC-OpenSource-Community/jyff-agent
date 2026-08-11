// @vitest-environment jsdom

import { render, screen } from "@testing-library/react"
import { createElement } from "react"
import { describe, expect, it } from "vite-plus/test"
import { Sheet, SheetContent, SheetTitle } from "../src/components/ui/sheet.tsx"

describe("Sheet", () => {
  it("exposes the bottom side for its responsive transition", () => {
    render(
      createElement(
        Sheet,
        { open: true },
        createElement(
          SheetContent,
          { side: "bottom" },
          createElement(SheetTitle, null, "题目与 Agents"),
        ),
      ),
    )

    const content = screen.getByRole("dialog")
    expect(content.getAttribute("data-side")).toBe("bottom")
    expect(content.getAttribute("data-state")).toBe("open")
    expect(content.classList.contains("sheet-content")).toBe(true)
  })
})
