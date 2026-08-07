import type {
  CommandResult,
  Sandbox,
  SandboxExecOptions,
} from "@ctf-agent/sandbox"
import { DockerBashExecutionEnv, DockerExecutionEnv } from "@ctf-agent/sandbox"
import { describe, expect, it } from "vitest"

class FakeSandbox implements Sandbox {
  readonly id = "fake"
  readonly calls: Array<{ args: string[]; options?: SandboxExecOptions }> = []
  readonly files = new Map<string, Buffer>()
  nativeFailuresRemaining = 0

  async exec(
    args: string[],
    options?: SandboxExecOptions,
  ): Promise<CommandResult> {
    this.calls.push({ args, options })
    if (args[0] !== "python3") {
      return { code: 0, stdout: "", stderr: "" }
    }
    if (this.nativeFailuresRemaining-- > 0) {
      return { code: 0xc0000142, stdout: "", stderr: "" }
    }
    const payload = JSON.parse(options?.input ?? "{}") as {
      op: string
      path: string
      base64?: string
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

  it("显式 timeout 仍按秒转换并传递给 sandbox", async () => {
    const sandbox = new FakeSandbox()
    await new DockerExecutionEnv(sandbox).exec("sleep 3600", { timeout: 1_201 })

    expect(sandbox.calls.at(-1)?.options?.timeoutMs).toBe(1_201_000)
  })

  it("Windows 原生进程初始化失败时有限重试文件 helper", async () => {
    const sandbox = new FakeSandbox()
    sandbox.nativeFailuresRemaining = 2

    const result = await new DockerExecutionEnv(sandbox).writeFile(
      "/tmp/result.txt",
      "ready",
    )

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
    expect(sandbox.files.get("/workspace/attachments/chall")?.toString()).toBe(
      "new payload",
    )
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
