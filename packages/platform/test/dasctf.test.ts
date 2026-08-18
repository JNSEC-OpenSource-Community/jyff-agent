import { createServer, type Server } from "node:http"
import { afterEach, describe, expect, it } from "vite-plus/test"
import {
  DASCTFClient,
  DASCTFPlatformPlugin,
  dasctfConfig,
  dasctfPlatform,
  isRetryablePlatformError,
} from "../src/index.ts"

const ACCESS_KEY = "test-agent-access-key"
const API_PREFIX = "/slab-match/api/v1/agent/"

describe("DASCTF platform config", () => {
  it("只保存 secret 引用并拒绝明文凭据和带路径的站点 URL", () => {
    expect(dasctfConfig.parse({ baseUrl: "https://pro.dasctf.com/" })).toMatchObject({
      baseUrl: "https://pro.dasctf.com",
      accessKeySecret: "DASCTF_ACCESS_KEY",
      cacheTtlMs: 30_000,
      environmentPollIntervalMs: 3_000,
    })
    expect(() =>
      dasctfConfig.parse({ baseUrl: "https://pro.dasctf.com", accessKey: "plaintext" }),
    ).toThrow("未知字段")
    expect(() => dasctfConfig.parse({ baseUrl: "https://pro.dasctf.com/login" })).toThrow("根地址")
  })
})

