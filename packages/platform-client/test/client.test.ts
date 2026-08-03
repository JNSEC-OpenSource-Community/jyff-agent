import { describe, expect, it, beforeAll, afterAll } from "vitest"
import { createServer, type Server, type ServerResponse } from "node:http"
import { type AddressInfo } from "node:net"
import { remotePlatform } from "../src/index.ts"

const CHALLENGES = [
  { id: "misc-ez-png", title: "ez_png", category: "Misc", score: 100, solved: false, needsEnv: false },
  { id: "pwn-boom", title: "boom", category: "Pwn", score: 100, solved: false, needsEnv: true },
]
const INFO: Record<string, {
  id: string; title: string; category: string; score: number
  description: string; attachments: { id: string; name: string; size: number }[]
  environmentGuide?: string
}> = {
  "misc-ez-png": { id: "misc-ez-png", title: "ez_png", category: "Misc", score: 100,
    description: "png 隐写", attachments: [{ id: "ez_png.png", name: "ez_png.png", size: 5 }] },
  "pwn-boom": { id: "pwn-boom", title: "boom", category: "Pwn", score: 100,
    description: "xinetd 服务", attachments: [], environmentGuide: "申请后连接 endpoint,flag 在 /flag.txt" },
}
const ATTACH_BYTES = new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f]) // "hello"
const flags = new Map<string, string>([["misc-ez-png", "moectf{stub_exact}"]])
let instances = new Map<string, { id: string; challengeId: string; status: string; endpoint: string }>()
let nextId = 1
let destroy404s = 0 // 计数:destroy 路由 404 响应次数(锁定客户端幂等吞 404 分支真实执行)

const EXPECTED_TOKEN = "test-token"
let server: Server
let baseUrl = ""

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" })
  res.end(JSON.stringify(body))
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const auth = req.headers.authorization
    if (auth !== `Bearer ${EXPECTED_TOKEN}`) { sendJson(res, 401, { error: "unauthorized", message: "bad token" }); return }
    const url = new URL(req.url ?? "/", "http://localhost")
    const seg = url.pathname.split("/").filter(Boolean)
    if (req.method === "GET" && seg[0] === "challenges" && seg.length === 1) {
      sendJson(res, 200, CHALLENGES); return
    }
    if (req.method === "GET" && seg[0] === "challenges" && seg.length === 2) {
      const info = INFO[seg[1]!]
      if (!info) { sendJson(res, 404, { error: "not_found", message: "unknown challenge" }); return }
      sendJson(res, 200, info); return
    }
    if (req.method === "GET" && seg[0] === "challenges" && seg[2] === "attachments") {
      const info = INFO[seg[1]!]
      const file = info?.attachments.find((a) => a.name === decodeURIComponent(seg[3]!))
      if (!info || !file) { sendJson(res, 404, { error: "not_found", message: "unknown attachment" }); return }
      res.writeHead(200, { "Content-Type": "application/octet-stream" })
      res.end(Buffer.from(ATTACH_BYTES)); return
    }
    if (req.method === "POST" && seg[0] === "challenges" && seg[2] === "flag") {
      let body = ""
      req.on("data", (c) => (body += c))
      req.on("end", () => {
        const { flag } = JSON.parse(body) as { flag: string }
        if (flags.get(seg[1]!) === flag) sendJson(res, 200, { status: "accepted", message: "ok" })
        else sendJson(res, 200, { status: "rejected", message: "bad flag" })
      })
      return
    }
    if (req.method === "POST" && seg[0] === "challenges" && seg[2] === "instance") {
      const id = `inst-${nextId++}`
      const record = { id, challengeId: seg[1]!, status: "running", endpoint: `tcp://127.0.0.1:25002` }
      instances.set(id, record)
      sendJson(res, 200, { ...record, expiresAt: "2026-08-02T00:00:00.000Z" }); return
    }
    if (req.method === "GET" && seg[0] === "instances" && seg.length === 1) {
      sendJson(res, 200, [...instances.values()]); return
    }
    if (req.method === "GET" && seg[0] === "instances" && seg.length === 2) {
      const inst = instances.get(seg[1]!)
      if (!inst) { sendJson(res, 404, { error: "not_found", message: "unknown instance" }); return }
      sendJson(res, 200, inst); return
    }
    if (req.method === "POST" && seg[0] === "instances" && seg[2] === "destroy") {
      const id = seg[1]!
      if (!instances.has(id)) { destroy404s++; sendJson(res, 404, { error: "not_found", message: "unknown instance" }); return }
      instances.delete(id)
      sendJson(res, 200, { ok: true }); return
    }
    sendJson(res, 404, { error: "not_found", message: "no route" })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => { await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve())) })

function connect() {
  return remotePlatform.connect({ eventId: "test-event", config: { baseUrl, token: EXPECTED_TOKEN } })
}

