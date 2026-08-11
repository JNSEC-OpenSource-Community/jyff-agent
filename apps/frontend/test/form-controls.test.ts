// @vitest-environment jsdom

import { render, screen } from "@testing-library/react"
import { createElement } from "react"
import { describe, expect, it } from "vite-plus/test"
import { Switch } from "../src/components/ui/switch.tsx"

describe("form controls", () => {
  it("keeps the enabled switch track and thumb visually distinct", () => {
    render(
      createElement(Switch, {
        checked: true,
        onCheckedChange: () => undefined,
        "aria-label": "启用设置",
      }),
    )

    const control = screen.getByRole("switch")
    const thumb = control.querySelector<HTMLElement>('[data-slot="switch-thumb"]')

    expect(control.getAttribute("data-state")).toBe("checked")
    expect(control.className).toContain("data-[state=checked]:bg-foreground/70")
    expect(thumb?.className).toContain("data-[state=checked]:bg-background")
  })
})
