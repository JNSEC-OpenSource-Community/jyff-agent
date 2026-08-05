import { describe, expect, it, vi } from "vitest"
import { DockerExecutionEnv } from "../src/docker-execution-env.ts"
import type {
  CommandResult,
  Sandbox,
  SandboxExecOptions,
} from "../src/docker-sandbox.ts"

function sandboxFixture() {
  const exec = vi.fn(
    async (
      _args: string[],
      _options?: SandboxExecOptions,
    ): Promise<CommandResult> => ({
      code: 0,
      stdout: "ok",
      stderr: "",
    }),
  )
  const sandbox: Sandbox = {
    id: "sandbox-timeout-test",
    exec,
    close: async () => undefined,
  }
  return { sandbox, exec }
}

describe("DockerExecutionEnv shell timeout", () => {
  it("applies a finite default timeout so a stuck docker exec cannot consume the full run", async () => {
    const { sandbox, exec } = sandboxFixture()
    const env = new DockerExecutionEnv(sandbox)

    const result = await env.exec("true")

    expect(result.ok).toBe(true)
    expect(exec).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ timeoutMs: 300_000 }),
    )
  })

  it("allows shell working directories outside /workspace", async () => {
    const { sandbox, exec } = sandboxFixture()
    const env = new DockerExecutionEnv(sandbox, { cwd: "/tmp" })

    const result = await env.exec("pwd")

    expect(result.ok).toBe(true)
    expect(exec.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining(["/tmp", "pwd"]),
    )
  })

  it("honors an explicit timeout and rejects invalid values before invoking Docker", async () => {
    const { sandbox, exec } = sandboxFixture()
    const env = new DockerExecutionEnv(sandbox)

    await expect(env.exec("true", { timeout: 7 })).resolves.toMatchObject({
      ok: true,
    })
    expect(exec).toHaveBeenLastCalledWith(
      expect.any(Array),
      expect.objectContaining({ timeoutMs: 7_000 }),
    )

    const invalid = await env.exec("true", { timeout: 0 })
    expect(invalid).toMatchObject({
      ok: false,
      error: { code: "timeout" },
    })
    expect(exec).toHaveBeenCalledTimes(1)
  })
})

describe("DockerExecutionEnv unrestricted file paths", () => {
  it("resolves and forwards absolute paths outside /workspace", async () => {
    const exec = vi.fn(
      async (
        _args: string[],
        options?: SandboxExecOptions,
      ): Promise<CommandResult> => {
        const payload = JSON.parse(options?.input ?? "{}") as {
          op: string
          path: string
        }
        return {
          code: 0,
          stdout: JSON.stringify({
            ok: true,
            value: payload.op === "read_text" ? "temporary result" : null,
          }),
          stderr: "",
        }
      },
    )
    const env = new DockerExecutionEnv({
      id: "unrestricted-files",
      exec,
      close: async () => undefined,
    })

    await expect(env.absolutePath("../tmp/result.txt")).resolves.toEqual({
      ok: true,
      value: "/tmp/result.txt",
    })
    await expect(env.readTextFile("/tmp/result.txt")).resolves.toEqual({
      ok: true,
      value: "temporary result",
    })
    expect(JSON.parse(exec.mock.calls[0]?.[1]?.input ?? "{}")).toMatchObject({
      op: "read_text",
      path: "/tmp/result.txt",
    })
  })
})