describe("DASCTF platform contract", () => {
  let server: Server | undefined

  afterEach(async () => {
    server?.closeAllConnections()
    if (server) {
      await new Promise<void>((resolve, reject) =>
        server?.close((error) => (error ? reject(error) : resolve())),
      )
    }
    server = undefined
  })

  it("以有限请求完成题目、公告、附件、Flag 与远程环境全生命周期", async () => {
    const counts = new Map<string, number>()
    const requests: Array<{ method: string; path: string; accessKey?: string; body?: unknown }> = []
    let environmentState: "absent" | "building" | "running" = "absent"
    let buildPolls = 0
    let baseUrl = ""

    server = createServer(async (request, response) => {
      const path = request.url ?? "/"
      const bodyText = await requestBody(request)
      requests.push({
        method: request.method ?? "GET",
        path,
        ...(request.headers["x-agent-accesskey"]
          ? { accessKey: String(request.headers["x-agent-accesskey"]) }
          : {}),
        ...(bodyText ? { body: JSON.parse(bodyText) } : {}),
      })
      counts.set(path, (counts.get(path) ?? 0) + 1)

      if (path === "/attachment.zip") {
        response.statusCode = 200
        return response.end("zip")
      }
      if (!path.startsWith(API_PREFIX)) {
        response.statusCode = 404
        return response.end()
      }
      if (request.headers["x-agent-accesskey"] !== ACCESS_KEY) {
        return envelope(response, undefined, "A0401", "AccessKey 无效", 401)
      }
      if (path === `${API_PREFIX}ctf/exercise-list`) {
        return envelope(response, [
          {
            id: 10,
            name: "Web",
            corpus: [
              { id: 1001, name: "easy-web", isOpen: true, hasSolved: false },
              { id: 1002, name: "closed", isOpen: false, hasSolved: false },
            ],
          },
        ])
      }
      if (path === `${API_PREFIX}match/notice/now-list`) {
        return envelope(response, [
          {
            id: 501,
            title: "公告",
            content: "环境维护完成",
            createdTime: 1_780_000_000_000,
            userName: "系统",
          },
        ])
      }
      if (path === `${API_PREFIX}ctf/exercise?exerciseId=1001`) {
        if (environmentState === "building") {
          buildPolls++
          if (buildPolls >= 2) environmentState = "running"
        }
        return envelope(response, exerciseDetail(baseUrl, environmentState))
      }
      if (path === `${API_PREFIX}ctf/build-exercise-env` && request.method === "POST") {
        environmentState = "building"
        buildPolls = 0
        return envelope(response, {})
      }
      if (path === `${API_PREFIX}ctf/recover-exercise-env` && request.method === "POST") {
        environmentState = "absent"
        return envelope(response, {})
      }
      if (path === `${API_PREFIX}answer-panel/answer` && request.method === "POST") {
        const flag = (JSON.parse(bodyText) as { flag: string }).flag
        return flag === "flag{right}"
          ? envelope(response, { isCorrect: true })
          : envelope(response, undefined, "B0400", "答案错误")
      }
      return envelope(response, undefined, "A0404", "不存在", 404)
    })
    baseUrl = await listen(server)

    const project = await dasctfPlatform.connect({
      project: { id: "dasctf-local", name: "DASCTF Local" },
      config: {
        baseUrl,
        minRequestIntervalMs: 1,
        environmentPollIntervalMs: 100,
        environmentMaxPollIntervalMs: 200,
        environmentReadyTimeoutMs: 2_000,
      },
      resolveSecret: (name) => (name === "DASCTF_ACCESS_KEY" ? ACCESS_KEY : undefined),
    })

    const [overview, challenges, announcements] = await Promise.all([
      project.getOverview(),
      project.listChallenges(),
      project.listAnnouncements(),
    ])
    expect(overview).toEqual({
      id: "dasctf-local",
      name: "DASCTF Local",
      challenges: 1,
      announcements: 1,
    })
    expect(challenges).toEqual([
      {
        id: "1001",
        title: "easy-web",
        category: "Web",
        score: 0,
        solved: false,
      },
    ])
    expect(announcements).toEqual([
      {
        id: "501",
        title: "公告",
        content: "环境维护完成",
        publishedAt: new Date(1_780_000_000_000).toISOString(),
        kind: "normal",
        rawType: "系统",
      },
    ])
    expect(counts.get(`${API_PREFIX}ctf/exercise-list`)).toBe(1)
    expect(counts.get(`${API_PREFIX}match/notice/now-list`)).toBe(1)

    const challenge = await project.bindChallenge("1001")
    expect(await challenge.getInfo()).toMatchObject({
      id: "1001",
      title: "easy-web",
      score: 100,
      needsEnv: true,
      hasAttachments: true,
      attachments: [{ id: "attachment-1", name: "attachment.zip" }],
      description: expect.stringContaining(
        "call `ctf_submit_flag` with `abc`, not the wrapped value",
      ),
    })
    expect(await challenge.submitFlag("wrong")).toEqual({
      status: "rejected",
      message: "答案错误",
    })
    expect(await challenge.submitFlag("flag{right}")).toEqual({
      status: "accepted",
      message: "Accepted",
    })

    const started = await challenge.instance?.start()
    expect(started).toMatchObject({ id: "dasctf:1001", status: "starting" })
    const ready = await challenge.instance?.waitUntilReady?.(started as NonNullable<typeof started>)
    expect(ready).toMatchObject({
      id: "dasctf:1001",
      status: "running",
      endpoint: expect.stringMatching(/^127\.0\.0\.1:\d+$/),
      readyAt: expect.any(String),
    })
    const detailPath = `${API_PREFIX}ctf/exercise?exerciseId=1001`
    const detailRequestsBeforeStatus = counts.get(detailPath) ?? 0
    const statuses = await Promise.all([challenge.instance?.status(), challenge.instance?.status()])
    expect(statuses).toEqual([
      expect.objectContaining({ status: "running" }),
      expect.objectContaining({ status: "running" }),
    ])
    expect((counts.get(detailPath) ?? 0) - detailRequestsBeforeStatus).toBe(1)
    expect(await project.listRemoteEnvironments()).toHaveLength(1)

    expect(await challenge.downloadAttachment("attachment-1")).toEqual({
      attachment: { id: "attachment-1", name: "attachment.zip", size: 3 },
      content: new Uint8Array(Buffer.from("zip")),
    })
    await challenge.instance?.destroy()
    await challenge.instance?.destroy()
    await expect(challenge.instance?.status()).resolves.toBeNull()
    expect(await project.listRemoteEnvironments()).toEqual([])

    expect(
      requests.filter((item) => item.path === `${API_PREFIX}ctf/build-exercise-env`),
    ).toHaveLength(1)
    expect(
      requests.filter((item) => item.path === `${API_PREFIX}ctf/recover-exercise-env`),
    ).toHaveLength(1)
    expect(
      requests
        .filter((item) => item.path.startsWith(API_PREFIX))
        .every((item) => item.accessKey === ACCESS_KEY),
    ).toBe(true)
    expect(
      requests.find((item) => item.path === `${API_PREFIX}ctf/build-exercise-env`)?.body,
    ).toEqual({ exerciseId: 1001 })
    expect(requests.find((item) => item.path === "/attachment.zip")?.accessKey).toBe(ACCESS_KEY)
    await project.close()
  })

  it("兼容 Pro 服务实际返回的单对象附件并下载资源", async () => {
    let baseUrl = ""
    server = createServer((request, response) => {
      const path = request.url ?? "/"
      if (path === `${API_PREFIX}ctf/exercise?exerciseId=1002`) {
        return envelope(response, {
          id: 1002,
          name: "production-attachment",
          description: "Actual DASCTF Pro attachment shape",
          score: "50",
          attachment: {
            key: "object-key",
            signature: "signature",
            url: `${baseUrl}/resource/oss/object.zip`,
            name: "production.zip",
            previewUrl: `${baseUrl}/resource/preview/object.zip`,
            extension: "zip",
          },
          isNeedInit: false,
          isNeedCheck: false,
        })
      }
      if (path === "/resource/oss/object.zip") {
        response.statusCode = 200
        response.setHeader("Content-Type", "application/zip")
        return response.end("zip")
      }
      return envelope(response, undefined, "A0404", "不存在", 404)
    })
    baseUrl = await listen(server)
    const project = await dasctfPlatform.connect({
      project: { id: "production-attachment", name: "Production attachment" },
      config: { baseUrl, minRequestIntervalMs: 1 },
      resolveSecret: () => ACCESS_KEY,
    })

    const challenge = await project.bindChallenge("1002")
    await expect(challenge.getInfo()).resolves.toMatchObject({
      attachments: [{ id: "attachment-1", name: "production.zip" }],
      hasAttachments: true,
    })
    await expect(challenge.downloadAttachment("attachment-1")).resolves.toEqual({
      attachment: { id: "attachment-1", name: "production.zip", size: 3 },
      content: new Uint8Array(Buffer.from("zip")),
    })
    await project.close()
  })

  it("build 响应丢失时只读状态并复用已创建环境，不重复非幂等 POST", async () => {
    let environmentRunning = false
    let buildRequests = 0
    let baseUrl = ""
    server = createServer((request, response) => {
      const path = request.url ?? "/"
      if (path === `${API_PREFIX}ctf/exercise?exerciseId=1001`) {
        return envelope(
          response,
          exerciseDetail(baseUrl, environmentRunning ? "running" : "absent"),
        )
      }
      if (path === `${API_PREFIX}ctf/build-exercise-env`) {
        buildRequests++
        environmentRunning = true
        response.writeHead(200, { "Content-Type": "application/json" })
        return response.end("{")
      }
      if (path === `${API_PREFIX}ctf/recover-exercise-env`) {
        environmentRunning = false
        return envelope(response, {})
      }
      return envelope(response, undefined, "A0404", "不存在", 404)
    })
    baseUrl = await listen(server)
    const project = await dasctfPlatform.connect({
      project: { id: "ambiguous-post", name: "Ambiguous POST" },
      config: { baseUrl, minRequestIntervalMs: 1 },
      resolveSecret: () => ACCESS_KEY,
    })
    const challenge = await project.bindChallenge("1001")

    await expect(challenge.instance?.start()).resolves.toMatchObject({
      id: "dasctf:1001",
      status: "running",
    })
    expect(buildRequests).toBe(1)
    await challenge.instance?.destroy()
    await project.close()
  })

  it("build 结果不确定且详情暂时仍 absent 时，补偿 destroy 仍调用 recover", async () => {
    let detailRequests = 0
    let recoverRequests = 0
    let baseUrl = ""
    server = createServer((request, response) => {
      const path = request.url ?? "/"
      if (path === `${API_PREFIX}ctf/exercise?exerciseId=1001`) {
        detailRequests++
        return envelope(response, exerciseDetail(baseUrl, "absent"))
      }
      if (path === `${API_PREFIX}ctf/build-exercise-env`) {
        response.writeHead(200, { "Content-Type": "application/json" })
        return response.end("{")
      }
      if (path === `${API_PREFIX}ctf/recover-exercise-env`) {
        recoverRequests++
        return envelope(response, {})
      }
      return envelope(response, undefined, "A0404", "不存在", 404)
    })
    baseUrl = await listen(server)
    const project = await dasctfPlatform.connect({
      project: { id: "uncertain-cleanup", name: "Uncertain cleanup" },
      config: { baseUrl, minRequestIntervalMs: 1 },
      resolveSecret: () => ACCESS_KEY,
    })
    const challenge = await project.bindChallenge("1001")

    await expect(challenge.instance?.start()).rejects.toMatchObject({ kind: "protocol" })
    expect(detailRequests).toBe(2)
    await challenge.instance?.destroy()
    expect(recoverRequests).toBe(1)
    await project.close()
  })

  it("环境启动请求挂起时，平台快照读取仍可独立完成并可由调用方取消", async () => {
    let buildStarted!: () => void
    const buildReceived = new Promise<void>((resolve) => {
      buildStarted = resolve
    })
    server = createServer((request, response) => {
      const path = request.url ?? "/"
      if (path === `${API_PREFIX}ctf/exercise?exerciseId=1001`) {
        return envelope(response, exerciseDetail("http://127.0.0.1", "absent"))
      }
      if (path === `${API_PREFIX}ctf/build-exercise-env`) {
        buildStarted()
        response.writeHead(200, { "Content-Type": "application/json" })
        response.write("{")
        return
      }
      if (path === `${API_PREFIX}ctf/exercise-list`) {
        return envelope(response, [
          { id: 10, name: "Web", corpus: [{ id: 1001, name: "easy-web", isOpen: true }] },
        ])
      }
      if (path === `${API_PREFIX}match/notice/now-list`) return envelope(response, [])
      return envelope(response, undefined, "A0404", "不存在", 404)
    })
    const baseUrl = await listen(server)
    const project = await dasctfPlatform.connect({
      project: { id: "non-blocking", name: "Non-blocking" },
      config: { baseUrl, minRequestIntervalMs: 1, timeoutMs: 5_000 },
      resolveSecret: () => ACCESS_KEY,
    })
    const challenge = await project.bindChallenge("1001")
    const controller = new AbortController()
    const starting = challenge.instance?.start(controller.signal)
    await buildReceived

    await expect(project.getOverview()).resolves.toMatchObject({ challenges: 1, announcements: 0 })
    controller.abort()
    await expect(starting).rejects.toMatchObject({ name: "AbortError" })
    await project.close()
  })

  it("保留 429 的可重试语义和 Retry-After，并脱敏上游回显的 AccessKey", async () => {
    server = createServer((_request, response) => {
      response.setHeader("Retry-After", "2")
      envelope(response, undefined, "R0429", `AccessKey ${ACCESS_KEY} 请求过于频繁`, 429)
    })
    const baseUrl = await listen(server)
    const config = dasctfConfig.parse({ baseUrl, minRequestIntervalMs: 1 })
    const client = new DASCTFClient(config, ACCESS_KEY)

    const error = await client.get("ctf/exercise-list").catch((caught: unknown) => caught)
    expect(error).toMatchObject({
      name: "DASCTFApiError",
      kind: "rate_limited",
      retryable: true,
      retryAfterMs: 2_000,
    })
    expect(isRetryablePlatformError(error)).toBe(true)
    expect(String(error)).not.toContain(ACCESS_KEY)
    expect(String(error)).toContain("[redacted]")
  })

  it("对同一 Project 的并发 Agent API 调用按最小间隔排队", async () => {
    const requestTimes: number[] = []
    server = createServer((request, response) => {
      requestTimes.push(Date.now())
      envelope(response, { path: request.url })
    })
    const baseUrl = await listen(server)
    const client = new DASCTFClient(
      dasctfConfig.parse({ baseUrl, minRequestIntervalMs: 50 }),
      ACCESS_KEY,
    )

    await Promise.all([client.get("first"), client.get("second"), client.get("third")])
    expect(requestTimes).toHaveLength(3)
    expect(requestTimes[1]! - requestTimes[0]!).toBeGreaterThanOrEqual(35)
    expect(requestTimes[2]! - requestTimes[1]!).toBeGreaterThanOrEqual(35)
  })

  it("非 JSON 的 429 和 503 仍按 HTTP 状态保留可重试语义", async () => {
    let status = 429
    server = createServer((_request, response) => {
      response.statusCode = status
      response.setHeader("Content-Type", "text/plain")
      response.setHeader("Retry-After", "1")
      response.end(status === 429 ? "too many requests" : "gateway unavailable")
    })
    const baseUrl = await listen(server)
    const client = new DASCTFClient(
      dasctfConfig.parse({ baseUrl, minRequestIntervalMs: 1 }),
      ACCESS_KEY,
    )

    await expect(client.get("ctf/exercise-list")).rejects.toMatchObject({
      kind: "rate_limited",
      retryable: true,
      retryAfterMs: 1_000,
    })
    status = 503
    await expect(client.get("ctf/exercise-list")).rejects.toMatchObject({
      kind: "http",
      retryable: true,
    })
  })
})

