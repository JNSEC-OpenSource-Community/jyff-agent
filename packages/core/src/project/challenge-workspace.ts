import { createHash } from "node:crypto"
import { lstat, realpath } from "node:fs/promises"
import { isAbsolute, relative, resolve } from "node:path"

export function challengeWorkspaceKey(challengeId: string): string {
  return createHash("sha256")
    .update(challengeId, "utf8")
    .digest("hex")
    .slice(0, 32)
}

export function challengeWorkspacePath(
  agentDirectory: string,
  challengeId: string,
): string {
  return resolve(
    agentDirectory,
    "challenges",
    challengeWorkspaceKey(challengeId),
    "workspace",
  )
}

export function resolveWorkspaceArtifact(
  workspace: string,
  untrustedPath: string,
): string {
  if (
    !untrustedPath ||
    isAbsolute(untrustedPath) ||
    untrustedPath.includes("\0")
  ) {
    throw new Error("Workspace artifact path must be a non-empty relative path")
  }
  const root = resolve(workspace)
  const target = resolve(root, untrustedPath)
  const relation = relative(root, target)
  if (
    relation === ".." ||
    relation.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
  ) {
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
  const stat = await lstat(artifactPath)
  if (!stat.isSymbolicLink()) return
  const target = await realpath(artifactPath)
  const relation = relative(root, target)
  if (
    relation === ".." ||
    relation.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
  ) {
    throw new Error(
      "Workspace artifact symlink escapes the challenge workspace",
    )
  }
}
