import { createHash } from "node:crypto"
import {
  DockerBashExecutionEnv,
  DockerExecutionEnv,
  FILE_TRANSFER_CHUNK_BYTES,
  type CommandResult,
  type Sandbox,
  type SandboxExecOptions,
} from "@ctf-agent/sandbox"
import { describe, expect, it } from "vite-plus/test"

class FakeSandbox implements Sandbox {
  readonly id = "fake"
  readonly calls: Array<{ args: string[]; options?: SandboxExecOptions }> = []
  readonly files = new Map<string, Buffer>()
  nativeFailuresRemaining = 0
  nextCommandResult: CommandResult | undefined

  async exec(args: string[], options?: SandboxExecOptions): Promise<CommandResult> {
    this.calls.push({ args, options })
    if (args[0] !== "python3") {
      return this.nextCommandResult ?? { code: 0, stdout: "", stderr: "" }
    }
    if (this.nativeFailuresRemaining-- > 0) {
      return { code: 0xc0000142, stdout: "", stderr: "" }
    }
    const payload = JSON.parse(options?.input ?? "{}") as {
      op: string
      path: string
      base64?: string
      from?: string
      to?: string
    }
    if (payload.op === "write" || payload.op === "replace") {
      this.files.set(payload.path, Buffer.from(payload.base64 ?? "", "base64"))
    } else if (payload.op === "append") {
      this.files.set(
        payload.path,
        Buffer.concat([
          this.files.get(payload.path) ?? Buffer.alloc(0),
          Buffer.from(payload.base64 ?? "", "base64"),
        ]),
      )
    } else if (payload.op === "rename") {
      const content = this.files.get(payload.from ?? "")
      if (content && payload.from && payload.to) {
        this.files.delete(payload.from)
        this.files.set(payload.to, content)
      }
    } else if (payload.op === "sha256") {
      const content = this.files.get(payload.path)
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
    return {
      code: 0,
      stdout: JSON.stringify({ ok: true, value: null }),
      stderr: "",
    }
  }

  async close(): Promise<void> {}

  helperOperations(op: string): number {
    return this.calls.filter((call) => {
      if (call.args[0] !== "python3") return false
      return JSON.parse(call.options?.input ?? "{}").op === op
    }).length
  }
}

describe("DockerExecutionEnv", () => {
  it("未显式指定 timeout 时允许长时间命令持续执行", async () => {
    const sandbox = new FakeSandbox()
    const result = await new DockerExecutionEnv(sandbox).exec("sleep 3600")

    expect(result.ok).toBe(true)
    expect(sandbox.calls.at(-1)?.options?.timeoutMs).toBeUndefined()
  })

  it("显式 timeout 在容器内执行，并为 Docker 客户端保留上报宽限", async () => {
    const sandbox = new FakeSandbox()
    await new DockerExecutionEnv(sandbox).exec("sleep 3600", { timeout: 1_201 })

    const call = sandbox.calls.at(-1)
    expect(call?.options?.timeoutMs).toBe(1_206_000)
    expect(call?.args.join(" ")).toContain('timeout --kill-after=5s "$2"s bash -lc "$3"')
    expect(call?.args.at(-2)).toBe("1201")
  })

  it("容器内 timeout 返回标记时报告 timeout 错误", async () => {
    const sandbox = new FakeSandbox()
    sandbox.nextCommandResult = {
      code: 124,
      stdout: "",
      stderr: "__CTF_AGENT_COMMAND_TIMED_OUT__\n",
    }

    const result = await new DockerExecutionEnv(sandbox).exec("sleep 3600", {
      timeout: 120,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe("timeout")
  })

  it("Windows 原生进程初始化失败时有限重试文件 helper", async () => {
    const sandbox = new FakeSandbox()
    sandbox.nativeFailuresRemaining = 2

    const result = await new DockerExecutionEnv(sandbox).writeFile("/tmp/result.txt", "ready")

    expect(result.ok).toBe(true)
    expect(sandbox.helperOperations("write")).toBe(3)
    expect(sandbox.files.get("/tmp/result.txt")?.toString()).toBe("ready")
  })

  it("通过原子替换写入可能正被执行的持久化文件", async () => {
    const sandbox = new FakeSandbox()
    const result = await new DockerExecutionEnv(sandbox).replaceFile(
      "/workspace/attachments/chall",
      "new payload",
    )

    expect(result.ok).toBe(true)
    expect(sandbox.helperOperations("replace")).toBe(1)
    expect(sandbox.files.get("/workspace/attachments/chall")?.toString()).toBe("new payload")
  })

  it("超过单块上限的内容分块写入，不触碰 V8 字符串长度上限", async () => {
    const sandbox = new FakeSandbox()
    const content = Buffer.alloc(FILE_TRANSFER_CHUNK_BYTES + 11, 7)
    const result = await new DockerExecutionEnv(sandbox).writeFile(
      "/workspace/attachments/big.bin",
      content,
    )

    expect(result.ok).toBe(true)
    expect(sandbox.helperOperations("write")).toBe(1)
    expect(sandbox.helperOperations("append")).toBe(1)
    expect(sandbox.files.get("/workspace/attachments/big.bin")?.equals(content)).toBe(true)
  })

  it("超过单块上限的替换走临时文件 + rename 保持原子性", async () => {
    const sandbox = new FakeSandbox()
    sandbox.files.set("/workspace/attachments/chall", Buffer.from("old"))
    const content = Buffer.alloc(FILE_TRANSFER_CHUNK_BYTES * 2 + 5, 9)
    const result = await new DockerExecutionEnv(sandbox).replaceFile(
      "/workspace/attachments/chall",
      content,
    )

    expect(result.ok).toBe(true)
    expect(sandbox.helperOperations("replace")).toBe(0)
    expect(sandbox.helperOperations("rename")).toBe(1)
    expect(sandbox.files.get("/workspace/attachments/chall")?.equals(content)).toBe(true)
    expect([...sandbox.files.keys()].filter((key) => key.endsWith(".tmp"))).toEqual([])
  })

  it("readFileHash 返回容器内文件的 SHA-256", async () => {
    const sandbox = new FakeSandbox()
    sandbox.files.set("/workspace/attachments/chall", Buffer.from("payload"))
    const result = await new DockerExecutionEnv(sandbox).readFileHash(
      "/workspace/attachments/chall",
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toBe(createHash("sha256").update("payload").digest("hex"))
    }
  })

  it("将高频 bash 完整输出合并为少量容器写入", async () => {
    const sandbox = new FakeSandbox()
    const env = new DockerBashExecutionEnv(sandbox)
    const created = await env.createTempFile({
      prefix: "bash-",
      suffix: ".log",
    })
    if (!created.ok) throw created.error

    for (let index = 0; index < 1_100; index++) {
      const appended = await env.appendFile(created.value, "x".repeat(1_024))
      if (!appended.ok) throw appended.error
    }
    const executed = await env.exec("true")

    expect(executed.ok).toBe(true)
    expect(sandbox.helperOperations("append")).toBeLessThanOrEqual(3)
    expect(sandbox.files.get(created.value)?.byteLength).toBe(1_126_400)
  })
})
