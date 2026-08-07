import { describe, expect, it } from "vitest"
import { SUBAGENT_SHARED_SYSTEM_PROMPT } from "../src/subagent.ts"

describe("SUBAGENT_SHARED_SYSTEM_PROMPT", () => {
  it("禁止以计划或切换思路的陈述提前结束", () => {
    expect(SUBAGENT_SHARED_SYSTEM_PROMPT).toContain(
      "Do not stop with a plan, an intention to try another approach, or a progress-only reply.",
    )
    expect(SUBAGENT_SHARED_SYSTEM_PROMPT).toContain(
      "Keep using tools and performing the investigation before responding.",
    )
  })

  it("只允许在可复现结果、穷尽证据或明确要求阶段汇报时返回", () => {
    expect(SUBAGENT_SHARED_SYSTEM_PROMPT).toContain("a reproducible result")
    expect(SUBAGENT_SHARED_SYSTEM_PROMPT).toContain(
      "exhausted the bounded approaches with concrete negative evidence",
    )
    expect(SUBAGENT_SHARED_SYSTEM_PROMPT).toContain(
      "explicitly asks for an interim report",
    )
  })
})
