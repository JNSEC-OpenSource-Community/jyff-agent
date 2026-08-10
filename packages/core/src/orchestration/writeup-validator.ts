import { readFile } from "node:fs/promises"
import { join } from "node:path"

export const WRITEUP_REQUIRED_HEADINGS = [
  "Summary",
  "Analysis",
  "Vulnerability or Weakness",
  "Solution / Exploitation",
  "Reproduction",
  "Relevant Artifacts",
  "Flag",
] as const

export const WRITEUP_MAX_BYTES = 1_000_000

export interface WriteupValidationResult {
  valid: boolean
  path: string
  errors: string[]
  size: number
}

export async function validateChallengeWriteup(
  workspace: string,
): Promise<WriteupValidationResult> {
  const path = join(workspace, "writeup.md")
  let bytes: Buffer
  try {
    bytes = await readFile(path)
  } catch (error) {
    return {
      valid: false,
      path,
      errors: [
        error instanceof Error && "code" in error && error.code === "ENOENT"
          ? "writeup.md does not exist"
          : `Unable to read writeup.md: ${error instanceof Error ? error.message : String(error)}`,
      ],
      size: 0,
    }
  }
  const errors: string[] = []
  if (bytes.length === 0) errors.push("writeup.md is empty")
  if (bytes.length > WRITEUP_MAX_BYTES) {
    errors.push(`writeup.md exceeds ${WRITEUP_MAX_BYTES} bytes`)
  }
  const text = bytes.toString("utf8")
  if (Buffer.from(text, "utf8").compare(bytes) !== 0) {
    errors.push("writeup.md must be valid UTF-8")
  }
  if (!/^#\s+\S.+$/m.test(text)) {
    errors.push("writeup.md must start with a challenge title heading")
  }
  for (const heading of WRITEUP_REQUIRED_HEADINGS) {
    const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    if (!new RegExp(`^##\\s+${escaped}\\s*$`, "im").test(text)) {
      errors.push(`Missing required heading: ## ${heading}\n`)
    }
  }
  return { valid: errors.length === 0, path, errors, size: bytes.length }
}
