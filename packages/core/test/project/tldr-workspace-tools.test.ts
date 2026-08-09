import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  createTldrWorkspaceTools,
  TLDR_WORKSPACE_READ_MAX_BYTES,
} from "../../src/project/tldr-workspace-tools.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tldr-workspace-tools-"))
  roots.push(root)
  const workspace = join(root, "workspace")
  await mkdir(join(workspace, "notes"), { recursive: true })
  await mkdir(join(workspace, "tldr"), { recursive: true })
  await writeFile(join(workspace, "notes", "progress.md"), "已确认偏移为 40")
  await writeFile(join(workspace, "tldr", "session.jsonl"), "private state")
  const tools = createTldrWorkspaceTools(workspace)
  const list = tools.find((tool) => tool.name === "list")
  const read = tools.find((tool) => tool.name === "read")
  if (!list || !read) throw new Error("TLDR workspace tools are incomplete")
  return { root, workspace, list, read }
}

describe("TLDR host workspace tools", () => {
  it("只列出题目普通文件且不暴露 TLDR session", async () => {
    const { list } = await fixture()

    const listed = await list.execute("list", {})

    expect(listed.details).toMatchObject({
      truncated: false,
      files: [{ path: "notes/progress.md", size: 21 }],
    })
  })

  it("读取 workspace 内的 UTF-8 文本", async () => {
    const { read } = await fixture()

    const result = await read.execute("read", { path: "notes/progress.md" })

    expect(result.details).toEqual({
      path: "notes/progress.md",
      size: 21,
      content: "已确认偏移为 40",
    })
  })

  it("拒绝路径逃逸、TLDR session、非 UTF-8 和超大文件", async () => {
    const { root, workspace, read } = await fixture()
    await writeFile(join(root, "secret.txt"), "host secret")
    await writeFile(join(workspace, "binary.bin"), Buffer.from([0xff, 0xfe]))
    await writeFile(
      join(workspace, "large.txt"),
      "x".repeat(TLDR_WORKSPACE_READ_MAX_BYTES + 1),
    )

    await expect(
      read.execute("traversal", { path: "../secret.txt" }),
    ).rejects.toThrow("escapes")
    await expect(
      read.execute("session", { path: "tldr/session.jsonl" }),
    ).rejects.toThrow("not readable")
    await expect(
      read.execute("binary", { path: "binary.bin" }),
    ).rejects.toThrow("valid UTF-8")
    await expect(read.execute("large", { path: "large.txt" })).rejects.toThrow(
      `exceeds ${TLDR_WORKSPACE_READ_MAX_BYTES} bytes`,
    )
  })

  it("拒绝读取指向 workspace 外部的 symlink", async () => {
    const { root, workspace, read } = await fixture()
    const outside = join(root, "outside")
    await mkdir(outside)
    await writeFile(join(outside, "secret.txt"), "host secret")
    await symlink(
      outside,
      join(workspace, "escape"),
      process.platform === "win32" ? "junction" : "dir",
    )

    await expect(
      read.execute("symlink", { path: "escape/secret.txt" }),
    ).rejects.toThrow("symlink escapes")
  })
})
