import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ChallengeInfo } from "@ctf-agent/platform"
import type { CommandResult, Sandbox } from "@ctf-agent/sandbox"
import type { AgentOptions, AgentTool } from "@earendil-works/pi-agent-core"
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux"
import { Type } from "typebox"
import { afterEach, describe, expect, it } from "vite-plus/test"
import { CtfSubagent } from "../../src/subagent/subagent-agent.ts"
import type { SubagentRole } from "../../src/subagent/registry.ts"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const challenge: ChallengeInfo = {
  id: "challenge",
  title: "Offline test",
  category: "misc",
  score: 100,
  description: "Test the delegated investigation",
  attachments: [],
}

const sandbox: Sandbox = {
  id: "test-sandbox",
  async exec(): Promise<CommandResult> {
    return { code: 0, stdout: "", stderr: "" }
  },
  async close() {},
}

describe("CtfSubagent compaction and recovery", () => {
  it("reconciles restored active tools with the current role and persists the allowed reader", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctf-subagent-permissions-"))
    roots.push(root)
    const faux = createFauxCore({ provider: "subagent-permissions" })
    const tool = (name: string): AgentTool => ({
      name,
      label: name,
      description: name,
      parameters: Type.Object({}),
      async execute() {
        return { content: [{ type: "text", text: name }], details: {} }
      },
    })
    const probe = tool("test_probe")
    const old = tool("old_tool")
    const reader = tool("blackboard_read")
    const role: SubagentRole = {
      name: "analyst",
      displayName: "Analyst",
      description: "Investigate a bounded task",
      systemPrompt: "Investigate.",
      tools: ["test_probe", "old_tool"],
      thinkingLevel: "off",
      enabled: true,
      source: "project",
    }
    const options = {
      projectId: "project",
      runId: "run",
      runDirectory: root,
      subagentId: "worker",
      containerCwd: "/workspace/worker",
      challenge,
      sandbox,
      role,
      webAccessTools: [probe, old],
      agent: {
        streamFn: faux.streamSimple as AgentOptions["streamFn"],
        initialState: { model: faux.getModel(), thinkingLevel: "off" },
      },
    } satisfies Parameters<typeof CtfSubagent.create>[0]

    const original = await CtfSubagent.create(options)
    await original.close()
    const restored = await CtfSubagent.create({
      ...options,
      role: { ...role, tools: ["test_probe", "blackboard_read"] },
      blackboardReadTool: reader,
    })
    expect(restored.restored).toBe(true)
    expect(restored.activeTools.map((entry) => entry.name).sort()).toEqual([
      "blackboard_read",
      "test_probe",
    ])
    expect((await restored.session.buildContext()).activeToolNames?.sort()).toEqual([
      "blackboard_read",
      "test_probe",
    ])
    await restored.close()

    const restricted = await CtfSubagent.create({
      ...options,
      role: { ...role, tools: ["test_probe"] },
      blackboardReadTool: reader,
    })
    expect(restricted.activeTools.map((entry) => entry.name)).toEqual(["test_probe"])
    expect((await restricted.session.buildContext()).activeToolNames).toEqual(["test_probe"])
    await restricted.close()
  })

  it.each([false, true])(
    "keeps the delegated facts and permitted tools through a real Pi compaction (reader: %s)",
    async (withReader) => {
      const root = await mkdtemp(join(tmpdir(), "ctf-subagent-compaction-"))
      roots.push(root)
      const faux = createFauxCore({
        provider: `subagent-compact-${withReader ? "reader" : "no-reader"}`,
        models: [{ id: "offline", contextWindow: 1_000_000, maxTokens: 4_096 }],
      })
      let summarizationRequest = ""
      let continuationRequest = ""
      let probeCalls = 0
      let readerCalls = 0
      const summary =
        "Goal: verify offset 72. Observed: version 2 uses the test input. Conditions: local fixture only. File: /workspace/probe.py. Next: reproduce."
      faux.setResponses([
        fauxAssistantMessage("Observed offset 72 under the local fixture."),
        fauxAssistantMessage("The next step is to reproduce the observation."),
        (context) => {
          summarizationRequest = JSON.stringify(context.messages)
          return fauxAssistantMessage(summary)
        },
        (context) => {
          continuationRequest = JSON.stringify(context.messages)
          return fauxAssistantMessage(
            fauxToolCall(withReader ? "blackboard_read" : "test_probe", {}, { id: "probe" }),
            { stopReason: "toolUse" },
          )
        },
        fauxAssistantMessage("Investigation continued."),
      ])

      const probe: AgentTool = {
        name: "test_probe",
        label: "Test probe",
        description: "A deterministic tool available to the role",
        parameters: Type.Object({}),
        async execute() {
          probeCalls++
          return { content: [{ type: "text", text: "probe complete" }], details: {} }
        },
      }
      const reader: AgentTool = {
        name: "blackboard_read",
        label: "Test reader",
        description: "An optional reader supplied by the host",
        parameters: Type.Object({}),
        async execute() {
          readerCalls++
          return { content: [{ type: "text", text: "recorded evidence" }], details: {} }
        },
      }
      const role: SubagentRole = {
        name: "analyst",
        displayName: "Analyst",
        description: "Investigate a bounded task",
        systemPrompt: "Investigate the delegated task.",
        tools: withReader ? ["test_probe", "blackboard_read"] : ["test_probe"],
        thinkingLevel: "off",
        enabled: true,
        source: "project",
      }
      const options = {
        projectId: "project",
        runId: "run",
        runDirectory: root,
        subagentId: "worker",
        containerCwd: "/workspace/worker",
        challenge,
        sandbox,
        role,
        webAccessTools: withReader ? [probe, reader] : [probe],
        agent: {
          streamFn: faux.streamSimple as AgentOptions["streamFn"],
          initialState: { model: faux.getModel(), thinkingLevel: "off" },
        },
      } satisfies Parameters<typeof CtfSubagent.create>[0]

      const worker = await CtfSubagent.create(options)
      await worker.prompt("Verify offset 72 in the local fixture. OLD_CONTEXT_SENTINEL")
      await worker.prompt(`Continue investigation. ${"x".repeat(100_000)}`)
      await expect(worker.compact()).resolves.toMatchObject({ summary })

      expect(summarizationRequest).toMatch(/delegated (objective|task)/iu)
      expect(summarizationRequest).toMatch(/do not assume.*(snapshot|blackboard)/iu)
      expect(summarizationRequest).toMatch(/experimental inputs and environment conditions/iu)
      expect(summarizationRequest).toMatch(/evidence IDs and content hashes/iu)
      expect(summarizationRequest).toMatch(/evidence IDs alone are insufficient/iu)
      expect(summarizationRequest).toMatch(/unverified interpretations into confirmed facts/iu)
      expect(summarizationRequest).toContain("OLD_CONTEXT_SENTINEL")
      expect(summarizationRequest).not.toContain(
        "The control plane prepends fresh authoritative sections",
      )
      expect(JSON.stringify(await worker.getMessages())).toContain(summary)
      expect(JSON.stringify(await worker.getMessages())).not.toContain("OLD_CONTEXT_SENTINEL")
      expect((await worker.session.getEntries()).some((entry) => entry.type === "compaction")).toBe(
        true,
      )
      await worker.close()

      const restored = await CtfSubagent.create(options)
      expect(restored.restored).toBe(true)
      expect(restored.activeTools.map((tool) => tool.name).sort()).toEqual(
        (withReader ? ["blackboard_read", "test_probe"] : ["test_probe"]).sort(),
      )
      await restored.prompt("Continue from the retained facts.")
      expect(continuationRequest).toContain(summary)
      expect(probeCalls).toBe(withReader ? 0 : 1)
      expect(readerCalls).toBe(withReader ? 1 : 0)
      await restored.close()
    },
    30_000,
  )
})
