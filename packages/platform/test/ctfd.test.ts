import { createServer, type Server } from "node:http"
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test"
import { type CTFdApiError, CTFdClient, CTFdPlatformPlugin, ctfdConfig } from "../src/index.ts"

const TOKEN = "test-token"
let server: Server
let baseUrl: string
const requests: Array<{
  method: string
  url: string
  authorization?: string
  contentType?: string
  body: string
}> = []

beforeAll(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on("data", (chunk) => chunks.push(chunk))
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8")
      requests.push({
        method: request.method ?? "GET",
        url: request.url ?? "/",
        ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}),
        ...(request.headers["content-type"]
          ? { contentType: request.headers["content-type"] }
          : {}),
        body,
      })
      if (
        request.headers.authorization !== `Token ${TOKEN}` ||
        (request.url?.startsWith("/api/") && request.headers["content-type"] !== "application/json")
      ) {
        json(response, 403, { success: false, errors: ["unauthorized"] })
        return
      }
      if (request.method === "GET" && request.url === "/api/v1/challenges") {
        json(response, 200, {
          success: true,
          data: [
            {
              id: 7,
              name: "Evidence",
              category: "Forensics",
              value: 50,
              solved_by_me: false,
            },
          ],
        })
        return
      }
      if (request.method === "GET" && request.url === "/api/v1/challenges/7") {
        json(response, 200, {
          success: true,
          data: {
            id: 7,
            name: "Evidence",
            category: "Forensics",
            value: 50,
            solved_by_me: false,
            description: "Inspect the file",
            connection_info: "nc challenge.example 31337",
            files: ["/files/hash/evidence%20one.bin?token=signed"],
          },
        })
        return
      }
      if (request.method === "GET" && request.url === "/api/v1/notifications") {
        json(response, 200, {
          success: true,
          data: [
            {
              id: 2,
              title: "Notice",
              content: "Hello",
              date: "2026-08-04T00:00:00Z",
            },
          ],
        })
        return
      }
      if (request.method === "GET" && request.url?.startsWith("/files/hash/evidence%20one.bin")) {
        response.writeHead(200, { "Content-Type": "application/octet-stream" })
        response.end(Buffer.from([0, 255, 1]))
        return
      }
      if (request.method === "POST" && request.url === "/api/v1/challenges/attempt") {
        const submission = JSON.parse(body) as {
          challenge_id: number
          submission: string
        }
        json(response, 200, {
          success: true,
          data:
            submission.submission === "FLAG"
              ? { status: "correct", message: "Correct" }
              : { status: "incorrect", message: "Incorrect" },
        })
        return
      }
      if (request.url === "/api/v1/broken") {
        response.writeHead(200, { "Content-Type": "text/html" })
        response.end("login")
        return
      }
      json(response, 404, { success: false, errors: { path: ["not found"] } })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("test server did not bind")
  baseUrl = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
})

describe("CTFd platform plugin", () => {
  it("插件拥有配置校验且只从 secret resolver 获取 token", async () => {
    expect(ctfdConfig.parse({ baseUrl })).toEqual({
      baseUrl,
      tokenSecret: "CTFD_TOKEN",
      timeoutMs: 15_000,
    })
    expect(() => ctfdConfig.parse({ baseUrl, token: "plaintext" })).toThrow("未知字段: token")
    await expect(
      new CTFdPlatformPlugin().connect({
        project: { id: "demo", name: "Demo" },
        config: { baseUrl },
        resolveSecret: () => undefined,
      }),
    ).rejects.toThrow("缺少 CTFd access token secret")
  })

  it("映射题目、通知、附件、连接信息和 Flag 提交", async () => {
    const platform = await connect()
    expect(await platform.getOverview()).toEqual({
      id: "demo",
      name: "Demo",
      challenges: 1,
      announcements: 1,
    })
    expect(await platform.listChallenges()).toEqual([
      {
        id: "7",
        title: "Evidence",
        category: "Forensics",
        score: 50,
        solved: false,
        needsEnv: false,
        hasAttachments: false,
      },
    ])

    const capability = await platform.bindChallenge("7")
    expect(capability.instance).toBeUndefined()
    expect(await capability.getInfo()).toMatchObject({
      id: "7",
      environmentGuide: "nc challenge.example 31337",
      attachments: [{ id: "file-1", name: "evidence one.bin" }],
    })
    expect(await capability.downloadAttachment("file-1")).toEqual({
      attachment: { id: "file-1", name: "evidence one.bin", size: 3 },
      content: new Uint8Array([0, 255, 1]),
    })
    expect(await capability.submitFlag("wrong")).toEqual({
      status: "rejected",
      message: "Incorrect",
    })
    expect(await capability.submitFlag("FLAG")).toEqual({
      status: "accepted",
      message: "Correct",
    })
    expect(requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          authorization: "Token test-token",
          contentType: "application/json",
        }),
        expect.objectContaining({
          method: "POST",
          url: "/api/v1/challenges/attempt",
          body: JSON.stringify({ challenge_id: 7, submission: "FLAG" }),
        }),
      ]),
    )
  })

  it("把 CTFd 错误响应和非 JSON 登录页暴露为结构化错误", async () => {
    const config = ctfdConfig.parse({ baseUrl })
    const unauthorized = new CTFdClient(config, "wrong")
    await expect(unauthorized.get("challenges")).rejects.toMatchObject({
      name: "CTFdApiError",
      kind: "permission",
      status: 403,
    } satisfies Partial<CTFdApiError>)
    const client = new CTFdClient(config, TOKEN)
    await expect(client.get("broken")).rejects.toMatchObject({
      kind: "protocol",
    })
  })
})

describe("CTFd demo live contract", () => {
  it.skipIf(!process.env.CTFD_DEMO_TOKEN)(
    "读取 demo.ctfd.io 题目详情和附件",
    { timeout: 30_000 },
    async () => {
      const platform = await new CTFdPlatformPlugin().connect({
        project: { id: "ctfd-demo", name: "CTFd Demo" },
        config: {
          baseUrl: "https://demo.ctfd.io",
          tokenSecret: "CTFD_DEMO_TOKEN",
        },
        resolveSecret: (name) => process.env[name],
      })
      const challenges = await platform.listChallenges()
      expect(challenges.length).toBeGreaterThan(0)
      const withFile =
        challenges.find((challenge) => challenge.title === "The Lost Park") ?? challenges[0]
      if (!withFile) throw new Error("CTFd demo 未返回题目")
      const capability = await platform.bindChallenge(withFile.id)
      const info = await capability.getInfo()
      expect(info.title).toBe(withFile.title)
      if (info.attachments[0]) {
        const downloaded = await capability.downloadAttachment(info.attachments[0].id)
        expect(downloaded.content.byteLength).toBeGreaterThan(0)
      }
      await platform.close()
    },
  )
})

async function connect() {
  return await new CTFdPlatformPlugin().connect({
    project: { id: "demo", name: "Demo" },
    config: { baseUrl },
    resolveSecret: (name) => (name === "CTFD_TOKEN" ? TOKEN : undefined),
  })
}

function json(response: import("node:http").ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" })
  response.end(JSON.stringify(body))
}
