import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  exportPiSessionHtml,
  piSessionHasConversation,
  readPiSessionConversation,
} from "../src/pi-html-export.ts"

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
        JSON.stringify({
          type: "message",
          id: "message-2",
          parentId: "message-1",
          timestamp: "2026-08-01T00:00:02.000Z",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "ELF header confirmed" }],
            api: "openai-completions",
            provider: "test",
            model: "test-model",
            usage: {
              input: 10,
              output: 4,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 14,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
            stopReason: "stop",
            timestamp: 1_754_006_402_000,
          },
        }),
      ].join("\n"),
    )

    await expect(piSessionHasConversation(sessionPath)).resolves.toBe(true)
    expect(readPiSessionConversation(sessionPath)).toMatchObject({
      messages: [
        {
          entryId: "message-1",
          message: { role: "user", content: "inspect the binary" },
        },
        {
          entryId: "message-2",
          message: { role: "assistant" },
        },
      ],
    })

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
        expect.objectContaining({
          id: "message-2",
          message: expect.objectContaining({ role: "assistant" }),
        }),
      ],
    })
  })

  it("只有初始 user 数据的 session 尚未产生 Agent 对话", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctf-pi-html-empty-"))
    roots.push(root)
    const sessionPath = join(root, "session.jsonl")
    await writeFile(
      sessionPath,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "empty-run",
          timestamp: "2026-08-01T00:00:00.000Z",
          cwd: root,
        }),
        JSON.stringify({
          type: "message",
          id: "challenge-context",
          parentId: null,
          timestamp: "2026-08-01T00:00:01.000Z",
          message: {
            role: "user",
            content: "<challenge_context />",
            timestamp: 1_754_006_401_000,
          },
        }),
      ].join("\n"),
    )

    await expect(piSessionHasConversation(sessionPath)).resolves.toBe(false)
  })

  it("结构化对话只返回当前分支，不混入已放弃分支", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctf-pi-conversation-"))
    roots.push(root)
    const sessionPath = join(root, "session.jsonl")
    await writeFile(
      sessionPath,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "branched-run",
          timestamp: "2026-08-01T00:00:00.000Z",
          cwd: root,
        }),
        JSON.stringify({
          type: "message",
          id: "root",
          parentId: null,
          timestamp: "2026-08-01T00:00:01.000Z",
          message: { role: "user", content: "start", timestamp: 1 },
        }),
        JSON.stringify({
          type: "message",
          id: "abandoned",
          parentId: "root",
          timestamp: "2026-08-01T00:00:02.000Z",
          message: { role: "user", content: "old branch", timestamp: 2 },
        }),
        JSON.stringify({
          type: "message",
          id: "active",
          parentId: "root",
          timestamp: "2026-08-01T00:00:03.000Z",
          message: { role: "user", content: "new branch", timestamp: 3 },
        }),
      ].join("\n"),
    )

    expect(
      readPiSessionConversation(sessionPath).messages.map(
        (message) => message.entryId,
      ),
    ).toEqual(["root", "active"])
  })
})
