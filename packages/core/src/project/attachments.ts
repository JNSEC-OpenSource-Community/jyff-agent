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
  for (const attachment of options.attachments) {
    const payload = await options.capability.downloadAttachment(attachment.id)
    const path = challengeAttachmentPath(
      payload.attachment.id,
      payload.attachment.name,
    )
    const saved = await env.writeFile(path, payload.content)
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

export function challengeAttachmentPath(id: string, name: string): string {
  const safeId = sanitizeSegment(id) || "attachment"
  const basename =
    sanitizeSegment(posix.basename(name.replaceAll("\\", "/"))) ||
    "download.bin"
  return `/workspace/attachments/${safeId}/${basename}`
}

function sanitizeSegment(value: string): string {
  return value
    .replace(/[^A-Za-z0-9_.-]/g, "_")
    .replace(/^\.+$/, "")
    .slice(0, 160)
}
