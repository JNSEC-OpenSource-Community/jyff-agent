// @vitest-environment jsdom

import { render, screen } from "@testing-library/react"
import { createElement } from "react"
import { describe, expect, it } from "vite-plus/test"
import { Sheet, SheetContent, SheetTitle } from "../src/components/ui/sheet.tsx"

describe("Sheet", () => {
  it("opens a titled dialog for the mobile details view", () => {
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

    expect(screen.getByRole("dialog", { name: "题目与 Agents" })).toBeTruthy()
  })
})
