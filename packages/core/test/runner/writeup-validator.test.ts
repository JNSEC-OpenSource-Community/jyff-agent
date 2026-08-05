import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  validateChallengeWriteup,
  WRITEUP_REQUIRED_HEADINGS,
} from "../../src/orchestration/writeup-validator.ts"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe("writeup validator", () => {
  it("accepts the required reproducible writeup structure", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "writeup-valid-"))
    roots.push(workspace)
    const document = [
      "# Challenge",
      ...WRITEUP_REQUIRED_HEADINGS.flatMap((heading) => [
        "",
        `## ${heading}`,
        "Reproducible details.",
      ]),
    ].join("\n")
    await writeFile(join(workspace, "writeup.md"), document)

    await expect(validateChallengeWriteup(workspace)).resolves.toMatchObject({
      valid: true,
      errors: [],
    })
  })

  it("reports a missing file and every missing required heading", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "writeup-invalid-"))
    roots.push(workspace)
    expect((await validateChallengeWriteup(workspace)).errors).toContain(
      "writeup.md does not exist",
    )

    await mkdir(workspace, { recursive: true })
    await writeFile(
      join(workspace, "writeup.md"),
      "# Challenge\n\n## Summary\nshort",
    )
    const invalid = await validateChallengeWriteup(workspace)
    expect(invalid.valid).toBe(false)
    expect(invalid.errors).toContain("Missing required heading: ## Flag")
  })
})
