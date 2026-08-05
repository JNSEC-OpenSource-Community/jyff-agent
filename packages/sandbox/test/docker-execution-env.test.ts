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
