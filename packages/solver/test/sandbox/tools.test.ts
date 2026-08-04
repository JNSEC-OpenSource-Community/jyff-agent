import { describe, expect, it } from "vitest"
import type { ChallengeCapability, FlagSubmission } from "@ctf-agent/platform"
import type { CommandResult, Sandbox, SandboxExecOptions } from "../../src/sandbox/docker-sandbox.js"
import { createSolverTools } from "../../src/sandbox/tools.js"

class FakeSandbox implements Sandbox {
  readonly id = "sandbox"
  readonly calls: Array<{ args: string[]; input?: string }> = []
  closed = false

  async exec(args: string[], options?: SandboxExecOptions): Promise<CommandResult> {
    this.calls.push({ args, input: options?.input })
    if (args[0] === "python3") {
      const payload = JSON.parse(options?.input ?? "{}") as { op: string; path: string }
      const value = payload.op === "canonical"
        ? payload.path
        : payload.op === "info"
          ? { name: "file", path: payload.path, kind: "file", size: 0, mtimeMs: 0 }
          : null
      return { code: 0, stdout: JSON.stringify({ ok: true, value }), stderr: "" }
    }
    if (args[0] === "bash") {
      const command = args.at(-1)
      if (command === "rtk --version") return { code: 0, stdout: "rtk 1", stderr: "" }
      if (command?.startsWith("rtk rewrite ")) return { code: 0, stdout: "rg MOCK", stderr: "" }
      options?.onStdout?.("sandbox output")
      return { code: 0, stdout: "sandbox output", stderr: "" }
    }
    return { code: 1, stdout: "", stderr: "unexpected command" }
  }

  async close(): Promise<void> { this.closed = true }
}

function capability(remote = false): ChallengeCapability {
  return {
    getInfo: async () => ({ id: "only", title: "Only", category: "misc", score: 1, description: "desc", attachments: [] }),
    downloadAttachment: async (id) => ({ attachment: { id, name: "flag.bin", size: 3 }, content: new Uint8Array([0, 255, 1]) }),
    submitFlag: async (): Promise<FlagSubmission> => ({ status: "accepted", message: "ok" }),
    ...(remote ? {
      instance: {
        start: async () => ({ id: "i", challengeId: "only", status: "running" as const }),
        status: async () => null,
        destroy: async () => undefined,
      },
    } : {}),
  }
}

function tool(name: string, tools = createSolverTools({ capability: capability(), sandbox: new FakeSandbox(), onTerminalSubmission: () => {} })) {
  const found = tools.find((item) => item.name === name)
  if (!found) throw new Error(`未找到工具 ${name}`)
  return found
}

describe("Solver tools", () => {
  it("没有远程环境 capability 时不注入实例工具", () => {
    const tools = createSolverTools({ capability: capability(false), sandbox: new FakeSandbox(), onTerminalSubmission: () => {} })
    expect(tools.map((item) => item.name)).toEqual(expect.arrayContaining(["read", "write", "edit", "list", "bash", "ctf_submit_flag"]))
    expect(tools.map((item) => item.name)).not.toEqual(expect.arrayContaining(["ctf_instance_start", "ctf_instance_status", "ctf_instance_destroy"]))
  })

  it("远程环境 capability 只为当前题注入实例工具", () => {
    const tools = createSolverTools({ capability: capability(true), sandbox: new FakeSandbox(), onTerminalSubmission: () => {} })
    expect(tools.map((item) => item.name)).toEqual(expect.arrayContaining(["ctf_instance_start", "ctf_instance_status", "ctf_instance_destroy"]))
  })

  it("文件、附件与 RTK 改写均通过 sandbox 执行，不触碰宿主机文件工具", async () => {
    const sandbox = new FakeSandbox()
    const tools = createSolverTools({ capability: capability(), sandbox, onTerminalSubmission: () => {} })

    await tool("write", tools).execute("write", { path: "notes/a.txt", content: "x" })
    await tool("ctf_download_attachment", tools).execute("download", { attachmentId: "flag" })
    const bash = await tool("bash", tools).execute("bash", { command: "grep MOCK flag.txt" })

    expect(sandbox.calls[0]?.args).toEqual(["python3", "-c", expect.any(String)])
    const fileCalls = sandbox.calls
      .filter((call) => call.args[0] === "python3")
      .map((call) => JSON.parse(call.input ?? "{}"))
    expect(fileCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({ op: "write", path: "/workspace/notes/a.txt", base64: "eA==" }),
      expect.objectContaining({ op: "write", path: "/workspace/attachments/flag/flag.bin", base64: "AP8B" }),
    ]))
    const bashCommands = sandbox.calls
      .filter((call) => call.args[0] === "bash")
      .map((call) => call.args.at(-1))
    expect(bashCommands).toEqual(["rtk --version", expect.stringMatching(/^rtk rewrite /), "rg MOCK"])
    expect(bash.content).toEqual([{ type: "text", text: "sandbox output" }])
  })

  it("提交成功会通知 Agent 在本轮结束后回收容器", async () => {
    let submission: FlagSubmission | undefined
    const submit = tool("ctf_submit_flag", createSolverTools({ capability: capability(), sandbox: new FakeSandbox(), onTerminalSubmission: (value) => { submission = value } }))
    await submit.execute("submit", { flag: "FLAG" })
    expect(submission).toMatchObject({ status: "accepted" })
  })
})
