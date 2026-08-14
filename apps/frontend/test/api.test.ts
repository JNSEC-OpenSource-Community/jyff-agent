import { describe, expect, it } from "vite-plus/test"
import { ApiError, apiRequest, projectApi } from "../src/lib/api.ts"

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

  it("对项目 ID 做 encodeURIComponent", () => {
    expect(projectApi("event/2026", "/api/events")).toBe("/api/projects/event%2F2026/events")
  })
})

describe("apiRequest", () => {
  it("非 2xx 抛出带 code 的 ApiError", async () => {
    const original = globalThis.fetch
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: "model_unavailable", message: "模型未配置" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      })
    try {
      const promise = apiRequest<never>("/x")
      await expect(promise).rejects.toMatchObject({
        name: "ApiError",
        status: 503,
        code: "model_unavailable",
        message: "模型未配置",
      })
    } finally {
      globalThis.fetch = original
    }
  })

  it("错误响应缺少 error 字段时回退 code", async () => {
    const original = globalThis.fetch
    globalThis.fetch = async () => new Response("oops", { status: 500 })
    try {
      await expect(apiRequest<never>("/x")).rejects.toMatchObject({
        status: 500,
        code: "request_failed",
      })
    } finally {
      globalThis.fetch = original
    }
  })

  it("成功响应返回 JSON 数据", async () => {
    const original = globalThis.fetch
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    try {
      await expect(apiRequest<{ ok: boolean }>("/x")).resolves.toEqual({
        ok: true,
      })
    } finally {
      globalThis.fetch = original
    }
  })
})

describe("ApiError", () => {
  it("携带 status/code 且 name 为 ApiError", () => {
    const error = new ApiError(409, "no_active_run", "无活跃运行")
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe("ApiError")
    expect(error.status).toBe(409)
    expect(error.code).toBe("no_active_run")
    expect(error.message).toBe("无活跃运行")
  })
})
