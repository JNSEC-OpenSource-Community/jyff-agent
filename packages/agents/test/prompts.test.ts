import { describe, expect, it } from "vitest"
import {
  BLOCKED_FINALIZATION_PROMPT,
  BUILTIN_SUBAGENT_ROLE_PROMPTS,
  CTF_COMPACTION_PROMPT,
  DEFAULT_PROMPT_BUNDLE,
  INCOMPLETE_CONTINUATION_PROMPT,
  SOLVER_SYSTEM_PROMPT,
  SUBAGENT_SHARED_SYSTEM_PROMPT,
  subagentTaskContextPrompt,
  WRITEUP_PROMPT,
} from "../prompts/index.ts"

const HAN = /\p{Script=Han}/u

describe("fixed CTF prompts", () => {
  it("keeps built-in model-facing prompts in English", () => {
    const fixedPrompts = [
      SOLVER_SYSTEM_PROMPT,
      CTF_COMPACTION_PROMPT,
      INCOMPLETE_CONTINUATION_PROMPT,
      BLOCKED_FINALIZATION_PROMPT,
      WRITEUP_PROMPT,
      SUBAGENT_SHARED_SYSTEM_PROMPT,
      ...Object.values(BUILTIN_SUBAGENT_ROLE_PROMPTS),
    ]

    for (const prompt of fixedPrompts) expect(prompt).not.toMatch(HAN)
    expect(SOLVER_SYSTEM_PROMPT).toContain("Use English for reasoning")
    expect(SUBAGENT_SHARED_SYSTEM_PROMPT).toContain("Use English for reasoning")
    expect(CTF_COMPACTION_PROMPT).toContain("active SubAgent tasks")
    expect(DEFAULT_PROMPT_BUNDLE.version).toMatch(/^ctf-/)
  })

  it("escapes dynamic challenge fields without translating them", () => {
    const prompt = subagentTaskContextPrompt({
      title: "中文题目 <demo>",
      id: "id&1",
      category: "Web",
      score: 100,
      containerCwd: "/workspace/subagents/a",
    })

    expect(prompt).toContain("中文题目 &lt;demo&gt;")
    expect(prompt).toContain("id&amp;1")
    expect(prompt).not.toContain("<demo>")
  })
})
