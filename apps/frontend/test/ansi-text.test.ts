import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { AnsiText, parseAnsi } from "../src/components/content/AnsiText.tsx"

describe("AnsiText", () => {
  it("渲染基础色、粗体和重置", () => {
    const segments = parseAnsi("plain \u001b[1;31mFAIL\u001b[0m done")
    expect(segments).toEqual([
      { text: "plain ", style: {} },
      { text: "FAIL", style: { color: "#ef6b73", fontWeight: 600 } },
      { text: " done", style: {} },
    ])
  })

  it("支持 256 色与 RGB 色并移除非 SGR 控制序列", () => {
    const html = renderToStaticMarkup(
      createElement(AnsiText, {
        text: "\u001b[38;5;214mamber\u001b[0m \u001b[38;2;10;20;30mrgb\u001b[0m\u001b[2J",
      }),
    )
    expect(html).toContain("rgb(255, 175, 0)")
    expect(html).toContain("rgb(10, 20, 30)")
    expect(html).not.toContain("[2J")
  })
})
