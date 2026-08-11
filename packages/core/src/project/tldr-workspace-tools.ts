import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core"
import { Type } from "typebox"
import { listWorkspaceArtifacts, readWorkspaceArtifact } from "./challenge-workspace.ts"

export const TLDR_WORKSPACE_READ_MAX_BYTES = 64 * 1_024

function result(details: object): AgentToolResult<Record<string, unknown>> {
  const value = details as Record<string, unknown>
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    details: value,
  }
}

/** TLDR 只读取宿主机上的题目 workspace，不需要创建 Docker sandbox。 */
export function createTldrWorkspaceTools(workspace: string): AgentTool[] {
  return [
    {
      name: "list",
      label: "List Workspace Files",
      description:
        "Recursively list regular files in the challenge workspace. Paths are relative and can be passed to read.",
      parameters: Type.Object({}),
      executionMode: "sequential",
      async execute() {
        const listing = await listWorkspaceArtifacts(workspace)
        return result({
          ...listing,
          // session.jsonl 是 TLDR 自身的控制面状态，不属于题目产物。
          files: listing.files.filter(
            (file) => file.path !== "tldr" && !file.path.startsWith("tldr/"),
          ),
        })
      },
    },
    {
      name: "read",
      label: "Read Workspace File",
      description: `Read one UTF-8 text file from the challenge workspace. The path must come from list and files larger than ${TLDR_WORKSPACE_READ_MAX_BYTES} bytes are rejected.`,
      parameters: Type.Object({ path: Type.String({ minLength: 1 }) }),
      executionMode: "sequential",
      async execute(_id, params) {
        const path = (params as { path: string }).path.replaceAll("\\", "/")
        if (path === "tldr" || path.startsWith("tldr/")) {
          throw new Error("TLDR session files are not readable workspace artifacts")
        }
        const bytes = await readWorkspaceArtifact(workspace, path, TLDR_WORKSPACE_READ_MAX_BYTES)
        let content: string
        try {
          content = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
        } catch {
          throw new Error("Workspace artifact is not valid UTF-8 text")
        }
        return result({ path, size: bytes.byteLength, content })
      },
    },
  ]
}
