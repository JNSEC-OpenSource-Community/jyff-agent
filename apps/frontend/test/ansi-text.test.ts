import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vite-plus/test"
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

  it("恢复上游移除 ESC 后残留的终端控制序列", () => {
    const segments = parseAnsi("First chars: [?1049h[H[2J[?1000l[1;1H[0m[31mRED[0m[2;1Hdone")

    expect(segments.map((segment) => segment.text).join("")).toBe("First chars: REDdone")
    expect(segments).toContainEqual({
      text: "RED",
      style: { color: "#ef6b73" },
    })
  })

  it("兼容 C1 CSI 与日志中转义后的 ESC", () => {
    const segments = parseAnsi(
      `${String.fromCharCode(0x9b)}32mgreen${String.fromCharCode(0x9b)}0m \\u001b[1;31mred\\u001b[0m`,
    )

    expect(segments).toEqual([
      { text: "green", style: { color: "#65b88a" } },
      { text: " ", style: {} },
      { text: "red", style: { color: "#ef6b73", fontWeight: 600 } },
    ])
  })
})
