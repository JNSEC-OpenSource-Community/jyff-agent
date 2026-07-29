import { describe, expect, it } from "vitest"
import { parseProjectConfig } from "../../src/project/config.js"

describe("Project 配置", () => {
  it("补全并验证 sandbox 配置", () => {
    expect(parseProjectConfig({
      version: 1,
      project: { id: "p", name: "P" },
      contest: { platform: "mock", eventId: "e" },
      platform: { config: {} },
      sandbox: { image: "solver" },
    })).toMatchObject({ sandbox: { image: "solver", privileged: false, networkMode: "bridge" } })
  })

  it("拒绝不支持的网络模式", () => {
    expect(() => parseProjectConfig({
      version: 1,
      project: { id: "p", name: "P" }, contest: { platform: "mock", eventId: "e" }, platform: {},
      sandbox: { image: "solver", networkMode: "invalid" },
    })).toThrow("networkMode")
  })
})
