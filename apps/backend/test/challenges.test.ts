import type { AgentOptions } from "@earendil-works/pi-agent-core"
import { describe, expect, it } from "vitest"
import { createWebUiApp } from "../src/server.ts"
import { FakeDashboardProject, FakeModelConfiguration } from "./fake-project.ts"
import { jsonOf, jsonRequest } from "./helpers.ts"

function appWithProject() {
  const project = new FakeDashboardProject()
  const { app } = createWebUiApp({ project, frontendDist: "/nonexistent" })
  return { app, project }
}

describe("题目路由", () => {
  it("详情包含 SubAgent 列表，未知题目 404", async () => {
    const { app } = appWithProject()
    const details = await app.request("/api/challenges/pwn-1")
    expect(details.status).toBe(200)
    expect(await jsonOf(details)).toMatchObject({
      runs: [
        {
          id: "run-pwn-1",
          subagents: [
            {
              id: "worker-pwn-1",
              role: "pwn",
              status: "running",
              activeTool: "bash",
            },
          ],
        },
      ],
    })
    expect((await app.request("/api/challenges/missing")).status).toBe(404)
  })

  it("详情兜底路径：带任意后缀的 challenge 路径按题目 ID 解析", async () => {
    const { app } = appWithProject()
    expect((await app.request("/api/challenges/pwn-1/export")).status).toBe(404)
    expect(
      await jsonOf(await app.request("/api/challenges/pwn-1/export")),
    ).toMatchObject({ error: "challenge_not_found" })
    // URL 编码的题目 ID 正常解码
    const encoded = await app.request("/api/challenges/pwn%2D1")
    expect(encoded.status).toBe(200)
  })

  it.each([
    { label: "模型未配置时拒绝刷新", configured: false, expectStatus: 503, expectError: "model_unavailable", refreshCalls: 0 },
    { label: "模型配置后刷新成功返回 TLDR 内容", configured: true, expectStatus: 200, refreshCalls: 1, expectContent: "堆溢出利用题" },
  ])("TLDR $label", async ({ configured, expectStatus, expectError, refreshCalls, expectContent }) => {
    const project = new FakeDashboardProject()
    if (configured) {
      project.tldrValue = {
        challengeId: "pwn-1", updatedAt: "2026-07-29T13:00:00.000Z",
        content: "# TLDR\n堆溢出利用题\n检查 glibc 版本", model: "solver",
        sessionPath: "/sessions/tldr.jsonl", error: null,
        inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0,
      }
    }
    const modelConfiguration = new FakeModelConfiguration()
    if (configured) {
      modelConfiguration.value = {
        models: [{ id: "solver", provider: "test", modelId: "solver-model", baseUrl: "https://test", contextWindow: 64_000, thinkingEnabled: true, reasoningEffort: "high", passthroughThinking: false, apiKeyConfigured: true, apiKeySource: "secret-store", configured: true, unavailableReason: undefined, supportedThinkingLevels: ["low", "medium", "high", "max"] }],
        solverModelId: "solver", tldrModelId: "solver", subagentModels: {},
        supportedThinkingLevels: ["low", "medium", "high", "max"],
        configured: true, unavailableReason: undefined,
      }
      modelConfiguration.agentOptionsValue = { model: "solver-model", systemPrompt: "TLDR agent" } as unknown as AgentOptions
    }
    const { app } = createWebUiApp({ project, modelConfiguration, frontendDist: "/nonexistent" })

    const read = await app.request("/api/challenges/pwn-1/tldr")
    expect(read.status).toBe(200)

    const refresh = await jsonRequest(app, "/api/challenges/pwn-1/tldr/refresh", "POST", {})
    expect(refresh.status).toBe(expectStatus)
    if (expectError) expect(await jsonOf(refresh)).toMatchObject({ error: expectError })
    if (expectContent) expect(await jsonOf(refresh)).toMatchObject({ tldr: { challengeId: "pwn-1", content: expect.stringContaining(expectContent) } })
    expect(project.tldrRefreshCalls).toBe(refreshCalls)
  })

  it.each([
    { label: "正常切换", level: "max", expectStatus: 200, expectKey: undefined },
    { label: "非法档位 400", level: "ultra", expectStatus: 400, expectError: "invalid_level" },
    { label: "无活跃 Run 返回 409", level: "low", expectStatus: 409, expectError: "no_active_run", setNoRun: true },
  ])("切换思考强度 $label", async ({ level, expectStatus, expectError, setNoRun }) => {
    const { app, project } = appWithProject()
    if (setNoRun) project.thinkingLevelResult = { error: "no_active_run" }

    const response = await jsonRequest(app, "/api/challenges/pwn-1/thinking-level", "POST", { level })
    expect(response.status).toBe(expectStatus)
    if (expectError) expect(await jsonOf(response)).toMatchObject({ error: expectError })
    if (expectStatus === 200) expect(project.thinkingLevelCalls).toEqual([{ challengeId: "pwn-1", level }])
  })

  it.each([
    { label: "正常发送", text: "先检查文件头", expectStatus: 200, expectResult: { runId: "run-pwn-1" } },
    { label: "空白文本 400", text: "   ", expectStatus: 400 },
    { label: "无活跃 Run 409", text: "继续", expectStatus: 409, setNoRun: true },
    { label: "invalid_message 保留原始文案", text: "x", expectStatus: 400, setInvalidMessage: true, expectMessage: "消息内容不合法(测试)" },
  ])("发送人工消息 $label", async ({ text, expectStatus, expectResult, setNoRun, setInvalidMessage, expectMessage }) => {
    const { app, project } = appWithProject()
    if (setNoRun) project.sendMessageResult = { error: "no_active_run" }
    if (setInvalidMessage) project.sendMessageResult = { error: "invalid_message" }

    const response = await jsonRequest(app, "/api/challenges/pwn-1/message", "POST", { text })
    expect(response.status).toBe(expectStatus)
    if (expectResult) expect(await jsonOf(response)).toEqual(expectResult)
    if (expectMessage) expect(await jsonOf(response)).toMatchObject({ error: "invalid_message", message: expectMessage })
  })

  it("消息路由不要求 scheduler（dispatch 才要求）", async () => {
    const { app } = appWithProject()
    expect((await jsonRequest(app, "/api/challenges/pwn-1/dispatch", "POST", {})).status).toBe(503)
  })

  it.each([
    { label: "内容可用时返回 markdown 附件", valid: true, errors: [] as string[], content: "# pwn-1 writeup\n\nheap exploit", expectStatus: 200, expectContentType: "text/markdown", expectBody: "# pwn-1 writeup" },
    { label: "不可用时返回 409 与校验详情", valid: false, errors: ["no_solution_yet"], content: null, expectStatus: 409, expectError: "writeup_unavailable", expectValidation: { valid: false, errors: ["no_solution_yet"] } },
  ])("writeup $label", async ({ valid, errors, content, expectStatus, expectContentType, expectBody, expectError, expectValidation }) => {
    const project = new FakeDashboardProject()
    project.writeupValue = {
      validation: { valid, path: "/workspace/pwn-1/writeup.md", errors, size: valid ? 42 : 0 },
      content,
    }
    const { app } = createWebUiApp({ project, frontendDist: "/nonexistent" })

    const response = await app.request("/api/challenges/pwn-1/writeup")
    expect(response.status).toBe(expectStatus)
    if (expectContentType) expect(response.headers.get("content-type")).toContain(expectContentType)
    if (expectBody) expect(await response.text()).toContain(expectBody)
    if (expectError) expect(await jsonOf(response)).toMatchObject({ error: expectError, validation: expectValidation })
  })
})
