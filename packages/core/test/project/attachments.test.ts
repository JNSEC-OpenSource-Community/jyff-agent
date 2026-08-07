import type { ChallengeCapability } from "@ctf-agent/platform"
import type {
  CommandResult,
  Sandbox,
  SandboxExecOptions,
} from "@ctf-agent/sandbox"
import { describe, expect, it, vi } from "vitest"
import {
  ChallengeAttachmentError,
  downloadChallengeAttachments,
} from "../../src/project/attachments.ts"

class AttachmentSandbox implements Sandbox {
  readonly id = "attachment-sandbox"
  readonly files = new Map<string, Buffer>()
  replaceCalls = 0

  async exec(
    args: string[],
    options?: SandboxExecOptions,
  ): Promise<CommandResult> {
    if (args[0] !== "python3") return { code: 0, stdout: "", stderr: "" }
    const payload = JSON.parse(options?.input ?? "{}") as {
      op: string
      path: string
      base64?: string
    }
    if (payload.op === "read_binary") {
      const content = this.files.get(payload.path)
      return {
        code: 0,
        stdout: JSON.stringify(
          content
            ? { ok: true, value: content.toString("base64") }
            : {
                ok: false,
                code: "not_found",
                message: "not found",
                path: payload.path,
              },
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

  it("附件内容变化时通过原子替换刷新目标文件", async () => {
    const sandbox = new AttachmentSandbox()
    sandbox.files.set("/workspace/attachments/chall", Buffer.from("old"))

    await downloadChallengeAttachments({
      capability: capability(Buffer.from("new")),
      attachments: [{ id: "chall", name: "chall" }],
      sandbox,
    })

    expect(sandbox.replaceCalls).toBe(1)
    expect(sandbox.files.get("/workspace/attachments/chall")?.toString()).toBe(
      "new",
    )
  })
})
