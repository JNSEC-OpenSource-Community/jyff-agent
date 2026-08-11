import { describe, expect, it } from "vite-plus/test"
import { extractGameId, parseConfig, ret2shellPlatform } from "../src/ret2shell.ts"

describe("Ret2Shell platform", () => {
  it("解析比赛 URL、认证类型与可选 game ID", () => {
    expect(
      parseConfig({
        baseUrl: "https://ctf.xidian.edu.cn/games/37/",
        auth: { type: "basic" },
      }),
    ).toEqual({
      baseUrl: "https://ctf.xidian.edu.cn",
      gameId: 37,
      auth: { type: "basic" },
    })
    expect(extractGameId("game-37", true)).toBe(37)
    expect(() =>
      parseConfig({ baseUrl: "https://ctf.example", auth: { type: "basic", token: "no" } }),
    ).toThrow("credentials must be provided through secrets")
  })

  it("声明控制面网络需求，使本地 wsrx 隧道可被 Solver 使用", async () => {
    const project = await ret2shellPlatform.connect({
      project: { id: "37", name: "Example" },
      config: { baseUrl: "https://ctf.example", auth: { type: "bearer" } },
      resolveSecret: (name) => (name === "R2S_TOKEN" ? "token" : undefined),
    })
    expect(project.solverSandboxNetwork).toBe("control_plane")
    await project.close()
  })
})
