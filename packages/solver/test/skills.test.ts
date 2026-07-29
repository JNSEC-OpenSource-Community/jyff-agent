import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { buildSkillsCatalog, createLoadSkillTool, discoverProjectSkills, materializeSkills } from "../src/skills.js"

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

async function skill(root: string, directory: string, content: string): Promise<void> {
  const path = join(root, directory, "SKILL.md")
  await mkdir(join(root, directory), { recursive: true })
  await writeFile(path, content)
}

describe("Skills", () => {
  it("发现 Pi-compatible skills、跳过无描述项，并保持前目录的同名 skill", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctf-skills-"))
    roots.push(root)
    await skill(root, ".pi/skills/reverse", "---\nname: reverse\ndescription: Analyze <binaries> safely\nallowed-tools: read bash\n---\n# Reverse\nUse file.")
    await skill(root, ".agents/skills/reverse", "---\nname: reverse\ndescription: wrong duplicate\n---\nignored")
    await skill(root, ".pi/skills/invalid", "---\nname: invalid\n---\nno description")

    const skills = await discoverProjectSkills(root)
    expect(skills).toHaveLength(1)
    expect(skills[0]).toMatchObject({ name: "reverse", description: "Analyze <binaries> safely", allowedTools: ["read", "bash"] })
    expect(buildSkillsCatalog(skills)).toContain("Analyze &lt;binaries&gt; safely")
  })

  it("将 skill 资产复制到 workspace，目录提示不会泄露宿主机路径", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctf-skills-"))
    roots.push(root)
    await skill(root, ".pi/skills/reverse", "---\nname: reverse\ndescription: Analyze binaries\n---\n# Reverse")
    await writeFile(join(root, ".pi", "skills", "reverse", "helper.py"), "print('ok')")
    const materialized = await materializeSkills(await discoverProjectSkills(root), join(root, "workspace"))

    expect(await readFile(join(root, "workspace", ".skills", "skill-1", "helper.py"), "utf8")).toBe("print('ok')")
    expect(materialized[0]?.sandboxPath).toBe("/workspace/.skills/skill-1/SKILL.md")
    expect(buildSkillsCatalog(materialized)).toContain("/workspace/.skills/skill-1/SKILL.md")
  })

  it("load_skill 只返回已发现的正文，不能按路径读取宿主机文件", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctf-skills-"))
    roots.push(root)
    await skill(root, ".pi/skills/reverse", "---\nname: reverse\ndescription: Analyze binaries\n---\n# Reverse\nBody")
    const [loaded] = await discoverProjectSkills(root)
    const tool = createLoadSkillTool([loaded!])
    if (!tool) throw new Error("未创建 load_skill")

    await expect(tool.execute("skill", { name: "reverse" })).resolves.toMatchObject({ content: [{ text: expect.stringContaining("# Reverse") }] })
    await expect(tool.execute("skill", { name: "../../etc/passwd" })).rejects.toThrow("未发现 skill")
  })
})
