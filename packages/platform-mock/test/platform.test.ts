import { describe, expect, it } from "vitest"
import { MockPlatformPlugin } from "../src/index.js"

describe("Mock Platform", () => {
  it("Project 能获得比赛全貌，Solver capability 只能操作当前题", async () => {
    const platform = await new MockPlatformPlugin().connect({
      project: { id: "event", name: "Test CTF" },
      resolveSecret: () => undefined,
      config: {
        announcements: [{ id: "notice", title: "公告", content: "hello", publishedAt: "2026-01-01" }],
        challenges: [
          { id: "one", title: "One", category: "misc", score: 1, description: "one", attachments: [{ id: "a", name: "one.txt", content: "ONE" }], flag: "ONE" },
          { id: "two", title: "Two", category: "pwn", score: 2, description: "two", attachments: [{ id: "b", name: "two.txt", content: "TWO" }], flag: "TWO", remote: true },
        ],
      },
    })

    expect(await platform.listChallenges()).toHaveLength(2)
    expect(await platform.listAnnouncements()).toHaveLength(1)
    expect(await platform.getOverview()).toMatchObject({ id: "event", name: "Test CTF" })

    const one = await platform.bindChallenge("one")
    expect(one.instance).toBeUndefined()
    await expect(one.downloadAttachment("b")).rejects.toThrow("当前题不存在附件")
    expect(await one.submitFlag("TWO")).toMatchObject({ status: "rejected" })

    const two = await platform.bindChallenge("two")
    expect(two.instance).toBeDefined()
    const environment = await two.instance?.start()
    expect(environment?.challengeId).toBe("two")
    expect(await platform.listRemoteEnvironments()).toHaveLength(1)
  })

  it("插件负责拒绝非法配置", () => {
    const plugin = new MockPlatformPlugin()
    expect(() => plugin.config.parse({ challenges: "invalid" })).toThrow("challenges 必须是数组")
  })
})
