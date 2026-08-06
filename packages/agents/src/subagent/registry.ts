import type { Dirent } from "node:fs"
import { lstat, readdir, readFile } from "node:fs/promises"
import { basename, join } from "node:path"
import { SUBAGENT_SHARED_SYSTEM_PROMPT } from "@ctf-agent/prompts"
import type { ThinkingLevel } from "@earendil-works/pi-agent-core"
import { parse } from "yaml"
import {
  DEFAULT_SUBAGENT_THINKING_LEVEL,
  isThinkingLevel,
} from "../base-agent/thinking.ts"

export interface SubagentRole {
  name: string
  displayName: string
  description: string
  systemPrompt: string
  tools?: readonly string[]
  model?: string
  thinkingLevel: ThinkingLevel
  enabled: boolean
  source: "builtin" | "project"
}

export interface SubagentRoleDiagnostic {
  path: string
  message: string
}

export interface DiscoveredSubagentRoles {
  roles: Map<string, SubagentRole>
  diagnostics: SubagentRoleDiagnostic[]
}

const DEFAULT_ROLES: readonly SubagentRole[] = [
  {
    name: "general-purpose",
    displayName: "General",
    description:
      "General CTF investigation worker for bounded cross-domain research and result verification.",
    systemPrompt: `${SUBAGENT_SHARED_SYSTEM_PROMPT}
    
    Investigate the assigned bounded objective and return a reproducible result.`,
    thinkingLevel: "high",
    enabled: true,
    source: "builtin",
  },
  {
    name: "explorer",
    displayName: "Explore",
    description: "Dive into source code and explore specific attack face.",
    systemPrompt: `${SUBAGENT_SHARED_SYSTEM_PROMPT}

    You are a information security specialist. You excel at thoroughly navigating and exploring codebases.
    Your role is EXCLUSIVELY to search and analyze existing code to explore the task user provided.`,
    thinkingLevel: "max",
    enabled: true,
    source: "builtin",
  },
  {
    name: "fuzzer",
    displayName: "Fuzz",
    description:
      "Fuzz the potential opportunity, use when you need to get some luck from blackbox challenge or while stuck.",
    systemPrompt: `${SUBAGENT_SHARED_SYSTEM_PROMPT}
    
    You are a fuzz specialist. Use tools like fuff or python to explore opportunities of solver's task.
    Don't get stuck in an endless loop, stop when there's enough results or you cannot get any more useful result.
    Clear useless fuzzing scripts or other temp files before stop.`,
    thinkingLevel: "medium",
    enabled: true,
    source: "builtin",
  },
]

/** Load built-ins and project overrides from .agents/agents and .pi/agents. */
export async function discoverSubagentRoles(
  root: string,
): Promise<DiscoveredSubagentRoles> {
  const roles = new Map(DEFAULT_ROLES.map((role) => [role.name, role]))
  const diagnostics: SubagentRoleDiagnostic[] = []
  for (const directory of [
    join(root, ".agents", "agents"),
    join(root, ".pi", "agents"),
  ]) {
    let entries: Dirent[]
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (hasCode(error, "ENOENT")) continue
      diagnostics.push({ path: directory, message: errorText(error) })
      continue
    }
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue
      const path = join(directory, entry.name)
      try {
        if ((await lstat(path)).isSymbolicLink()) {
          throw new Error("SubAgent 配置不允许使用符号链接")
        }
        const name = basename(entry.name, ".md")
        roles.set(name, parseRole(name, await readFile(path, "utf8")))
      } catch (error) {
        diagnostics.push({ path, message: errorText(error) })
      }
    }
  }
  return { roles, diagnostics }
}

export function resolveSubagentRole(
  roles: ReadonlyMap<string, SubagentRole>,
  requested: string,
): SubagentRole | undefined {
  const value = requested.trim().toLowerCase()
  if (!value) return undefined
  const matches = [...roles.values()].filter(
    (role) => role.enabled && role.name.toLowerCase() === value,
  )
  return matches.length === 1 ? matches[0] : undefined
}

export function availableSubagentRoles(
  roles: ReadonlyMap<string, SubagentRole>,
): SubagentRole[] {
  return [...roles.values()]
    .filter((role) => role.enabled)
    .sort((left, right) => left.name.localeCompare(right.name))
}

function parseRole(name: string, source: string): SubagentRole {
  const frontmatter = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/.exec(
    source,
  )
  const values = frontmatter ? parse(frontmatter[1] ?? "") : {}
  if (!isRecord(values)) throw new Error("SubAgent frontmatter 必须是对象")
  const systemPrompt = (
    frontmatter ? source.slice(frontmatter[0].length) : source
  ).trim()
  const thinking = stringValue(values.thinking)
  if (thinking && !isThinkingLevel(thinking)) {
    throw new Error(`不支持的 thinking 档位: ${thinking}`)
  }
  const thinkingLevel: ThinkingLevel =
    thinking && isThinkingLevel(thinking)
      ? thinking
      : DEFAULT_SUBAGENT_THINKING_LEVEL
  const tools = listValue(values.tools)
  const model = stringValue(values.model)
  return {
    name,
    displayName: stringValue(values.display_name) ?? name,
    description: stringValue(values.description) ?? name,
    systemPrompt: [SUBAGENT_SHARED_SYSTEM_PROMPT, systemPrompt]
      .filter(Boolean)
      .join("\n\n"),
    ...(tools ? { tools } : {}),
    ...(model ? { model } : {}),
    thinkingLevel,
    enabled: values.enabled !== false,
    source: "project",
  }
}

function listValue(value: unknown): string[] | undefined {
  const items = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : undefined
  const normalized = items
    ?.filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
  return normalized && normalized.length > 0
    ? [...new Set(normalized)]
    : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