describe("DASCTF live contract", () => {
  it.skipIf(!process.env.DASCTF_ACCESS_KEY)(
    "以最少只读请求校验 pro.dasctf.com API",
    { timeout: 60_000 },
    async () => {
      const project = await new DASCTFPlatformPlugin().connect({
        project: { id: "dasctf-live", name: "DASCTF Pro" },
        config: { baseUrl: "https://pro.dasctf.com" },
        resolveSecret: (name) => process.env[name],
      })
      const [challenges, announcements] = await Promise.all([
        project.listChallenges(),
        project.listAnnouncements(),
      ])
      expect(challenges.length).toBeGreaterThan(0)
      expect(announcements).toBeInstanceOf(Array)
      const selected = challenges[0]
      if (!selected) throw new Error("DASCTF 未返回开放题目")
      const capability = await project.bindChallenge(selected.id)
      expect((await capability.getInfo()).id).toBe(selected.id)
      await project.close()
    },
  )

  it.skipIf(!process.env.DASCTF_ACCESS_KEY || !process.env.DASCTF_ATTACHMENT_CHALLENGE_ID)(
    "下载指定真实题目的附件",
    { timeout: 60_000 },
    async () => {
      const project = await new DASCTFPlatformPlugin().connect({
        project: { id: "dasctf-live-attachment", name: "DASCTF Pro" },
        config: { baseUrl: "https://pro.dasctf.com" },
        resolveSecret: (name) => process.env[name],
      })
      try {
        const capability = await project.bindChallenge(
          process.env.DASCTF_ATTACHMENT_CHALLENGE_ID as string,
        )
        const info = await capability.getInfo()
        const attachment = info.attachments[0]
        if (!attachment) throw new Error("指定题目未返回附件")
        const downloaded = await capability.downloadAttachment(attachment.id)
        expect(downloaded.attachment.name).toBe(attachment.name)
        expect(downloaded.content.byteLength).toBeGreaterThan(0)
      } finally {
        await project.close()
      }
    },
  )

  it.skipIf(
    !process.env.DASCTF_ACCESS_KEY ||
      !process.env.DASCTF_SUBMISSION_CHALLENGE_ID ||
      !process.env.DASCTF_SUBMISSION_FLAG,
  )("提交经显式授权的真实 Flag 并映射成功状态", { timeout: 60_000 }, async () => {
    const project = await new DASCTFPlatformPlugin().connect({
      project: { id: "dasctf-live-submit", name: "DASCTF Pro" },
      config: { baseUrl: "https://pro.dasctf.com" },
      resolveSecret: (name) => process.env[name],
    })
    try {
      const capability = await project.bindChallenge(
        process.env.DASCTF_SUBMISSION_CHALLENGE_ID as string,
      )
      await expect(
        capability.submitFlag(process.env.DASCTF_SUBMISSION_FLAG as string),
      ).resolves.toEqual({
        status: "accepted",
        message: expect.any(String),
      })
    } finally {
      await project.close()
    }
  })

  it.skipIf(!process.env.DASCTF_ACCESS_KEY || !process.env.DASCTF_FULL_FLOW_CHALLENGE_ID)(
    "执行指定带附件题目的只读下载和远程环境全流程",
    { timeout: 5 * 60_000 },
    async () => {
      const project = await new DASCTFPlatformPlugin().connect({
        project: { id: "dasctf-live-full-flow", name: "DASCTF Pro" },
        config: { baseUrl: "https://pro.dasctf.com" },
        resolveSecret: (name) => process.env[name],
      })
      let capability: Awaited<ReturnType<typeof project.bindChallenge>> | undefined
      try {
        const [overview, challenges, announcements] = await Promise.all([
          project.getOverview(),
          project.listChallenges(),
          project.listAnnouncements(),
        ])
        expect(overview.challenges).toBe(challenges.length)
        expect(announcements).toBeInstanceOf(Array)

        const challengeId = process.env.DASCTF_FULL_FLOW_CHALLENGE_ID as string
        expect(challenges.some((challenge) => challenge.id === challengeId)).toBe(true)
        capability = await project.bindChallenge(challengeId)
        const info = await capability.getInfo()
        expect(info.id).toBe(challengeId)
        const attachment = info.attachments[0]
        if (!attachment) throw new Error("指定全流程题目未返回附件")
        const downloaded = await capability.downloadAttachment(attachment.id)
        expect(downloaded.content.byteLength).toBeGreaterThan(0)

        if (!capability.instance) throw new Error("指定全流程题目没有远程环境能力")
        const started = await capability.instance.start()
        const ready = capability.instance.waitUntilReady
          ? await capability.instance.waitUntilReady(started)
          : started
        expect(ready.status).toBe("running")
        expect(ready.endpoint).toBeTruthy()
        await expect(capability.instance.status()).resolves.toMatchObject({ status: "running" })
      } finally {
        await capability?.instance?.destroy().catch(() => undefined)
        await project.close()
      }
    },
  )

  it.skipIf(!process.env.DASCTF_ACCESS_KEY || !process.env.DASCTF_ENV_CHALLENGE_ID)(
    "启动、确认并回收指定远程环境",
    { timeout: 5 * 60_000 },
    async () => {
      const project = await new DASCTFPlatformPlugin().connect({
        project: { id: "dasctf-live-env", name: "DASCTF Pro" },
        config: { baseUrl: "https://pro.dasctf.com" },
        resolveSecret: (name) => process.env[name],
      })
      const capability = await project.bindChallenge(process.env.DASCTF_ENV_CHALLENGE_ID as string)
      try {
        if (!capability.instance) throw new Error("指定题目没有远程环境能力")
        const started = await capability.instance.start()
        const ready = capability.instance.waitUntilReady
          ? await capability.instance.waitUntilReady(started)
          : started
        expect(ready.status).toBe("running")
        expect(ready.endpoint).toBeTruthy()
        await expect(capability.instance.status()).resolves.toMatchObject({ status: "running" })
      } finally {
        await capability.instance?.destroy().catch(() => undefined)
        await project.close()
      }
    },
  )
})

