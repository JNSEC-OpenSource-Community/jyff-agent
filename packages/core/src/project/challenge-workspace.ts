import { createHash } from "node:crypto"
import { lstat, readdir, readFile, realpath } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"

export interface WorkspaceArtifactEntry {
  path: string
  size: number
  modifiedAt: string
}

export interface WorkspaceArtifactListing {
  files: WorkspaceArtifactEntry[]
  truncated: boolean
}

const DEFAULT_MAX_WORKSPACE_FILES = 2_000

export function challengeWorkspaceKey(challengeId: string): string {
  return createHash("sha256").update(challengeId, "utf8").digest("hex").slice(0, 32)
}

export function challengeWorkspacePath(agentDirectory: string, challengeId: string): string {
  return resolve(agentDirectory, "challenges", challengeWorkspaceKey(challengeId), "workspace")
}

export function resolveWorkspaceArtifact(workspace: string, untrustedPath: string): string {
  if (!untrustedPath || isAbsolute(untrustedPath) || untrustedPath.includes("\0")) {
    throw new Error("Workspace artifact path must be a non-empty relative path")
  }
  const root = resolve(workspace)
  const target = resolve(root, untrustedPath)
  const relation = relative(root, target)
  if (relation === ".." || relation.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error("Workspace artifact path escapes the challenge workspace")
  }
  return target
}

/** Reject an existing symlink whose real target leaves the challenge workspace. */
export async function assertWorkspaceArtifactContained(
  workspace: string,
  artifactPath: string,
): Promise<void> {
  const root = await realpath(workspace)
  const target = await realpath(artifactPath)
  const relation = relative(root, target)
  if (relation === ".." || relation.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error("Workspace artifact symlink escapes the challenge workspace")
  }
}

export async function listWorkspaceArtifacts(
  workspace: string,
  maximumFiles = DEFAULT_MAX_WORKSPACE_FILES,
): Promise<WorkspaceArtifactListing> {
  let root: string
  try {
    root = await realpath(workspace)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { files: [], truncated: false }
    }
    throw error
  }
  const files: WorkspaceArtifactEntry[] = []
  let truncated = false

  const visit = async (directory: string): Promise<void> => {
    const resolvedDirectory = await realpath(directory)
    assertRealPathContained(root, resolvedDirectory)
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (files.length >= maximumFiles) {
        truncated = true
        return
      }
      if (entry.isSymbolicLink()) continue
      const absolutePath = resolve(directory, entry.name)
      if (entry.isDirectory()) {
        await visit(absolutePath)
        if (truncated) return
        continue
      }
      if (!entry.isFile()) continue
      const metadata = await lstat(absolutePath)
      files.push({
        path: relative(root, absolutePath).split(sep).join("/"),
        size: metadata.size,
        modifiedAt: metadata.mtime.toISOString(),
      })
    }
  }

  await visit(root)
  return { files, truncated }
}

export async function readWorkspaceArtifact(
  workspace: string,
  untrustedPath: string,
  maximumBytes?: number,
): Promise<Uint8Array> {
  const artifactPath = resolveWorkspaceArtifact(workspace, untrustedPath)
  await assertWorkspaceArtifactContained(workspace, artifactPath)
  const metadata = await lstat(artifactPath)
  if (!metadata.isFile()) throw new Error("Workspace artifact is not a file")
  if (maximumBytes !== undefined && metadata.size > maximumBytes) {
    throw new Error(`Workspace artifact exceeds ${maximumBytes} bytes`)
  }
  return readFile(artifactPath)
}

function assertRealPathContained(root: string, target: string): void {
  const relation = relative(root, target)
  if (relation === ".." || relation.startsWith(`..${sep}`)) {
    throw new Error("Workspace artifact symlink escapes the challenge workspace")
  }
}
