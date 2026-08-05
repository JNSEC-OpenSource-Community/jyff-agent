import { webcrypto } from "node:crypto"
import { createServer, type Server } from "node:http"
import { afterEach, describe, expect, test } from "vitest"
import {
  encryptGZCTFApiData,
  gzctfConfig,
  gzctfPlatform,
  isRetryablePlatformError,
} from "../src/index.ts"

describe("GZCTF platform config", () => {
  test("uses secret references and rejects plaintext credentials", () => {
    expect(
      gzctfConfig.parse({ baseUrl: "https://gz.example/", gameId: 7 }),
    ).toMatchObject({
      baseUrl: "https://gz.example",
      gameId: 7,
      auth: {
        type: "password",
        usernameSecret: "GZCTF_USERNAME",
        passwordSecret: "GZCTF_PASSWORD",
      },
    })
    expect(() =>
      gzctfConfig.parse({
        baseUrl: "https://gz.example",
        gameId: 7,
        auth: { type: "password", username: "user", password: "secret" },
      }),
    ).toThrow("未知字段")
    expect(() =>
      gzctfConfig.parse({ baseUrl: "file:///tmp/gzctf", gameId: 7 }),
    ).toThrow("http")
  })
})

describe("GZCTF request encryption", () => {
  test("round-trips the wire format used by the official web client", async () => {
    const recipient = (await webcrypto.subtle.generateKey("X25519", true, [
      "deriveBits",
    ])) as webcrypto.CryptoKeyPair
    const publicKey = Buffer.from(
      await webcrypto.subtle.exportKey("raw", recipient.publicKey),
    ).toString("base64")
    const payload = Buffer.from(
      await encryptGZCTFApiData("flag{secret}", publicKey),
      "base64",
    )

    const ephemeral = await webcrypto.subtle.importKey(
      "raw",
      payload.subarray(0, 32),
      "X25519",
      false,
      [],
    )
    const shared = await webcrypto.subtle.deriveBits(
      { name: "X25519", public: ephemeral },
      recipient.privateKey,
      256,
    )
    const keyBytes = await webcrypto.subtle.digest("SHA-256", shared)
    const key = await webcrypto.subtle.importKey(
      "raw",
      keyBytes,
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"],
    )
    const plain = await webcrypto.subtle.decrypt(
      { name: "AES-GCM", iv: payload.subarray(32, 44), tagLength: 128 },
      key,
      payload.subarray(44),
    )

    expect(new TextDecoder().decode(plain)).toBe("flag{secret}")
  })
})

