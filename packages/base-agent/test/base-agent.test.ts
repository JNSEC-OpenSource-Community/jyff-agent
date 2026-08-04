import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentOptions, AgentTool, ThinkingLevel } from "@earendil-works/pi-agent-core"
import type { Model } from "@earendil-works/pi-ai"
import { Type } from "typebox"
import { afterEach, describe, expect, it } from "vitest"
import { BaseAgent, modelsFromAgentOptions, prepareBaseAgent, type BaseAgentOptions } from "../src/index.ts"

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

const model: Model<"openai-completions"> = {
  id: "test-model",
  name: "Test Model",
  api: "openai-completions",
  provider: "test-provider",
  baseUrl: "https://invalid.test",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 64_000,
  maxTokens: 4_096,
}

const legacy = {
  streamFn: (() => { throw new Error("model is not called by this test") }) as AgentOptions["streamFn"],
} satisfies AgentOptions

const noopTool: AgentTool = {
  name: "noop",
  label: "No-op",
  description: "No-op test tool",
  parameters: Type.Object({}),
  async execute() { return { content: [{ type: "text", text: "ok" }], details: {} } },
}

class TestAgent extends BaseAgent {
  static async open(options: BaseAgentOptions) {
    return new TestAgent(await prepareBaseAgent(options), { compaction: options.compaction })
  }
}

describe("BaseAgent native session", () => {
  it("restores transcript, model, thinking level, active tools, and tree entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "base-agent-session-"))
    roots.push(root)
    const session = { path: join(root, "session.jsonl"), id: "run-1", cwd: root }
    const models = modelsFromAgentOptions(legacy, model)
    const common = { session, models, model, tools: [noopTool], compaction: false }

    const first = await TestAgent.open({
      ...common,
      thinkingLevel: "low",
      initialMessages: [{ role: "user", content: "persist me", timestamp: 1 }],
    })
    await first.appendMessage({ role: "user", content: "second message", timestamp: 2 })
    await first.setThinkingLevel("high")
    await first.setActiveTools([])
    await first.session.appendCompaction("summary", undefined, 123)

    const restored = await TestAgent.open({ ...common, thinkingLevel: "off" })
    expect(restored.restored).toBe(true)
    expect(restored.thinkingLevel).toBe("high" satisfies ThinkingLevel)
    expect(restored.model.id).toBe(model.id)
    expect(restored.tools.map((tool) => tool.name)).toEqual(["noop"])
    expect(restored.activeTools).toEqual([])
    const entries = await restored.session.getEntries()
    expect(entries.some((entry) =>
      entry.type === "message" && entry.message.role === "user" && entry.message.content === "second message",
    )).toBe(true)
    expect(entries.some((entry) => entry.type === "compaction")).toBe(true)
  })

  it("does not attempt impossible default compaction for a small-context model", async () => {
    const root = await mkdtemp(join(tmpdir(), "base-agent-small-context-"))
    roots.push(root)
    const smallModel = { ...model, id: "small", contextWindow: 1_024 }
    const agent = await TestAgent.open({
      session: { path: join(root, "session.jsonl"), id: "small-run", cwd: root },
      models: modelsFromAgentOptions(legacy, smallModel),
      model: smallModel,
      initialMessages: [{ role: "user", content: "short history", timestamp: 1 }],
    })

    const response = await agent.prompt("continue")
    expect(response.stopReason).toBe("error")
    expect(response.errorMessage).toBe("model is not called by this test")
  })
})
