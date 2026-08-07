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

  it.each([
    { label: "遍历攻击", artifact: "../secret.txt" },
    { label: "多层遍历攻击", artifact: "../../etc/passwd" },
    { label: "绝对路径", artifact: "/etc/passwd" },
    { label: "空路径", artifact: "" },
    { label: "Null 字节注入", artifact: "safe.txt\u0000../../../secret" },
  ])("拒绝 $label", async ({ artifact }) => {
    const root = await mkdtemp(join(tmpdir(), "challenge-workspace-safe-"))
    roots.push(root)
    const workspace = join(root, "workspace")
    await mkdir(workspace)

    expect(() => resolveWorkspaceArtifact(workspace, artifact)).toThrow()
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
    const outside = join(root, "outside")
    await mkdir(outside)
    const link = join(workspace, "escape")
    await symlink(
      outside,
      link,
      process.platform === "win32" ? "junction" : "dir",
    )
    await expect(
      assertWorkspaceArtifactContained(workspace, link),
    ).rejects.toThrow("symlink escapes")
  })
})
