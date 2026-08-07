import { describe, expect, it } from "vitest"
import { roleLabel, textContent, toolLabel } from "../src/lib/conversation.ts"

describe("textContent", () => {
  it("原样返回字符串 content", () => {
    expect(textContent("plain")).toBe("plain")
  })

  it("拼接 parts 数组中的 text 片段", () => {
    expect(
      textContent([
        { type: "text", text: "你好" },
        { type: "text", text: "世界" },
      ]),
    ).toBe("你好\n世界")
  })

  it("忽略非 text 片段（thinking/toolCall）", () => {
    expect(
      textContent([
        { type: "text", text: "保留" },
        { type: "thinking", thinking: "丢弃", redacted: false },
        { type: "toolCall", id: "t1", name: "bash", arguments: {} },
      ]),
    ).toBe("保留")
  })

  it("对非法输入返回空串", () => {
    expect(textContent(null)).toBe("")
    expect(textContent(undefined)).toBe("")
    expect(textContent(42)).toBe("")
    expect(textContent({ type: "text", text: "对象" })).toBe("")
  })

  it("过滤缺 text 字段的伪 text 片段", () => {
    expect(textContent([{ type: "text" }, { type: "text", text: "" }])).toBe("")
  })
})

describe("roleLabel", () => {
  it("映射三种角色标签", () => {
    expect(roleLabel("assistant")).toBe("AGENT")
    expect(roleLabel("user")).toBe("YOU / SYSTEM")
    expect(roleLabel("toolResult")).toBe("TOOL")
  })
})

describe("toolLabel", () => {
  it("已知工具返回中文标签", () => {
    expect(toolLabel("bash")).toBe("终端命令")
    expect(toolLabel("ctf_submit_flag")).toBe("提交 Flag")
  })

  it("未知工具原样返回", () => {
    expect(toolLabel("unknown_tool")).toBe("unknown_tool")
  })
})
