import { createHash } from "node:crypto"
import type { ChallengeCapability } from "@ctf-agent/platform"
import type { CommandResult, Sandbox, SandboxExecOptions } from "@ctf-agent/sandbox"
import { describe, expect, it, vi } from "vite-plus/test"
import {
  ChallengeAttachmentError,
  downloadChallengeAttachments,
} from "../../src/project/attachments.ts"

class AttachmentSandbox implements Sandbox {
  readonly id = "attachment-sandbox"
  readonly files = new Map<string, Buffer>()
  replaceCalls = 0

  async exec(args: string[], options?: SandboxExecOptions): Promise<CommandResult> {
    if (args[0] !== "python3") return { code: 0, stdout: "", stderr: "" }
    const payload = JSON.parse(options?.input ?? "{}") as {
      op: string
      path: string
      base64?: string
    }
    const content = this.files.get(payload.path)
    if (payload.op === "info") {
      return {
        code: 0,
        stdout: JSON.stringify(
          content
            ? {
                ok: true,
                value: {
                  name: "chall",
                  path: payload.path,
                  kind: "file",
                  size: content.byteLength,
                  mtimeMs: 0,
                },
              }
            : { ok: false, code: "not_found", message: "not found", path: payload.path },
        ),
        stderr: "",
      }
    }
    if (payload.op === "sha256") {
      return {
        code: 0,
        stdout: JSON.stringify(
          content
            ? { ok: true, value: createHash("sha256").update(content).digest("hex") }
            : { ok: false, code: "not_found", message: "not found", path: payload.path },
        ),
        stderr: "",
      }
    }
    if (payload.op === "replace") {
      this.replaceCalls++
      this.files.set(payload.path, Buffer.from(payload.base64 ?? "", "base64"))
    }
    return {
      code: 0,
      stdout: JSON.stringify({ ok: true, value: null }),
      stderr: "",
    }
  }

  async close(): Promise<void> {}
}

function capability(content: Buffer): ChallengeCapability {
  return {
    getInfo: vi.fn(),
    submitFlag: vi.fn(),
    downloadAttachment: vi.fn(async () => ({
      attachment: { id: "chall", name: "chall" },
      content,
    })),
  }
}

describe("challenge attachments", () => {
  it("用结构化错误标记平台下载失败", async () => {
    const sandbox = new AttachmentSandbox()
    const failedCapability = capability(Buffer.from("unused"))
    failedCapability.downloadAttachment = vi.fn(async () => {
      throw new Error("fetch failed")
    })

    await expect(
      downloadChallengeAttachments({
        capability: failedCapability,
        attachments: [{ id: "chall", name: "chall" }],
        sandbox,
      }),
    ).rejects.toMatchObject({
      name: ChallengeAttachmentError.name,
      code: "CHALLENGE_ATTACHMENT_ERROR",
      attachmentId: "chall",
      stage: "download",
    })
  })

  it("跨 attempt 遇到内容未变化的附件时保留现有 inode", async () => {
    const sandbox = new AttachmentSandbox()
    sandbox.files.set("/workspace/attachments/chall", Buffer.from("binary"))

    await downloadChallengeAttachments({
      capability: capability(Buffer.from("binary")),
      attachments: [{ id: "chall", name: "chall" }],
      sandbox,
    })

    expect(sandbox.replaceCalls).toBe(0)
  })

  it("同内容附件第二次下载时跳过写入（内容比对优化）", async () => {
    const sandbox = new AttachmentSandbox()
    sandbox.files.set("/workspace/attachments/chall", Buffer.from("unchanged"))

    await downloadChallengeAttachments({
      capability: capability(Buffer.from("unchanged")),
      attachments: [{ id: "chall", name: "chall" }],
      sandbox,
    })

    expect(sandbox.replaceCalls).toBe(0)
  })

  it("超过 exec 输出上限的大附件未变化时也跳过重写", async () => {
    const sandbox = new AttachmentSandbox()
    // 9 MiB：超过 file helper 8 MiB 的输出上限，旧的整文件读回比对会失败。
    const content = Buffer.alloc(9 * 1024 * 1024, 0x5a)
    sandbox.files.set("/workspace/attachments/chall", content)

    await downloadChallengeAttachments({
      capability: capability(content),
      attachments: [{ id: "chall", name: "chall" }],
      sandbox,
    })

    expect(sandbox.replaceCalls).toBe(0)
  })

  it("同名附件去重时各自写入不同路径", async () => {
    const sandbox = new AttachmentSandbox()

    await downloadChallengeAttachments({
      capability: capability(Buffer.from("payload")),
      attachments: [
        { id: "a", name: "chall" },
        { id: "b", name: "chall" },
      ],
      sandbox,
    })

    expect(sandbox.replaceCalls).toBe(2)
    expect(sandbox.files.size).toBe(2)
  })

  it("附件内容变化时通过原子替换刷新目标文件", async () => {
    const sandbox = new AttachmentSandbox()
    sandbox.files.set("/workspace/attachments/chall", Buffer.from("old"))

    await downloadChallengeAttachments({
      capability: capability(Buffer.from("new")),
      attachments: [{ id: "chall", name: "chall" }],
      sandbox,
    })

    expect(sandbox.replaceCalls).toBe(1)
    expect(sandbox.files.get("/workspace/attachments/chall")?.toString()).toBe("new")
  })
})
