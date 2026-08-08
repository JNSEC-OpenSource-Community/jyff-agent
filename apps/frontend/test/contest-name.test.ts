import { describe, expect, it } from "vitest"
import { contestIdFromName } from "../src/lib/contest-name.ts"

describe("contestIdFromName", () => {
  it("将中文名称转成无声调拼音 ID", () => {
    expect(contestIdFromName("极客大挑战 2026")).toBe("ji-ke-da-tiao-zhan-2026")
  })

  it("规范化符号并限制长度", () => {
    expect(contestIdFromName("  Sekai CTF / Finals!  ")).toBe(
      "sekai-ctf-finals",
    )
    expect(contestIdFromName("赛".repeat(100))).toHaveLength(64)
  })

  it("空白名称返回空 ID", () => {
    expect(contestIdFromName("  ")).toBe("")
  })
})
