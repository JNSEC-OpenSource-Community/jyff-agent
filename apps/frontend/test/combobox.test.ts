// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react"
import { createElement } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Combobox } from "../src/components/ui/combobox.tsx"

afterEach(cleanup)

describe("Combobox", () => {
  it("长的已选标签会收缩并保留完整 hover 提示", () => {
    const label = "opencode/deepseek-v4-flash-free@max"
    render(
      createElement(Combobox, {
        value: "model-1",
        onChange: vi.fn(),
        options: [{ value: "model-1", label }],
      }),
    )

    const selected = screen.getByTitle(label)
    expect(selected.className).toContain("min-w-0")
    expect(selected.className).toContain("truncate")
  })
})
