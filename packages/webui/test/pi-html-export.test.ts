import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { exportPiSessionHtml } from "../src/pi-html-export.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe("exportPiSessionHtml", () => {
  it("复用 Pi 的 HTML 导出器读取原生 JSONL 会话", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctf-pi-html-export-"))
    roots.push(root)
    const sessionPath = join(root, "session.jsonl")
    await writeFile(
      sessionPath,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "run-1",
          timestamp: "2026-08-01T00:00:00.000Z",
          cwd: root,
        }),
        JSON.stringify({
          type: "message",
          id: "message-1",
          parentId: null,
          timestamp: "2026-08-01T00:00:01.000Z",
          message: {
            role: "user",
            content: "inspect the binary",
            timestamp: 1_754_006_401_000,
          },
        }),
      ].join("\n"),
    )

    const html = (
      await exportPiSessionHtml(sessionPath, {
        systemPrompt: "Solve the current CTF challenge.",
        tools: [
          {
            name: "ctf_submit_flag",
            description: "Submit the candidate flag.",
            parameters: {
              type: "object",
              properties: { flag: { type: "string" } },
            },
          },
        ],
      })
    ).toString("utf8")
    expect(html).toContain("<!DOCTYPE html>")
    const sessionData =
      /<script id="session-data" type="application\/json">([^<]+)<\/script>/.exec(
        html,
      )?.[1]
    expect(sessionData).toBeDefined()
    if (!sessionData) throw new Error("Pi HTML 导出缺少会话数据")
    expect(
      JSON.parse(Buffer.from(sessionData, "base64").toString("utf8")),
    ).toMatchObject({
      header: { id: "run-1" },
      systemPrompt: "Solve the current CTF challenge.",
      tools: [
        {
          name: "ctf_submit_flag",
          description: "Submit the candidate flag.",
          parameters: {
            type: "object",
            properties: { flag: { type: "string" } },
          },
        },
      ],
      entries: [
        expect.objectContaining({
          id: "message-1",
          message: expect.objectContaining({ content: "inspect the binary" }),
        }),
      ],
    })
  })
})
