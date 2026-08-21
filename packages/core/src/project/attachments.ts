import { createHash } from "node:crypto"
import { posix } from "node:path"
import type { Attachment, ChallengeCapability } from "@ctf-agent/platform"
import { DockerExecutionEnv, type Sandbox } from "@ctf-agent/sandbox"

export interface DownloadedChallengeAttachment {
  id: string
  name: string
  size: number
  path: string
}

export class ChallengeAttachmentError extends Error {
  readonly code = "CHALLENGE_ATTACHMENT_ERROR"

  constructor(
    readonly attachmentId: string,
    readonly stage: "download" | "save",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = "ChallengeAttachmentError"
  }
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
    let payload: Awaited<ReturnType<ChallengeCapability["downloadAttachment"]>>
    try {
      payload = await options.capability.downloadAttachment(attachment.id)
    } catch (cause) {
      throw new ChallengeAttachmentError(
        attachment.id,
        "download",
        `无法下载题目附件 ${attachment.name}: ${errorMessage(cause)}`,
        { cause },
      )
    }
    const path = uniqueChallengeAttachmentPath(
      payload.attachment.id,
      payload.attachment.name,
      usedPaths,
    )
    usedPaths.add(path)
    // 等价性校验用 size + SHA-256，不整文件读回：readBinaryFile 受 exec 输出上限
    // 约束，超过上限的附件永远会被判定为已变化而反复重写。
    const existingInfo = await env.fileInfo(path)
    const unchanged =
      existingInfo.ok &&
      existingInfo.value.size === payload.content.byteLength &&
      (await unchangedContent(env, path, payload.content))
    const saved = unchanged
      ? ({ ok: true, value: undefined } as const)
      : await env.replaceFile(path, payload.content)
    if (!saved.ok) {
      throw new ChallengeAttachmentError(
        payload.attachment.id,
        "save",
        `无法保存题目附件 ${payload.attachment.name}: ${saved.error.message}`,
        { cause: saved.error },
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function unchangedContent(
  env: DockerExecutionEnv,
  path: string,
  content: Uint8Array,
): Promise<boolean> {
  const digest = await env.readFileHash(path)
  return digest.ok && digest.value === createHash("sha256").update(content).digest("hex")
}

export function challengeAttachmentPath(name: string): string {
  const basename = sanitizeSegment(posix.basename(name.replaceAll("\\", "/"))) || "download.bin"
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
