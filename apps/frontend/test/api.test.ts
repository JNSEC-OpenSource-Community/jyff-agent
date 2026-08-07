import { describe, expect, it } from "vitest"
import { ApiError, apiRequest, projectApi } from "../src/lib/api.ts"

describe("projectApi", () => {
  it("把 /api/ 路径规范为项目级路径", () => {
    expect(projectApi("p-1", "/api/snapshot")).toBe(
      "/api/projects/p-1/snapshot",
    )
  })

  it("已含项目前缀的路径按原样拼接（旧式 /api 后缀兼容）", () => {
    expect(projectApi("p-1", "/api/projects/p-1/x")).toBe(
      "/api/projects/p-1/projects/p-1/x",
    )
  })

  it("处理不带前导斜杠的 /api/ 形式", () => {
    expect(projectApi("p-1", "api/snapshot")).toBe("/api/projects/p-1/snapshot")
  })

  it("把 /api 与 api 归一为空路径", () => {
    expect(projectApi("p-1", "/api")).toBe("/api/projects/p-1")
    expect(projectApi("p-1", "api")).toBe("/api/projects/p-1")
  })

  it("对项目 ID 做 encodeURIComponent", () => {
    expect(projectApi("a/b c", "/api/snapshot")).toBe(
      "/api/projects/a%2Fb%20c/snapshot",
    )
  })
})

describe("apiRequest", () => {
  it("非 2xx 抛出带 code 的 ApiError", async () => {
    const original = globalThis.fetch
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({ error: "model_unavailable", message: "模型未配置" }),
        { status: 503, headers: { "content-type": "application/json" } },
      )
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
