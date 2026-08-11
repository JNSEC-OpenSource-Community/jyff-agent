import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vite-plus/test"
import {
  validateChallengeWriteup,
  WRITEUP_MAX_BYTES,
  WRITEUP_REQUIRED_HEADINGS,
} from "../../src/orchestration/writeup-validator.ts"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
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

  it("reports a missing writeup file", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "writeup-invalid-"))
    roots.push(workspace)

    await expect(validateChallengeWriteup(workspace)).resolves.toMatchObject({
      valid: false,
      errors: ["writeup.md does not exist"],
      size: 0,
    })
  })

  it("reports every missing heading with the feedback delimiters sent to the Solver", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "writeup-headings-"))
    roots.push(workspace)

    await writeFile(join(workspace, "writeup.md"), "# Challenge\n\n## Summary\nshort")
    await expect(validateChallengeWriteup(workspace)).resolves.toMatchObject({
      valid: false,
      errors: WRITEUP_REQUIRED_HEADINGS.slice(1).map(
        (heading) => `Missing required heading: ## ${heading}\n`,
      ),
    })
  })

  it.each([
    {
      label: "空文件",
      content: Buffer.alloc(0),
      error: "writeup.md is empty",
    },
    {
      label: "无效 UTF-8",
      content: Buffer.from([0xc3, 0x28]),
      error: "writeup.md must be valid UTF-8",
    },
    {
      label: "超出大小上限",
      content: Buffer.alloc(WRITEUP_MAX_BYTES + 1, "a"),
      error: `writeup.md exceeds ${WRITEUP_MAX_BYTES} bytes`,
    },
  ])("rejects $label", async ({ content, error }) => {
    const workspace = await mkdtemp(join(tmpdir(), "writeup-malformed-"))
    roots.push(workspace)
    await writeFile(join(workspace, "writeup.md"), content)

    await expect(validateChallengeWriteup(workspace)).resolves.toMatchObject({
      valid: false,
      errors: expect.arrayContaining([error]),
      size: content.length,
    })
  })
})
