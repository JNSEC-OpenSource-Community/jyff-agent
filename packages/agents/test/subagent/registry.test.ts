import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  availableSubagentRoles,
  discoverSubagentRoles,
  resolveSubagentRole,
} from "../../src/subagent/registry.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ctf-subagent-roles-"))
  roots.push(root)
  return root
}

describe("SubAgent role registry", () => {
  it("提供覆盖常见 CTF 方向的内置角色，并严格解析名称", async () => {
    const root = await fixture()
    const discovered = await discoverSubagentRoles(root)

    expect(
      availableSubagentRoles(discovered.roles).map((role) => role.name),
    ).toEqual(
      expect.arrayContaining([
        "general-purpose",
        "pwn",
        "reverse",
        "web",
        "crypto",
        "misc",
        "reviewer",
      ]),
    )
    expect(resolveSubagentRole(discovered.roles, " PWN ")?.name).toBe("pwn")
    expect(resolveSubagentRole(discovered.roles, "pw")).toBeUndefined()
    expect(discovered.diagnostics).toEqual([])
  })

  it("按 .agents → .pi 优先级加载项目角色配置", async () => {
    const root = await fixture()
    await mkdir(join(root, ".agents", "agents"), { recursive: true })
    await mkdir(join(root, ".pi", "agents"), { recursive: true })
    await writeFile(
      join(root, ".agents", "agents", "pwn.md"),
      ["---", "description: repository role", "---", "先验证崩溃。"].join("\n"),
    )
    await writeFile(
      join(root, ".pi", "agents", "pwn.md"),
      [
        "---",
        "display_name: Pwn Specialist",
        "description: pi-compatible override",
        "tools: [bash, read]",
        "thinking: high",
        "---",
        "先构造最小可复现利用。",
      ].join("\n"),
    )

    const discovered = await discoverSubagentRoles(root)
    expect(discovered.roles.get("pwn")).toMatchObject({
      displayName: "Pwn Specialist",
      description: "pi-compatible override",
      tools: ["bash", "read"],
      thinkingLevel: "high",
      source: "project",
    })
    expect(discovered.roles.get("pwn")?.systemPrompt).toContain(
      "先构造最小可复现利用。",
    )
  })

  it("隔离无效配置并返回可诊断错误", async () => {
    const root = await fixture()
    await mkdir(join(root, ".pi", "agents"), { recursive: true })
    await writeFile(
      join(root, ".pi", "agents", "broken.md"),
      ["---", "thinking: ultra", "---", "invalid"].join("\n"),
    )

    const discovered = await discoverSubagentRoles(root)
    expect(discovered.roles.has("broken")).toBe(false)
    expect(discovered.diagnostics).toEqual([
      expect.objectContaining({ message: expect.stringContaining("thinking") }),
    ])
  })
})
