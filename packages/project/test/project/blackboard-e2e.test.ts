import { readFileSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterAll, describe, expect, it } from "vitest"
import type { AgentOptions } from "@earendil-works/pi-agent-core"
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions"
import { mockPlatform } from "../../../platform-mock/src/index.js"
import { Project } from "../../src/project.js"

const cleanupRoots: string[] = []
afterAll(async () => {
  await Promise.all(cleanupRoots.splice(0).map((r) => rm(r, { recursive: true, force: true })))
})

function loadEnv(): { apiKey: string; model: string; provider: string; baseUrl?: string } {
  const map = new Map<string, string>()
  try {
    const content = readFileSync(join(import.meta.dirname, "../../../../.env"), "utf-8")
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("#")) continue
      const m = /^([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*"?([^"#]*?)"?\s*(?:#.*)?$/.exec(trimmed)
      if (m) map.set(m[1]!, m[2]!)
    }
  } catch {}
  const get = (key: string, fallback?: string) =>
    process.env[key] ?? map.get(key) ?? fallback ?? ""
  const apiKey = get("CTF_MODEL_API_KEY") || get("OPENROUTER_API_KEY")
  const model = get("CTF_MODEL_ID") || get("OPENROUTER_MODEL")
  const provider = get("CTF_MODEL_PROVIDER", "openrouter")
  const rawBaseUrl = get("CTF_MODEL_BASE_URL")
  return { apiKey, model, provider, baseUrl: rawBaseUrl || undefined }
}

const e2eEnv = loadEnv()
const runModelE2E = process.env.CTF_RUN_MODEL_E2E === "1"

class FakeSandbox {
  readonly id = "fake"
  closed = false
  async exec() { return { code: 0, stdout: "", stderr: "" } }
  async close() { this.closed = true }
}

async function setupProject(): Promise<{ project: Project; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "ctf-e2e-bb-"))
  cleanupRoots.push(root)
  await mkdir(join(root, ".pi"), { recursive: true })
  await writeFile(join(root, ".pi", "ctf-config.json"), JSON.stringify({
    version: 1,
    project: { id: "e2e-bb", name: "E2E BB" },
    platform: { plugin: "mock", config: {} },
    sandbox: { image: "unused", privileged: false, networkMode: "none" },
  }))
  return {
    project: await Project.open({
      root,
      platforms: [mockPlatform],
      sandboxFactory: async () => new FakeSandbox() as any,
    }),
    root,
  }
}

describe("E2E: Blackboard with real model", () => {
  it.skipIf(!runModelE2E || !e2eEnv.apiKey || !e2eEnv.model)(
    "Agent can call ctf_blackboard_read and ctf_blackboard_record",
    { timeout: 120_000 },
    async () => {
    const env = e2eEnv
    const { project } = await setupProject()
    const solver = await project.createSolver("warmup-flag", {
      agent: {
        streamFn: streamSimple as AgentOptions["streamFn"],
        getApiKey: () => env.apiKey,
        initialState: {
          model: {
            id: env.model,
            name: env.model,
            api: "openai-completions" as const,
            provider: env.provider,
            baseUrl: env.baseUrl ?? "https://api.openai.com/v1",
            reasoning: false,
            input: ["text"] as const,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 64_000,
            maxTokens: 4_096,
            compat: {
              supportsStore: false,
              supportsDeveloperRole: false,
              supportsReasoningEffort: false,
              supportsUsageInStreaming: false,
              supportsStrictMode: false,
              supportsLongCacheRetention: false,
              maxTokensField: "max_tokens",
            },
          },
          thinkingLevel: "off" as const,
          systemPrompt: [
            "You have access to blackboard tools.",
            "Step 1: Call ctf_blackboard_read to see the current state.",
            "Step 2: Call ctf_blackboard_record with evidence { description: 'Test evidence from e2e' }.",
            "Step 3: Call ctf_blackboard_read again.",
            "Output TEST_COMPLETE when finished.",
          ].join("\n"),
        },
      },
      compaction: false,
    })

    try {
      await solver.prompt("Complete steps 1-3 from your system prompt.")
      await solver.waitForIdle()

      const debug = solver.state.messages.map((m) => {
        if (m.role === "assistant") {
          const tools = m.content.filter((c) => c.type === "toolCall").map((c) => (c as { name: string }).name)
          const texts = m.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text)
          return `[A] tools=[${tools}] text="${texts.join(" ").slice(0, 300)}"`
        }
        if (m.role === "toolResult") return `[T ${(m as { toolName: string }).toolName}]`
        return `[${m.role}]`
      }).join("\n")

      const toolCalls = solver.state.messages
        .flatMap((m) => m.role === "assistant" ? m.content : [])
        .filter((c) => c.type === "toolCall")
        .map((c) => (c as { name: string }).name)

      if (toolCalls.length === 0) {
        throw new Error(`No tool calls made. Debug:\n${debug}`)
      }

      expect(toolCalls).toContain("ctf_blackboard_read")
      expect(toolCalls).toContain("ctf_blackboard_record")
      expect(toolCalls.filter((name) => name === "ctf_blackboard_read").length).toBeGreaterThanOrEqual(2)
      expect(project.blackboard("warmup-flag").evidence).toEqual(expect.arrayContaining([
        expect.objectContaining({ description: "Test evidence from e2e" }),
      ]))
      const finalText = solver.state.messages
        .flatMap((message) => message.role === "assistant" ? message.content : [])
        .filter((content) => content.type === "text")
        .map((content) => (content as { text: string }).text)
        .join("\n")
      expect(finalText).toContain("TEST_COMPLETE")
    } finally {
      await solver.close().catch(() => {})
      await project.close().catch(() => {})
    }
  })
})