describe("GZCTF platform contract", () => {
  let server: Server | undefined

  afterEach(async () => {
    if (server)
      await new Promise<void>((resolve, reject) =>
        server?.close((error) => (error ? reject(error) : resolve())),
      )
    server = undefined
  })

  test("uses the player cookie for challenges, judgement, attachment and container lifecycle", async () => {
    const requests: Array<{
      method: string
      path: string
      cookie?: string
      body: unknown
    }> = []
    let containerRunning = false
    let statusPolls = 0
    server = createServer(async (request, response) => {
      const bodyText = await new Promise<string>((resolve) => {
        let data = ""
        request.setEncoding("utf8")
        request.on("data", (chunk) => {
          data += chunk
        })
        request.on("end", () => resolve(data))
      })
      const path = request.url ?? "/"
      requests.push({
        method: request.method ?? "GET",
        path,
        ...(request.headers.cookie ? { cookie: request.headers.cookie } : {}),
        body: bodyText ? JSON.parse(bodyText) : undefined,
      })

      if (path === "/api/config")
        return json(response, { title: "Local GZCTF", apiPublicKey: null })
      if (path === "/api/account/login" && request.method === "POST") {
        response.setHeader(
          "Set-Cookie",
          "GZCTF_Token=session-token; Path=/; HttpOnly",
        )
        response.statusCode = 200
        return response.end()
      }
      if (
        path !== "/assets/hash/challenge.zip" &&
        request.headers.cookie !== "GZCTF_Token=session-token"
      ) {
        return json(response, { title: "Unauthorized", status: 401 }, 401)
      }
      if (path === "/api/account/profile") return json(response, { id: "user" })
      if (path === "/api/game/9")
        return json(response, { id: 9, title: "Local Finals" })
      if (path === "/api/game/9/notices?count=100&skip=0") {
        return json(response, [
          {
            id: 1,
            time: 1_700_000_000_000,
            type: "NewHint",
            values: ["web", "hint"],
          },
        ])
      }
      if (path === "/api/game/9/details") {
        return json(response, {
          challenges: {
            web: [{ id: 12, title: "Cookie Jar", category: "Web", score: 500 }],
          },
          challengeCount: 1,
          rank: { solvedChallenges: [] },
          teamToken: "team",
        })
      }
      if (path === "/api/game/9/challenges/12" && request.method === "GET") {
        return json(response, {
          id: 12,
          title: "Cookie Jar",
          category: "Web",
          score: 500,
          content: "Find the flag",
          hints: ["Read cookies"],
          type: "DynamicContainer",
          context: {
            url: "/assets/hash/challenge.zip",
            fileSize: 3,
            ...(containerRunning
              ? {
                  instanceEntry: "https://instance.example",
                  closeTime: Date.now() + 60_000,
                }
              : {}),
          },
        })
      }
      if (path === "/api/game/9/challenges/12" && request.method === "POST")
        return json(response, 77)
      if (path === "/api/game/9/challenges/12/status/77") {
        statusPolls += 1
        return json(response, statusPolls === 1 ? "FlagSubmitted" : "Accepted")
      }
      if (path === "/api/game/9/container/12" && request.method === "POST") {
        containerRunning = true
        return json(response, {
          status: "Running",
          entry: "https://instance.example",
        })
      }
      if (path === "/api/game/9/container/12" && request.method === "DELETE") {
        containerRunning = false
        response.statusCode = 200
        return response.end()
      }
      if (path === "/assets/hash/challenge.zip") {
        response.statusCode = 200
        return response.end("zip")
      }
      return json(response, { title: `Not found: ${path}`, status: 404 }, 404)
    })
    const baseUrl = await listen(server)

    const project = await gzctfPlatform.connect({
      project: { id: "local", name: "Fallback" },
      config: { baseUrl, gameId: 9, submissionPollIntervalMs: 50 },
      resolveSecret: (name) =>
        ({ GZCTF_USERNAME: "alice", GZCTF_PASSWORD: "password" })[name],
    })
    expect(await project.getOverview()).toEqual({
      id: "local",
      name: "Local Finals",
      challenges: 1,
      announcements: 1,
    })
    expect(await project.listChallenges()).toEqual([
      {
        id: "12",
        title: "Cookie Jar",
        category: "Web",
        score: 500,
        solved: false,
      },
    ])
    expect(await project.listAnnouncements()).toEqual([
      {
        id: "1",
        title: "新提示",
        content: "web · hint",
        publishedAt: new Date(1_700_000_000_000).toISOString(),
        kind: "hint",
        rawType: "NewHint",
      },
    ])

    const challenge = await project.bindChallenge("12")
    expect(await challenge.getInfo()).toMatchObject({
      id: "12",
      needsEnv: true,
      description: expect.stringContaining("Read cookies"),
      attachments: [{ id: "attachment", name: "challenge.zip", size: 3 }],
    })
    expect(await challenge.downloadAttachment("attachment")).toMatchObject({
      attachment: { size: 3 },
      content: new Uint8Array(Buffer.from("zip")),
    })
    expect(await challenge.instance?.status()).toBeNull()
    expect(await challenge.instance?.start()).toMatchObject({
      status: "running",
      endpoint: "https://instance.example",
    })
    expect(await project.listRemoteEnvironments()).toHaveLength(1)
    expect(await challenge.submitFlag("flag{right}")).toEqual({
      status: "accepted",
      message: "Accepted",
    })
    await challenge.instance?.destroy()
    await challenge.instance?.destroy()
    expect(await project.listRemoteEnvironments()).toEqual([])

    expect(
      requests.find((item) => item.path === "/api/account/login")?.body,
    ).toEqual({
      userName: "alice",
      password: "password",
    })
    expect(
      requests.find(
        (item) =>
          item.path === "/api/game/9/challenges/12" && item.method === "POST",
      )?.body,
    ).toEqual({ flag: "flag{right}" })
    expect(
      requests
        .filter((item) => item.path.startsWith("/api/game/"))
        .every((item) => item.cookie === "GZCTF_Token=session-token"),
    ).toBe(true)
  })

  test("retries transient GET failures, refreshes expired password auth and coalesces cached reads", async () => {
    const counts = new Map<string, number>()
    let loginCount = 0
    let rejectGameOnce = true
    let detailFailures = 2
    server = createServer((request, response) => {
      const path = request.url ?? "/"
      counts.set(path, (counts.get(path) ?? 0) + 1)
      if (path === "/api/config")
        return json(response, { title: "Local", apiPublicKey: null })
      if (path === "/api/account/login") {
        loginCount++
        response.setHeader(
          "Set-Cookie",
          `GZCTF_Token=session-${loginCount}; Path=/; HttpOnly`,
        )
        response.statusCode = 200
        return response.end()
      }
      if (path === "/api/account/profile") return json(response, { id: "user" })
      if (path === "/api/game/9" && rejectGameOnce) {
        rejectGameOnce = false
        return json(response, { title: "Expired" }, 401)
      }
      if (path === "/api/game/9")
        return json(response, { id: 9, title: "Retry Finals" })
      if (path === "/api/game/9/details") {
        if (detailFailures-- > 0)
          return json(response, { title: "Temporary gateway error" }, 502)
        return json(response, {
          challenges: {
            web: [{ id: 12, title: "Cache", category: "Web", score: 500 }],
          },
          rank: { solvedChallenges: [] },
        })
      }
      if (path === "/api/game/9/notices?count=100&skip=0")
        return json(response, [])
      if (path === "/api/game/9/challenges/12")
        return json(response, {
          id: 12,
          title: "Cache",
          category: "Web",
          score: 500,
          type: "StaticAttachment",
          content: "test",
        })
      return json(response, { title: `Not found: ${path}` }, 404)
    })
    const baseUrl = await listen(server)
    const project = await gzctfPlatform.connect({
      project: { id: "retry", name: "Retry" },
      config: {
        baseUrl,
        gameId: 9,
        maxRequestAttempts: 3,
        retryBaseDelayMs: 1,
        cacheTtlMs: 250,
      },
      resolveSecret: (name) =>
        ({ GZCTF_USERNAME: "alice", GZCTF_PASSWORD: "password" })[name],
    })

    const [overview, challenges, announcements] = await Promise.all([
      project.getOverview(),
      project.listChallenges(),
      project.listAnnouncements(),
    ])
    expect(overview.name).toBe("Retry Finals")
    expect(challenges).toHaveLength(1)
    expect(announcements).toEqual([])
    expect(loginCount).toBe(2)
    expect(counts.get("/api/game/9/details")).toBe(3)
    expect(counts.get("/api/game/9/notices?count=100&skip=0")).toBe(1)

    await Promise.all([
      project.bindChallenge("12"),
      project.bindChallenge("12"),
    ])
    expect(counts.get("/api/game/9/challenges/12")).toBe(1)
    expect(counts.get("/api/game/9/details")).toBe(3)

    const transient = Object.assign(new Error("gateway"), { retryable: true })
    expect(isRetryablePlatformError(transient)).toBe(true)
  })

  test.runIf(process.env.GZCTF_LIVE === "1")(
    "matches gz.imxbt.cn public API shape",
    async () => {
      const [config, games] = await Promise.all([
        fetch("https://gz.imxbt.cn/api/config").then((response) =>
          response.json(),
        ) as Promise<{ apiPublicKey?: string }>,
        fetch("https://gz.imxbt.cn/api/game?count=1&skip=0").then((response) =>
          response.json(),
        ) as Promise<{ data?: unknown[] }>,
      ])
      expect(config.apiPublicKey).toBeTypeOf("string")
      expect(games.data).toBeInstanceOf(Array)
    },
  )
})

function json(
  response: import("node:http").ServerResponse,
  body: unknown,
  status = 200,
): void {
  response.statusCode = status
  response.setHeader("Content-Type", "application/json")
  response.end(JSON.stringify(body))
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string")
    throw new Error("测试服务器未监听 TCP 端口")
  return `http://127.0.0.1:${address.port}`
}
