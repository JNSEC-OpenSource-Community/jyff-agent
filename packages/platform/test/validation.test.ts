import { describe, expect, it, vi } from "vitest"
import type { PlatformPlugin } from "../src/index.ts"
import {
  fingerprintProfile,
  PlatformPluginRegistry,
  validatePlatformPlugin,
} from "../src/index.ts"

describe("PlatformPluginRegistry", () => {
  it("拒绝扩展覆盖内置插件", () => {
    const builtin = plugin("builtin")
    const registry = new PlatformPluginRegistry([builtin])

    expect(() =>
      registry.registerExtension({
        plugin: builtin,
        revision: "rev-1",
        authorSessionId: "father-1",
      }),
    ).toThrow("不能覆盖内置")
  })
})

describe("validatePlatformPlugin", () => {
  it("使用真实插件契约生成只读验收报告并关闭连接", async () => {
    const close = vi.fn()
    const candidate = plugin("candidate", close)
    const profile = {
      id: "profile-1",
      project: { id: "test", name: "Test" },
      config: { baseUrl: "https://example.test" },
      secrets: { TOKEN: "top-secret" },
      expected: { contestId: "contest", challengeId: "web-1" },
    }

    const report = await validatePlatformPlugin({
      plugin: candidate,
      revision: "rev-1",
      contentHash: "abc",
      authorSessionId: "father-1",
      profile,
    })

    expect(report.status).toBe("read_only_verified")
    expect(report.profileFingerprint).toBe(fingerprintProfile(profile))
    expect(report.capabilities.challengeInfo).toBe("passed")
    expect(report.capabilities.submitFlag).toBe("skipped")
    expect(report.cleanup.projectClosed).toBe(true)
    expect(close).toHaveBeenCalledOnce()
    expect(JSON.stringify(report)).not.toContain("top-secret")
  })

  it("任一真实契约失败时阻止候选通过", async () => {
    const candidate = plugin("broken")
    candidate.connect = async () => {
      throw new Error("Authorization: secret-token")
    }

    const report = await validatePlatformPlugin({
      plugin: candidate,
      revision: "rev-2",
      contentHash: "def",
      authorSessionId: "father-2",
      profile: {
        id: "profile-2",
        project: { id: "test", name: "Test" },
        config: {},
      },
    })

    expect(report.status).toBe("failed")
    expect(
      report.checks.find(({ id }) => id === "plugin.connect")?.message,
    ).toContain("[redacted]")
  })
})

function plugin(id: string, close = vi.fn()): PlatformPlugin {
  const overview = {
    id: "contest",
    name: "Contest",
    challenges: 1,
    announcements: 0,
  }
  return {
    id,
    config: { parse: (value) => value },
    async connect() {
      return {
        async refresh() {
          return overview
        },
        async getOverview() {
          return overview
        },
        async listChallenges() {
          return [
            {
              id: "web-1",
              title: "Web",
              category: "web",
              score: 100,
            },
          ]
        },
        async listAnnouncements() {
          return []
        },
        async listRemoteEnvironments() {
          return []
        },
        async getRemoteEnvironment() {
          return null
        },
        async destroyRemoteEnvironment() {},
        async bindChallenge(challengeId) {
          return {
            async getInfo() {
              return {
                id: challengeId,
                title: "Web",
                category: "web",
                score: 100,
                description: "test",
                attachments: [],
              }
            },
            async downloadAttachment() {
              throw new Error("attachment unavailable")
            },
            async submitFlag() {
              return { status: "rejected", message: "Wrong" }
            },
          }
        },
        close,
      }
    },
  }
}
