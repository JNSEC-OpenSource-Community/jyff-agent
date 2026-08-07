import { describe, expect, it } from "vitest"
import { projectApi } from "../src/client/api.ts"

describe("projectApi", () => {
  it.each([
    ["/api/snapshot", "/api/projects/demo/snapshot"],
    ["api/snapshot", "/api/projects/demo/snapshot"],
    ["/snapshot", "/api/projects/demo/snapshot"],
    ["snapshot", "/api/projects/demo/snapshot"],
    ["/api", "/api/projects/demo"],
  ])("将项目内 API 路径 %s 映射到 %s", (path, expected) => {
    expect(projectApi("demo", path)).toBe(expected)
  })

  it("编码 Project ID，避免生成歧义路由", () => {
    expect(projectApi("event/2026", "/api/events")).toBe(
      "/api/projects/event%2F2026/events",
    )
  })
})
