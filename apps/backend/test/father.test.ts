import { describe, expect, it, vi } from "vitest"
import type { DashboardFather } from "../src/types.ts"
import { createTestApp, jsonOf, jsonRequest } from "./helpers.ts"

describe("Father HTTP", () => {
  it("未启用 WebUI 登录时使用 local 创建无参数 Session", async () => {
    const create = vi.fn(async (input: { createdBy: string }) => ({
      id: "father-1",
      title: "amber-otter",
      status: "draft" as const,
      modelId: "test/model",
      skillRevision: "builtin-v1",
      createdBy: input.createdBy,
      createdAt: "2026-08-09T00:00:00.000Z",
      updatedAt: "2026-08-09T00:00:00.000Z",
    }))
    const father = { list: () => [], create } as unknown as DashboardFather
    const test = await createTestApp({ father, frontendDist: "/nonexistent" })
    try {
      const response = await jsonRequest(
        test.app,
        "/api/father/sessions",
        "POST",
        {},
      )
      expect(response.status).toBe(201)
      expect(await jsonOf(response)).toMatchObject({ createdBy: "local" })
      expect(create).toHaveBeenCalledWith({ createdBy: "local" })
    } finally {
      await test.cleanup()
    }
  })
})
