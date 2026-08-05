import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ChallengeInfo } from "@ctf-agent/platform"
import type { CommandResult, Sandbox } from "@ctf-agent/sandbox"
import type { AgentOptions } from "@earendil-works/pi-agent-core"
import type { Model } from "@earendil-works/pi-ai"
import { afterEach, describe, expect, it } from "vitest"
import { CtfTldrAgent } from "../src/tldr-agent.ts"

const model: Model<"openai-completions"> = {
  id: "tldr-model",
  name: "TLDR model",
  api: "openai-completions",
  provider: "test",
  baseUrl: "https://invalid.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 64_000,
  maxTokens: 4_096,
}

const agent: AgentOptions = {
  streamFn: (() => {
    throw new Error("model must not be called in this test")
  }) as AgentOptions["streamFn"],
  initialState: { model },
}

const challenge: ChallengeInfo = {
  id: "web-1",
  title: "Cookie Jar",
  category: "web",
  score: 100,
  description: "Inspect the cookie.",
  attachments: [],
}

class FakeSandbox implements Sandbox {
  readonly id = "tldr-sandbox"
  async exec(): Promise<CommandResult> {
    return { code: 0, stdout: "", stderr: "" }
  }
  async close(): Promise<void> {}
}

const roots: string[] = []
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  )
})

describe("CtfTldrAgent", () => {
  it("uses a stable JSONL session and read-only tools", async () => {
    const root = await mkdtemp(join(tmpdir(), "tldr-agent-"))
    roots.push(root)
    const sessionPath = join(root, "tldr", "session.jsonl")
    const tldr = await CtfTldrAgent.create({
      projectId: "project",
      challenge,
      sessionPath,
      agent,
      sandbox: new FakeSandbox(),
    })
    expect(tldr.sessionPath).toBe(sessionPath)
    expect(tldr.activeTools.map((tool) => tool.name).sort()).toEqual([
      "list",
      "read",
    ])
    await tldr.close()
  })
})
