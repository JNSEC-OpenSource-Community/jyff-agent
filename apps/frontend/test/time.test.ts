import { describe, expect, it } from "vite-plus/test"
import { absoluteTime, relativeTime } from "../src/lib/time.ts"

describe("time formatters", () => {
  it("把 ISO 时间格式化为本地可读时间", () => {
    const formatted = absoluteTime("2025-07-18T13:20:12.708Z")
    expect(formatted).not.toContain("T13:20:12.708Z")
    expect(formatted).toContain("2025")
  })

  it("处理空值和无效时间", () => {
    expect(relativeTime(null)).toBe("暂无")
    expect(relativeTime("invalid")).toBe("时间未知")
    expect(absoluteTime("invalid")).toBe("时间未知")
  })
})
