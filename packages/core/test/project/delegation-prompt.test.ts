import { describe, expect, it } from "vitest"
import { subagentDelegationPrompt } from "../../prompts/project.ts"

describe("subagent delegation placeholder", () => {
  it("约束派发时机并固定子任务 XML 结构", () => {
    const prompt = subagentDelegationPrompt([
      { name: "pwn", description: "binary exploitation" },
    ])

    expect(prompt).toContain(
      '<subagent_delegation_policy version="placeholder-v1">',
    )
    expect(prompt).toContain("bounded, independent investigation")
    expect(prompt).toContain("Do not delegate the whole challenge")
    expect(prompt).toContain("<subagent_task>")
    expect(prompt).toContain("<objective>one specific outcome</objective>")
    expect(prompt).toContain("<context>")
    expect(prompt).toContain("<deliverables>")
    expect(prompt).toContain("<constraints>")
    expect(prompt).toContain("pwn (binary exploitation)")
  })
})
