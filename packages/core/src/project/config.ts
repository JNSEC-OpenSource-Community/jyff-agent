import { access, readFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

export interface ProjectConfig {
  version: 1
  project: { id: string; name: string }
  platform: { plugin: string; config: unknown }
  sandbox: {
    image: string
    privileged: boolean
    networkMode: "none" | "bridge" | "host"
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象`)
  }
  return value as Record<string, unknown>
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`${label} 必须是非空字符串`)
  return value
}

export function parseProjectConfig(value: unknown): ProjectConfig {
  const root = object(value, "CTF 配置")
  if (root.version !== 1) throw new Error("仅支持 version: 1 的 CTF 配置")
  const project = object(root.project, "project")
  const platform = object(root.platform, "platform")
  const sandbox = object(root.sandbox, "sandbox")
  const networkMode = sandbox.networkMode ?? "bridge"
  if (
    networkMode !== "none" &&
    networkMode !== "bridge" &&
    networkMode !== "host"
  ) {
    throw new Error("sandbox.networkMode 仅支持 none、bridge 或 host")
  }

  return {
    version: 1,
    project: {
      id: text(project.id, "project.id"),
      name: text(project.name, "project.name"),
    },
    platform: {
      plugin: text(platform.plugin, "platform.plugin"),
      config: platform.config ?? {},
    },
    sandbox: {
      image: text(sandbox.image, "sandbox.image"),
      privileged: sandbox.privileged === true,
      networkMode,
    },
  }
}

export async function findProjectRoot(start = process.cwd()): Promise<string> {
  let current = resolve(start)
  while (true) {
    try {
      await access(join(current, ".pi", "ctf-config.json"))
      return current
    } catch {
      const parent = dirname(current)
      if (parent === current) throw new Error("未找到 .pi/ctf-config.json")
      current = parent
    }
  }
}

export async function loadProjectConfig(root: string): Promise<ProjectConfig> {
  const path = join(root, ".pi", "ctf-config.json")
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(path, "utf8"))
  } catch (error) {
    throw new Error(
      `无法读取 ${path}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  return parseProjectConfig(raw)
}
