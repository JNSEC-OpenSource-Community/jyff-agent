import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  assertWorkspaceArtifactContained,
  challengeWorkspacePath,
  listWorkspaceArtifacts,
  readWorkspaceArtifact,
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

  it("递归列出普通文件并在上限处截断", async () => {
    const root = await mkdtemp(join(tmpdir(), "challenge-workspace-list-"))
    roots.push(root)
    const workspace = join(root, "workspace")
    await mkdir(join(workspace, "nested"), { recursive: true })
    await writeFile(join(workspace, "a.txt"), "a")
    await writeFile(join(workspace, "nested", "b.bin"), "binary")

    const listing = await listWorkspaceArtifacts(workspace)
    expect(listing).toMatchObject({
      truncated: false,
      files: [
        { path: "a.txt", size: 1 },
        { path: "nested/b.bin", size: 6 },
      ],
    })
    expect(await listWorkspaceArtifacts(workspace, 1)).toMatchObject({
      truncated: true,
      files: [{ path: "a.txt" }],
    })
  })

  it("读取文件时拒绝通过父目录 symlink 逃逸", async () => {
    const root = await mkdtemp(join(tmpdir(), "challenge-workspace-read-"))
    roots.push(root)
    const workspace = join(root, "workspace")
    const outside = join(root, "outside")
    await mkdir(workspace)
    await mkdir(outside)
    await writeFile(join(outside, "secret.txt"), "secret")
    await symlink(
      outside,
      join(workspace, "escape"),
      process.platform === "win32" ? "junction" : "dir",
    )

    await expect(
      readWorkspaceArtifact(workspace, "escape/secret.txt"),
    ).rejects.toThrow("escapes")
  })
})
