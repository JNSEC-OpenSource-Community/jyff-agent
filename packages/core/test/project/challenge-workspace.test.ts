import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  assertWorkspaceArtifactContained,
  challengeWorkspacePath,
  resolveWorkspaceArtifact,
} from "../../src/project/challenge-workspace.ts"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe("challenge workspace", () => {
  it("maps an challenge ID to a stable bounded path", async () => {
    const root = await mkdtemp(join(tmpdir(), "challenge-workspace-"))
    roots.push(root)
    const first = challengeWorkspacePath(root, "../../题目/one")
    const second = challengeWorkspacePath(root, "../../题目/one")

    expect(first).toBe(second)
    expect(first.startsWith(root)).toBe(true)
    expect(first).not.toContain("题目")
  })

  it("rejects traversal, absolute paths, and escaping symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "challenge-workspace-safe-"))
    roots.push(root)
    const workspace = join(root, "workspace")
    await mkdir(workspace)
    await writeFile(join(root, "secret.txt"), "secret")

    expect(() => resolveWorkspaceArtifact(workspace, "../secret.txt")).toThrow(
      "escapes",
    )
    expect(() =>
      resolveWorkspaceArtifact(workspace, join(root, "secret.txt")),
    ).toThrow("relative path")
    const link = join(workspace, "escape")
    await symlink(join(root, "secret.txt"), link)
    await expect(
      assertWorkspaceArtifactContained(workspace, link),
    ).rejects.toThrow("symlink escapes")
  })
})
