import { describe, expect, it } from "vitest"
import { challengeContextPrompt } from "../src/project.ts"

describe("challengeContextPrompt", () => {
  it.each([
    [true, "true"],
    [false, "false"],
    [undefined, "unknown"],
  ] as const)("将 needsEnv=%s 序列化为 %s", (needsEnv, expected) => {
    const prompt = challengeContextPrompt(
      {
        id: "pwn-1",
        title: "Pwn",
        category: "pwn",
        description: "description",
        score: 100,
        attachments: [],
        ...(needsEnv === undefined ? {} : { needsEnv }),
      },
      [],
    )

    expect(prompt).toContain(
      `<needs_environment>${expected}</needs_environment>`,
    )
  })
})
