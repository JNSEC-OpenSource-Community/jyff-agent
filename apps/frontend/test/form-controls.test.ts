// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react"
import { createElement } from "react"
import { describe, expect, it, vi } from "vite-plus/test"
import { Switch } from "../src/components/ui/switch.tsx"

describe("form controls", () => {
  it("exposes its checked state and emits the next value", () => {
    const onCheckedChange = vi.fn()
    render(
      createElement(Switch, {
        checked: true,
        onCheckedChange,
        "aria-label": "启用设置",
      }),
    )

    const control = screen.getByRole("switch", { name: "启用设置" })
    expect(control.getAttribute("aria-checked")).toBe("true")

    fireEvent.click(control)
    expect(onCheckedChange).toHaveBeenCalledWith(false)
  })
})
