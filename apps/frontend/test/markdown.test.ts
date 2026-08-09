import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import {
  MarkdownContent,
  safeUrlTransform,
} from "../src/components/content/MarkdownContent.tsx"

describe("MarkdownContent", () => {
  it("渲染 GFM 且忽略原始 HTML", () => {
    const html = renderToStaticMarkup(
      createElement(
        MarkdownContent,
        null,
        "**结论**\n\n- [x] 完成\n\n<script>alert(1)</script>",
      ),
    )
    expect(html).toContain("<strong>结论</strong>")
    expect(html).toContain('type="checkbox"')
    expect(html).not.toContain("script")
    expect(html).not.toContain("alert(1)")
  })

  it("仅允许安全链接协议", () => {
    expect(safeUrlTransform("https://example.com/a")).toBe(
      "https://example.com/a",
    )
    expect(safeUrlTransform("/writeups/1")).toBe("/writeups/1")
    expect(safeUrlTransform("javascript:alert(1)")).toBe("")
    expect(safeUrlTransform("data:text/html,boom")).toBe("")
  })

  it("使用 highlight.js 高亮 fenced code block", () => {
    const html = renderToStaticMarkup(
      createElement(
        MarkdownContent,
        null,
        "```python\nif solved:\n    print('flag')\n```",
      ),
    )
    expect(html).toContain('class="hljs language-python"')
    expect(html).toContain("hljs-keyword")
    expect(html).toContain("hljs-built_in")
  })
})