describe("RemotePlatformPlugin 契约", () => {
  it("listChallenges 映射字段并携带 Bearer token", async () => {
    const project = await connect()
    const list = await project.listChallenges()
    expect(list).toEqual(CHALLENGES)
  })

  it("listChallenges 透传 needsEnv", async () => {
    const project = await connect()
    const list = await project.listChallenges()
    expect(list.find((c) => c.id === "pwn-boom")?.needsEnv).toBe(true)
    expect(list.find((c) => c.id === "misc-ez-png")?.needsEnv).toBe(false)
  })

  it("bindChallenge 预校验:未知题目抛 Error(含服务器 message)", async () => {
    const project = await connect()
    await expect(project.bindChallenge("nope")).rejects.toThrow(/unknown challenge/)
  })

  it("getInfo 映射描述与附件元数据", async () => {
    const project = await connect()
    const cap = await project.bindChallenge("misc-ez-png")
    const info = await cap.getInfo()
    expect(info.description).toBe("png 隐写")
    expect(info.attachments).toEqual([{ id: "ez_png.png", name: "ez_png.png", size: 5 }])
  })

  it("getInfo 透传 environmentGuide(平台附加指引)", async () => {
    const project = await connect()
    const cap = await project.bindChallenge("pwn-boom")
    const info = await cap.getInfo()
    expect(info.environmentGuide).toBe("申请后连接 endpoint,flag 在 /flag.txt")
  })

  it("downloadAttachment 字节与附件元数据一致", async () => {
    const project = await connect()
    const cap = await project.bindChallenge("misc-ez-png")
    const { attachment, content } = await cap.downloadAttachment("ez_png.png")
    expect(attachment.name).toBe("ez_png.png")
    expect(attachment.size).toBe(5)
    expect(Array.from(content)).toEqual([0x68, 0x65, 0x6c, 0x6c, 0x6f])
  })

  it("submitFlag:正确 accepted / 错误 rejected", async () => {
    const project = await connect()
    const cap = await project.bindChallenge("misc-ez-png")
    await expect(cap.submitFlag("moectf{stub_exact}")).resolves.toMatchObject({ status: "accepted" })
    await expect(cap.submitFlag("moectf{wrong}")).resolves.toMatchObject({ status: "rejected" })
  })

  it("instance.start 返回 RemoteEnvironment(endpoint 透传,expiresAt 丢弃)", async () => {
    const project = await connect()
    const cap = await project.bindChallenge("pwn-boom")
    const env = await cap.instance!.start()
    expect(env.status).toBe("running")
    expect(env.endpoint).toBe("tcp://127.0.0.1:25002")
    expect(env).not.toHaveProperty("expiresAt")
  })

  it("instance.status:存在返回 / 未知返回 null", async () => {
    const project = await connect()
    const cap = await project.bindChallenge("pwn-boom")
    await cap.instance!.destroy() // 清理前序测试遗留实例(destroy 按题销毁)
    const env = await cap.instance!.start()
    await expect(cap.instance!.status()).resolves.toMatchObject({ id: env.id })
    await cap.instance!.destroy() // 第二次:destroy 后
    await expect(cap.instance!.status()).resolves.toBeNull()
  })

  it("instance.destroy 幂等:重复销毁不抛(404 分支真实执行)", async () => {
    const project = await connect()
    const cap = await project.bindChallenge("pwn-boom")
    const env = await cap.instance!.start()
    await cap.instance!.destroy()
    // 第二次按题 destroy:列表已空,不发请求;改为按 id 销毁已不存在的实例 → stub 返回 404 → 客户端幂等吞掉
    await project.destroyRemoteEnvironment(env.id)
    expect(destroy404s).toBeGreaterThan(0) // 锁定:postJsonIdempotent 的 404→undefined 分支真实执行过
  })
})

describe("项目层与错误处理", () => {
  it("getOverview 由清单计算(challenges 计数,announcements=0)", async () => {
    const project = await connect()
    const overview = await project.getOverview()
    expect(overview).toMatchObject({ id: "test-event", challenges: 2, announcements: 0 })
  })

  it("listAnnouncements 返回空数组", async () => {
    const project = await connect()
    await expect(project.listAnnouncements()).resolves.toEqual([])
  })

  it("listRemoteEnvironments / getRemoteEnvironment 映射实例", async () => {
    const project = await connect()
    const cap = await project.bindChallenge("pwn-boom")
    const env = await cap.instance!.start()
    const list = await project.listRemoteEnvironments()
    expect(list).toContainEqual(expect.objectContaining({ id: env.id, challengeId: "pwn-boom" }))
    await expect(project.getRemoteEnvironment(env.id)).resolves.toMatchObject({ id: env.id })
    await expect(project.getRemoteEnvironment("inst-999")).resolves.toBeNull()
  })

  it("destroyRemoteEnvironment 调服务器销毁", async () => {
    const project = await connect()
    const cap = await project.bindChallenge("pwn-boom")
    const env = await cap.instance!.start()
    await project.destroyRemoteEnvironment(env.id)
    await expect(project.getRemoteEnvironment(env.id)).resolves.toBeNull()
  })

  it("非 2xx 响应解析 {error,message} 抛 Error", async () => {
    const project = await remotePlatform.connect({ eventId: "x", config: { baseUrl, token: "WRONG" } })
    await expect(project.listChallenges()).rejects.toThrow(/bad token/)
  })
})