function exerciseDetail(baseUrl: string, environmentState: "absent" | "building" | "running") {
  const port = Number(new URL(baseUrl).port)
  return {
    id: 1001,
    name: "easy-web",
    description: "Find the flag",
    hasSolved: false,
    score: "100",
    difficulty: "EASY",
    attachment: {
      files: [{ name: "attachment.zip", url: `${baseUrl}/attachment.zip`, ext: "zip" }],
    },
    endpoints:
      environmentState === "running"
        ? [
            {
              exposeIps: ["10.0.0.10"],
              ports: ["80"],
              users: [{ username: "root", password: "password" }],
              portMappings: [{ type: "tcp", port: "80", proxy: String(port) }],
              proxyIps: ["127.0.0.1"],
              isProxy: true,
              expireTime: Date.now() + 60_000,
            },
          ]
        : [],
    isNeedInit: environmentState === "absent",
    endpointType: "monopoly",
    currentTime: Date.now(),
    isNeedCheck: environmentState === "building",
  }
}

function envelope(
  response: import("node:http").ServerResponse,
  data: unknown,
  code = "00000",
  message = "",
  status = 200,
): void {
  response.statusCode = status
  response.setHeader("Content-Type", "application/json")
  response.end(JSON.stringify({ code, message, data }))
}

async function requestBody(request: import("node:http").IncomingMessage): Promise<string> {
  return await new Promise<string>((resolve) => {
    let body = ""
    request.setEncoding("utf8")
    request.on("data", (chunk) => {
      body += chunk
    })
    request.on("end", () => resolve(body))
  })
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("测试服务器未监听 TCP 端口")
  return `http://127.0.0.1:${address.port}`
}
