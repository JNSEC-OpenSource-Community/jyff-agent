import { describe, expect, it } from "vite-plus/test"
import { contestIdFromName } from "../src/lib/contest-name.ts"

describe("contestIdFromName", () => {
  it("将中文名称转成无声调拼音 ID", async () => {
    await expect(contestIdFromName("极客大挑战 2026")).resolves.toBe("ji-ke-da-tiao-zhan-2026")
  })

  it("规范化符号并限制长度", async () => {
    await expect(contestIdFromName("  Sekai CTF / Finals!  ")).resolves.toBe("sekai-ctf-finals")
    await expect(contestIdFromName("赛".repeat(100))).resolves.toHaveLength(64)
  })

  it("空白名称返回空 ID", async () => {
    await expect(contestIdFromName("  ")).resolves.toBe("")
  })
})
