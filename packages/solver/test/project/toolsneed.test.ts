import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { ToolsNeedRegistry } from "../../src/project/toolsneed.js"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function registry(): Promise<{ path: string; instance: ToolsNeedRegistry }> {
  const root = await mkdtemp(join(tmpdir(), "toolsneed-"))
  roots.push(root)
  const path = join(root, "toolsneed.json")
  return { path, instance: await ToolsNeedRegistry.open(path) }
}

const context = (challengeId: string, title: string, category: string) =>
  ({ challengeId, title, category })

describe("ToolsNeedRegistry(确定性接收 agent)", () => {
  it("首次上报新建条目,字段完整、reportCount=1", async () => {
    const { instance, path } = await registry()
    const status = instance.record(
      { tool: "sqlmap", reason: "需要 SQL 注入检测" },
      context("web-1", "Cookie Jar", "Web"),
    )
    expect(status).toBe("recorded")
    await instance.flush()

    const view = instance.view()
    expect(view.totalReports).toBe(1)
    expect(view.entries).toHaveLength(1)
    const entry = view.entries[0]!
    expect(entry).toMatchObject({
      tool: "sqlmap",
      category: "Web",
      reportCount: 1,
      reasons: ["需要 SQL 注入检测"],
      challenges: [{ challengeId: "web-1", title: "Cookie Jar" }],
    })
    expect(entry.firstReportedAt).toBe(entry.lastReportedAt)

    const file = JSON.parse(await readFile(path, "utf8")) as { version: number; entries: unknown[] }
    expect(file.version).toBe(1)
    expect(file.entries).toHaveLength(1)
  })

  it("同题同工具重复上报返回 duplicate 且不更新任何字段", async () => {
    const { instance } = await registry()
    instance.record({ tool: "sqlmap", reason: "A" }, context("web-1", "Cookie Jar", "Web"))
    instance.record({ tool: "sqlmap", reason: "B" }, context("web-1", "Cookie Jar", "Web"))
    await instance.flush()

    const entry = instance.view().entries[0]!
    expect(entry.reportCount).toBe(1)
    expect(entry.reasons).toEqual(["A"])
    expect(entry.challenges).toHaveLength(1)
    expect(entry.lastReportedAt).toBe(entry.firstReportedAt)
  })

  it("同工具跨题上报合并进同一条目(去重键=规范化工具名)", async () => {
    const { instance } = await registry()
    instance.record({ tool: "SqlMap ", reason: "A" }, context("web-1", "Cookie Jar", "Web"))
    instance.record({ tool: "sqlmap", reason: "B" }, context("web-2", "Login", "Web"))
    await instance.flush()

    const entry = instance.view().entries[0]!
    expect(entry.tool).toBe("sqlmap")
    expect(entry.reportCount).toBe(2)
    expect(entry.challenges).toHaveLength(2)
    expect(entry.reasons).toEqual(["A", "B"])
    expect(entry.category).toBe("Web")
  })

  it("reasons 按内容去重且最多保留 10 条(超出丢最旧)", async () => {
    const { instance } = await registry()
    for (let index = 0; index < 10; index++) {
      instance.record(
        { tool: "sqlmap", reason: `原因 ${index}` },
        context(`web-${index + 1}`, `T${index}`, "Web"),
      )
    }
    // 跨题重复同一条原因 → 去重,不新增
    instance.record({ tool: "sqlmap", reason: "原因 3" }, context("web-99", "Dup", "Web"))
    await instance.flush()
    expect(instance.view().entries[0]!.reasons).toHaveLength(10)

    // 再新增一条 → 超出上限,丢最旧
    instance.record({ tool: "sqlmap", reason: "原因 10" }, context("web-98", "New", "Web"))
    await instance.flush()
    const entry = instance.view().entries[0]!
    expect(entry.reasons).toHaveLength(10)
    expect(entry.reasons).not.toContain("原因 0")
    expect(entry.reasons).toContain("原因 10")
  })

  it("坏文件/缺失文件启动退化为空表", async () => {
    const root = await mkdtemp(join(tmpdir(), "toolsneed-"))
    roots.push(root)
    await writeFile(join(root, "toolsneed.json"), "{not json")
    const instance = await ToolsNeedRegistry.open(join(root, "toolsneed.json"))
    expect(instance.view().entries).toHaveLength(0)

    const missing = await ToolsNeedRegistry.open(join(root, "none.json"))
    expect(missing.view().entries).toHaveLength(0)
  })

  it("markdown 渲染表格且转义竖线/换行", async () => {
    const { instance } = await registry()
    instance.record({ tool: "sqlmap|pro", reason: "需求 A\n第二行" }, context("web-1", "Cookie Jar", "Web"))
    await instance.flush()
    const markdown = instance.markdown()
    expect(markdown).toContain("| 工具 | 分类 | 上报次数 |")
    expect(markdown).toContain("sqlmap\\|pro")
    expect(markdown).toContain("需求 A 第二行")
  })

  it("clear 清空全部条目并落盘", async () => {
    const { instance, path } = await registry()
    instance.record({ tool: "sqlmap", reason: "A" }, context("web-1", "Cookie Jar", "Web"))
    await instance.clear()
    await instance.flush()

    expect(instance.view().totalReports).toBe(0)
    expect(instance.view().entries).toHaveLength(0)
    const file = JSON.parse(await readFile(path, "utf8")) as { entries: unknown[] }
    expect(file.entries).toHaveLength(0)
  })

  it("并发上报不丢条目(writeChain 写串行化)", async () => {
    const { instance, path } = await registry()
    for (let index = 0; index < 50; index++) {
      const challengeId = `web-${index}`
      instance.record({ tool: "sqlmap", reason: `第 ${index} 题` }, context(challengeId, `T${index}`, "Web"))
      instance.record({ tool: "gdb", reason: "调试" }, context(challengeId, `T${index}`, "pwn"))
    }
    await instance.flush()

    const view = instance.view()
    expect(view.entries).toHaveLength(2)
    expect(view.entries.find((entry) => entry.tool === "sqlmap")?.reportCount).toBe(50)
    expect(view.entries.find((entry) => entry.tool === "gdb")?.reportCount).toBe(50)

    const file = JSON.parse(await readFile(path, "utf8")) as { entries: Array<{ reportCount: number }> }
    expect(file.entries).toHaveLength(2)
    expect(file.entries.every((entry) => entry.reportCount === 50)).toBe(true)
  })
})
