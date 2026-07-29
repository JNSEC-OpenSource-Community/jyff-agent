import { copyFile, lstat, mkdir, readdir, readFile, realpath } from "node:fs/promises"
import { basename, dirname, extname, join, resolve } from "node:path"
import { Type } from "typebox"
import type { AgentTool } from "@earendil-works/pi-agent-core"

export interface AgentSkill {
  name: string
  description: string
  filePath: string
  baseDir: string
  body: string
  allowedTools: string[]
  /** materialize 后的容器可见路径；未 materialize 时不存在。 */
  sandboxPath?: string
  sandboxBaseDir?: string
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character] ?? character)
}

function frontmatter(content: string): { fields: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content)
  if (!match) return { fields: {}, body: content }
  const fields: Record<string, string> = {}
  for (const line of match[1]!.split(/\r?\n/)) {
    const separator = line.indexOf(":")
    if (separator <= 0) continue
    const key = line.slice(0, separator).trim()
    const value = line.slice(separator + 1).trim().replace(/^(?:"|')|(?:"|')$/g, "")
    if (key) fields[key] = value
  }
  return { fields, body: match[2] ?? "" }
}

async function loadSkill(path: string): Promise<AgentSkill | undefined> {
  try {
    const content = await readFile(path, "utf8")
    const parsed = frontmatter(content)
    const name = parsed.fields.name ?? basename(dirname(path))
    const description = parsed.fields.description ?? ""
    // 与 Pi 一致：没有 description 的文件不作为可自动调用的 skill。
    if (!description) return undefined
    return {
      name,
      description,
      filePath: path,
      baseDir: dirname(path),
      body: parsed.body,
      allowedTools: parsed.fields["allowed-tools"]?.split(/\s+/).filter(Boolean) ?? [],
    }
  } catch {
    return undefined
  }
}

async function discoverDirectory(path: string, acceptRootMarkdown: boolean): Promise<AgentSkill[]> {
  const result: AgentSkill[] = []
  const visited = new Set<string>()
  async function visit(directory: string, isRoot: boolean): Promise<void> {
    let entries: Array<{ name: string; isDirectory(): boolean }>
    try { entries = await readdir(directory, { withFileTypes: true, encoding: "utf8" }) } catch { return }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue
      const child = join(directory, entry.name)
      if (entry.isDirectory()) {
        const skillPath = join(child, "SKILL.md")
        try {
          const canonical = await realpath(skillPath)
          if (!visited.has(canonical)) {
            visited.add(canonical)
            const skill = await loadSkill(canonical)
            if (skill) result.push(skill)
          }
        } catch {
          // 目录不是 skill 时继续递归，支持 skills 分类目录。
        }
        await visit(child, false)
      } else if (isRoot && acceptRootMarkdown && extname(entry.name).toLowerCase() === ".md") {
        const canonical = await realpath(child)
        if (visited.has(canonical)) continue
        visited.add(canonical)
        const skill = await loadSkill(canonical)
        if (skill) result.push(skill)
      }
    }
  }
  await visit(path, true)
  return result
}

/** 发现 Project 下的 Pi-compatible skills；靠前目录的同名 skill 优先。 */
export async function discoverProjectSkills(root: string, extraPaths: readonly string[] = []): Promise<AgentSkill[]> {
  const groups = await Promise.all([
    discoverDirectory(join(root, ".pi", "skills"), true),
    discoverDirectory(join(root, ".agents", "skills"), false),
    ...extraPaths.map((path) => discoverDirectory(resolve(root, path), true)),
  ])
  const byName = new Map<string, AgentSkill>()
  for (const group of groups) {
    for (const skill of group) if (!byName.has(skill.name)) byName.set(skill.name, skill)
  }
  return [...byName.values()]
}

export function buildSkillsCatalog(skills: readonly AgentSkill[]): string {
  if (skills.length === 0) return ""
  const lines = [
    "The following skills provide specialized instructions for specific tasks.",
    "Use the load_skill tool to load a skill's full instructions when its description matches the task.",
    "<available_skills>",
  ]
  for (const skill of skills) {
    lines.push("  <skill>")
    lines.push(`    <name>${escapeXml(skill.name)}</name>`)
    lines.push(`    <description>${escapeXml(skill.description)}</description>`)
    lines.push(`    <location>${escapeXml(skill.sandboxPath ?? skill.filePath)}</location>`)
    lines.push("  </skill>")
  }
  lines.push("</available_skills>")
  return lines.join("\n")
}

/**
 * 将可信 Project skill 复制到唯一的 workspace 子目录。复制阶段拒绝符号链接，
 * 防止挂载 workspace 后通过 skill 资产间接指向容器外路径。
 */
export async function materializeSkills(skills: readonly AgentSkill[], workspace: string): Promise<AgentSkill[]> {
  const root = join(workspace, ".skills")
  await mkdir(root, { recursive: true })
  const copyTree = async (source: string, target: string): Promise<void> => {
    const stat = await lstat(source)
    if (stat.isSymbolicLink()) throw new Error(`skill 包含不允许的符号链接: ${source}`)
    if (stat.isDirectory()) {
      await mkdir(target, { recursive: true })
      for (const entry of await readdir(source, { withFileTypes: true, encoding: "utf8" })) {
        await copyTree(join(source, entry.name), join(target, entry.name))
      }
      return
    }
    if (!stat.isFile()) throw new Error(`skill 包含不支持的文件类型: ${source}`)
    await mkdir(dirname(target), { recursive: true })
    await copyFile(source, target)
  }

  const materialized: AgentSkill[] = []
  for (const [index, skill] of skills.entries()) {
    const directory = join(root, `skill-${index + 1}`)
    const isStandardDirectory = basename(skill.filePath).toLowerCase() === "skill.md"
    if (isStandardDirectory) {
      await copyTree(skill.baseDir, directory)
      materialized.push({
        ...skill,
        sandboxBaseDir: `/workspace/.skills/skill-${index + 1}`,
        sandboxPath: `/workspace/.skills/skill-${index + 1}/SKILL.md`,
      })
    } else {
      await mkdir(directory, { recursive: true })
      await copyTree(skill.filePath, join(directory, "SKILL.md"))
      materialized.push({
        ...skill,
        sandboxBaseDir: `/workspace/.skills/skill-${index + 1}`,
        sandboxPath: `/workspace/.skills/skill-${index + 1}/SKILL.md`,
      })
    }
  }
  return materialized
}

/** Skill 正文只从已发现的内存快照返回，Agent 无法借此读取任意宿主机路径。 */
export function createLoadSkillTool(skills: readonly AgentSkill[]): AgentTool | undefined {
  if (skills.length === 0) return undefined
  const byName = new Map(skills.map((skill) => [skill.name, skill]))
  return {
    name: "load_skill",
    label: "Load Skill",
    description: "加载已发现 skill 的完整说明。",
    parameters: Type.Object({ name: Type.String() }),
    executionMode: "sequential",
    async execute(_id, params) {
      const name = (params as { name: string }).name
      const skill = byName.get(name)
      if (!skill) throw new Error(`未发现 skill: ${name}`)
      return {
        content: [{ type: "text", text: `${skill.body}\n\nSkill directory: ${skill.sandboxBaseDir ?? "(instructions only)"}` }],
        details: { name: skill.name, location: skill.sandboxPath, allowedTools: skill.allowedTools },
      }
    },
  }
}
