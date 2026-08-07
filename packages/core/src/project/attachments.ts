import { Buffer } from "node:buffer"
import { posix } from "node:path"
import type { Attachment, ChallengeCapability } from "@ctf-agent/platform"
import { DockerExecutionEnv, type Sandbox } from "@ctf-agent/sandbox"

export interface DownloadedChallengeAttachment {
  id: string
  name: string
  size: number
  path: string
}

/** Download every advertised attachment into the run's persistent workspace. */
export async function downloadChallengeAttachments(options: {
  capability: ChallengeCapability
  attachments: readonly Attachment[]
  sandbox: Sandbox
}): Promise<DownloadedChallengeAttachment[]> {
  const env = new DockerExecutionEnv(options.sandbox)
  const downloaded: DownloadedChallengeAttachment[] = []
  const usedPaths = new Set<string>()
  for (const attachment of options.attachments) {
    const payload = await options.capability.downloadAttachment(attachment.id)
    const path = uniqueChallengeAttachmentPath(
      payload.attachment.id,
      payload.attachment.name,
      usedPaths,
    )
    usedPaths.add(path)
    const existing = await env.readBinaryFile(path)
    const unchanged =
      existing.ok && Buffer.from(existing.value).equals(payload.content)
    const saved = unchanged
      ? ({ ok: true, value: undefined } as const)
      : await env.replaceFile(path, payload.content)
    if (!saved.ok) {
      throw new Error(
        `无法保存题目附件 ${payload.attachment.name}: ${saved.error.message}`,
        {
          cause: saved.error,
        },
      )
    }
    downloaded.push({
      id: payload.attachment.id,
      name: payload.attachment.name,
      size: payload.content.byteLength,
      path,
    })
  }
  return downloaded
}

export function challengeAttachmentPath(name: string): string {
  const basename =
    sanitizeSegment(posix.basename(name.replaceAll("\\", "/"))) ||
    "download.bin"
  return `/workspace/attachments/${basename}`
}

function uniqueChallengeAttachmentPath(
  id: string,
  name: string,
  usedPaths: ReadonlySet<string>,
): string {
  const direct = challengeAttachmentPath(name)
  if (!usedPaths.has(direct)) return direct
  const basename = posix.basename(direct)
  const extension = posix.extname(basename)
  const stem = basename.slice(0, basename.length - extension.length)
  const safeId = sanitizeSegment(id) || "attachment"
  let suffix = safeId
  let index = 2
  let candidate = `/workspace/attachments/${stem}-${suffix}${extension}`
  while (usedPaths.has(candidate)) {
    suffix = `${safeId}-${index++}`
    candidate = `/workspace/attachments/${stem}-${suffix}${extension}`
  }
  return candidate
}

function sanitizeSegment(value: string): string {
  return value
    .replace(/[^A-Za-z0-9_.-]/g, "_")
    .replace(/^\.+$/, "")
    .slice(0, 160)
}
