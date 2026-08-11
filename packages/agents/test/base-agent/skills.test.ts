import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vite-plus/test"
import { discoverProjectSkillsWithDiagnostics, materializeSkills } from "../../src/index.ts"

const roots: string[] = []
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
)

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "base-agent-skills-"))
  roots.push(root)
  await mkdir(join(root, ".pi", "skills", "reverse"), { recursive: true })
  await writeFile(
    join(root, ".pi", "skills", "reverse", "SKILL.md"),
    ["---", "name: reverse", "description: Analyze binaries safely", "---", "# Reverse"].join("\n"),
  )
  return root
}

describe("shared Pi skills", () => {
  it("discovers with Pi and materializes a container-visible copy", async () => {
    const root = await fixture()
    const discovered = await discoverProjectSkillsWithDiagnostics(root)
    expect(discovered.diagnostics).toEqual([])
    expect(discovered.skills).toHaveLength(1)
    expect(discovered.skills[0]).toMatchObject({
      name: "reverse",
      description: "Analyze binaries safely",
    })

    const [skill] = await materializeSkills(discovered.skills, join(root, "workspace"))
    expect(skill?.filePath).toBe("/workspace/.skills/skill-1/SKILL.md")
    expect(
      await readFile(join(root, "workspace", ".skills", "skill-1", "SKILL.md"), "utf8"),
    ).toContain("# Reverse")
  })

  it("rejects symlinks while copying skill assets", async (context) => {
    const root = await fixture()
    await writeFile(join(root, "outside.txt"), "secret")
    try {
      await symlink(join(root, "outside.txt"), join(root, ".pi", "skills", "reverse", "linked.txt"))
    } catch (error) {
      if (
        process.platform === "win32" &&
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "EPERM"
      ) {
        context.skip()
        return
      }
      throw error
    }
    const { skills } = await discoverProjectSkillsWithDiagnostics(root)
    await expect(materializeSkills(skills, join(root, "workspace"))).rejects.toThrow("符号链接")
  })
})
