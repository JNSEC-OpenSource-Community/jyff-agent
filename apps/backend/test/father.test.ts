import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vite-plus/test"
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
      const response = await jsonRequest(test.app, "/api/father/sessions", "POST", {})
      expect(response.status).toBe(201)
      expect(await jsonOf(response)).toMatchObject({ createdBy: "local" })
      expect(create).toHaveBeenCalledWith({ createdBy: "local" })
    } finally {
      await test.cleanup()
    }
  })

  it("导出 HTML 并删除 Session", async () => {
    const record = {
      id: "father-1",
      title: "amber-otter",
      status: "stopped" as const,
      modelId: "test/model",
      skillRevision: "builtin-v1",
      createdBy: "local",
      createdAt: "2026-08-09T00:00:00.000Z",
      updatedAt: "2026-08-09T00:00:00.000Z",
    }
    const remove = vi.fn(async () => undefined)
    const removeValidationConfig = vi.fn(async () => undefined)
    const father = {
      list: () => [record],
      get: () => record,
      sessionPath: () => "/sessions/father-1.jsonl",
      delete: remove,
    } as unknown as DashboardFather
    const test = await createTestApp({
      father,
      fatherValidationConfigs: {
        delete: removeValidationConfig,
      } as never,
      frontendDist: "/nonexistent",
      sessionHasConversation: async () => true,
      exportSessionHtml: async () => Buffer.from("<html>father</html>"),
    })
    try {
      const exported = await test.app.request("/api/father/sessions/father-1/export")
      expect(exported.status).toBe(200)
      expect(await exported.text()).toContain("father")
      const deleted = await jsonRequest(test.app, "/api/father/sessions/father-1", "DELETE")
      expect(deleted.status).toBe(200)
      expect(removeValidationConfig).toHaveBeenCalledWith("father-1")
      expect(remove).toHaveBeenCalledWith("father-1")
    } finally {
      await test.cleanup()
    }
  })

  it("中止正在运行的 Father Session", async () => {
    const stop = vi.fn(async () => ({ id: "father-1", status: "stopped" }))
    const father = { stop } as unknown as DashboardFather
    const test = await createTestApp({ father, frontendDist: "/nonexistent" })
    try {
      const response = await jsonRequest(test.app, "/api/father/sessions/father-1/stop", "POST", {})
      expect(response.status).toBe(200)
      expect(await jsonOf(response)).toMatchObject({ status: "stopped" })
      expect(stop).toHaveBeenCalledWith("father-1")
    } finally {
      await test.cleanup()
    }
  })

  it("使用 Session 持久化报告恢复批准安装", async () => {
    const report = {
      pluginId: "demo-platform",
      revision: "abc123",
      contentHash: "a".repeat(64),
      harnessVersion: "1",
      profileId: "father-father-1",
      profileFingerprint: "profile",
      authorSessionId: "father-1",
      status: "read_only_verified" as const,
      startedAt: "2026-08-09T00:00:00.000Z",
      completedAt: "2026-08-09T00:00:01.000Z",
      checks: [],
      capabilities: {},
      cleanup: { projectClosed: true, environmentDestroyed: null },
    }
    const record = {
      id: "father-1",
      title: "demo-platform",
      status: "stopped" as const,
      modelId: "test/model",
      skillRevision: "builtin-v1",
      createdBy: "local",
      createdAt: "2026-08-09T00:00:00.000Z",
      updatedAt: "2026-08-09T00:00:01.000Z",
      gate: {
        status: "ready" as const,
        requestedAt: "2026-08-09T00:00:00.000Z",
        report,
      },
    }
    const setGateStatus = vi.fn(async () => record)
    const father = {
      get: () => record,
      workspace: () => "/father/workspace",
      setGateStatus,
    } as unknown as DashboardFather
    const activate = vi.fn(async () => ({
      id: "demo-platform",
      name: "Demo Platform",
      version: "1.0.0",
      activeRevision: "abc123",
    }))
    const test = await createTestApp({
      father,
      extensions: { activate } as never,
      frontendDist: "/nonexistent",
    })
    try {
      const response = await jsonRequest(
        test.app,
        "/api/father/sessions/father-1/activate",
        "POST",
        {},
      )
      expect(response.status).toBe(200)
      expect(activate).toHaveBeenCalledWith({
        sessionId: "father-1",
        candidateDirectory: join("/father/workspace", "output"),
        validationReport: report,
      })
      expect(setGateStatus).toHaveBeenCalledWith(
        "father-1",
        expect.objectContaining({ status: "installed", report }),
      )
    } finally {
      await test.cleanup()
    }
  })

  it("下载候选插件的单个 TypeScript 入口", async () => {
    const record = {
      id: "father-1",
      title: "demo-platform",
      status: "stopped" as const,
      modelId: "test/model",
      skillRevision: "builtin-v1",
      createdBy: "local",
      createdAt: "2026-08-09T00:00:00.000Z",
      updatedAt: "2026-08-09T00:00:00.000Z",
    }
    const father = {
      get: () => record,
      workspace: () => "/father/workspace",
    } as unknown as DashboardFather
    const readCandidateEntry = vi.fn(async () => ({
      filename: "demo-platform.ts",
      content: Buffer.from("export default {}"),
    }))
    const test = await createTestApp({
      father,
      extensions: { readCandidateEntry } as never,
      frontendDist: "/nonexistent",
    })
    try {
      const response = await test.app.request("/api/father/sessions/father-1/plugin.ts")
      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toContain("text/typescript")
      expect(response.headers.get("content-disposition")).toContain("demo-platform.ts")
      expect(await response.text()).toBe("export default {}")
      expect(readCandidateEntry).toHaveBeenCalledWith(join("/father/workspace", "output"))
    } finally {
      await test.cleanup()
    }
  })

  it("列出、预览并下载 Father workspace 文件", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "father-workspace-"))
    await mkdir(join(workspace, "plugin"), { recursive: true })
    await writeFile(join(workspace, "plugin", "index.ts"), "export const id = 'demo'\n")
    await writeFile(join(workspace, "fixture.bin"), Buffer.from([0, 1, 2]))
    const record = {
      id: "father-1",
      title: "demo-platform",
      status: "stopped" as const,
      modelId: "test/model",
      skillRevision: "builtin-v1",
      createdBy: "local",
      createdAt: "2026-08-09T00:00:00.000Z",
      updatedAt: "2026-08-09T00:00:00.000Z",
    }
    const father = {
      get: () => record,
      workspace: () => workspace,
    } as unknown as DashboardFather
    const test = await createTestApp({
      father,
      frontendDist: "/nonexistent",
    })
    try {
      const listing = await test.app.request("/api/father/sessions/father-1/workspace/files")
      expect(listing.status).toBe(200)
      expect(await jsonOf(listing)).toMatchObject({
        truncated: false,
        files: expect.arrayContaining([
          expect.objectContaining({
            path: "plugin/index.ts",
            preview: { kind: "code", language: "typescript" },
          }),
          expect.objectContaining({ path: "fixture.bin", preview: null }),
        ]),
      })

      const preview = await test.app.request(
        "/api/father/sessions/father-1/workspace/files/preview?path=plugin%2Findex.ts",
      )
      expect(preview.status).toBe(200)
      expect(await jsonOf(preview)).toMatchObject({
        path: "plugin/index.ts",
        content: "export const id = 'demo'\n",
      })

      const download = await test.app.request(
        "/api/father/sessions/father-1/workspace/files/download?path=fixture.bin",
      )
      expect(download.status).toBe(200)
      expect(new Uint8Array(await download.arrayBuffer())).toEqual(new Uint8Array([0, 1, 2]))

      const traversal = await test.app.request(
        "/api/father/sessions/father-1/workspace/files/download?path=..%2Fsecret.txt",
      )
      expect(traversal.status).toBe(400)
    } finally {
      await test.cleanup()
      await rm(workspace, { recursive: true, force: true })
    }
  })
})
