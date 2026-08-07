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

  it("TLDR：读取、刷新与模型未配置 503", async () => {
    const { app, project } = appWithProject()

    const read = await app.request("/api/challenges/pwn-1/tldr")
    expect(read.status).toBe(200)
    expect(await jsonOf(read)).toMatchObject({ tldr: null })

    // 未配置模型配置/模型时刷新 → 503 model_unavailable
    const refresh = await jsonRequest(
      app,
      "/api/challenges/pwn-1/tldr/refresh",
      "POST",
      {},
    )
    expect(refresh.status).toBe(503)
    expect(await jsonOf(refresh)).toMatchObject({ error: "model_unavailable" })
    expect(project.tldrRefreshCalls).toBe(0)
  })

  it("TLDR 刷新成功后返回生成的 TLDR", async () => {
    const project = new FakeDashboardProject()
    project.tldrValue = {
      challengeId: "pwn-1",
      updatedAt: "2026-07-29T13:00:00.000Z",
      content: "# TLDR\n堆溢出利用题\n检查 glibc 版本",
      model: "solver",
      sessionPath: "/sessions/tldr.jsonl",
      error: null,
      inputTokens: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    }
    project.tldrGenerationError = undefined
    const modelConfiguration = new FakeModelConfiguration()
    modelConfiguration.value = {
      models: [
        {
          id: "solver",
          provider: "test",
          modelId: "solver-model",
          baseUrl: "https://test",
          contextWindow: 64_000,
          thinkingEnabled: true,
          reasoningEffort: "high",
          passthroughThinking: false,
          apiKeyConfigured: true,
          apiKeySource: "secret-store",
          configured: true,
          unavailableReason: undefined,
          supportedThinkingLevels: ["low", "medium", "high", "max"],
        },
      ],
      solverModelId: "solver",
      tldrModelId: "solver",
      subagentModels: {},
      supportedThinkingLevels: ["low", "medium", "high", "max"],
      configured: true,
      unavailableReason: undefined,
    }
    modelConfiguration.agentOptionsValue = {
      model: "solver-model",
      systemPrompt: "TLDR agent",
    } as unknown as AgentOptions
    const { app } = createWebUiApp({
      project,
      modelConfiguration,
      frontendDist: "/nonexistent",
    })

    const refresh = await jsonRequest(
      app,
      "/api/challenges/pwn-1/tldr/refresh",
      "POST",
      {},
    )
    expect(refresh.status).toBe(200)
    expect(await jsonOf(refresh)).toMatchObject({
      tldr: {
        challengeId: "pwn-1",
        content: expect.stringContaining("堆溢出利用题"),
      },
    })
    expect(project.tldrRefreshCalls).toBe(1)
    expect(project.tldrAgentOptions).toMatchObject({ model: "solver-model" })
  })

  it("运行中切换思考强度（200/400/409 契约）", async () => {
    const { app, project } = appWithProject()

    const ok = await jsonRequest(
      app,
      "/api/challenges/pwn-1/thinking-level",
      "POST",
      {
        level: "max",
      },
    )
    expect(ok.status).toBe(200)
    expect(project.thinkingLevelCalls).toEqual([
      { challengeId: "pwn-1", level: "max" },
    ])

    const invalid = await jsonRequest(
      app,
      "/api/challenges/pwn-1/thinking-level",
      "POST",
      {
        level: "ultra",
      },
    )
    expect(invalid.status).toBe(400)
    expect(await jsonOf(invalid)).toMatchObject({ error: "invalid_level" })

    project.thinkingLevelResult = { error: "no_active_run" }
    const noRun = await jsonRequest(
      app,
      "/api/challenges/pwn-1/thinking-level",
      "POST",
      {
        level: "low",
      },
    )
    expect(noRun.status).toBe(409)
    expect(await jsonOf(noRun)).toMatchObject({ error: "no_active_run" })
  })

  it("向运行中的 Agent 发送人工消息（200/400/409 契约）", async () => {
    const { app, project } = appWithProject()

    const delivered = await jsonRequest(
      app,
      "/api/challenges/pwn-1/message",
      "POST",
      {
        text: "先检查文件头",
      },
    )
    expect(delivered.status).toBe(200)
    expect(await jsonOf(delivered)).toEqual({ runId: "run-pwn-1" })
    expect(project.sendMessageCalls).toEqual([
      { challengeId: "pwn-1", text: "先检查文件头" },
    ])

    expect(
      (
        await jsonRequest(app, "/api/challenges/pwn-1/message", "POST", {
          text: "   ",
        })
      ).status,
    ).toBe(400)
    expect(
      (await jsonRequest(app, "/api/challenges/pwn-1/message", "POST", {}))
        .status,
    ).toBe(400)

    project.sendMessageResult = { error: "no_active_run" }
    const noActive = await jsonRequest(
      app,
      "/api/challenges/pwn-1/message",
      "POST",
      {
        text: "继续",
      },
    )
    expect(noActive.status).toBe(409)

    // project 抛 invalid_message 时保留其原始文案
    project.sendMessageResult = { error: "invalid_message" }
    const invalidMessage = await jsonRequest(
      app,
      "/api/challenges/pwn-1/message",
      "POST",
      {
        text: "x",
      },
    )
    expect(invalidMessage.status).toBe(400)
    expect(await jsonOf(invalidMessage)).toMatchObject({
      error: "invalid_message",
      message: "消息内容不合法(测试)",
    })

    // message 路由不要求 scheduler（dispatch 才要求）
    expect(
      (await jsonRequest(app, "/api/challenges/pwn-1/dispatch", "POST", {}))
        .status,
    ).toBe(503)
  })

  it("writeup 下载：内容可用时返回 markdown 附件", async () => {
    const project = new FakeDashboardProject()
    project.writeupValue = {
      validation: {
        valid: true,
        path: "/workspace/pwn-1/writeup.md",
        errors: [],
        size: 42,
      },
      content: "# pwn-1 writeup\n\nheap exploit",
    }
    const { app } = createWebUiApp({ project, frontendDist: "/nonexistent" })

    const response = await app.request("/api/challenges/pwn-1/writeup")
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/markdown")
    expect(response.headers.get("content-disposition")).toContain(
      'filename="writeup-pwn-1.md"',
    )
    expect(await response.text()).toContain("# pwn-1 writeup")
  })

  it("writeup 不可用时返回 409 与校验详情", async () => {
    const project = new FakeDashboardProject()
    project.writeupValue = {
      validation: {
        valid: false,
        path: "/workspace/pwn-1/writeup.md",
        errors: ["no_solution_yet"],
        size: 0,
      },
      content: null,
    }
    const { app } = createWebUiApp({ project, frontendDist: "/nonexistent" })

    const response = await app.request("/api/challenges/pwn-1/writeup")
    expect(response.status).toBe(409)
    expect(await jsonOf(response)).toMatchObject({
      error: "writeup_unavailable",
      validation: { valid: false, errors: ["no_solution_yet"] },
    })
  })
})
