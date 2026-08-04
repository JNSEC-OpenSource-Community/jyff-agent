import type { BashPrepare } from "@earendil-works/pi-agent-core"
import type { DockerExecutionEnv } from "./docker-execution-env.ts"

export type RtkStatus = "unknown" | "enabled" | "unavailable" | "disabled"

/** Optional command rewriter. Failure is diagnostic-only and never blocks a command. */
export class RtkRewriter {
  private status: RtkStatus = "unknown"

  constructor(
    private readonly env: DockerExecutionEnv,
    private readonly disabled = process.env.RTK_DISABLED === "1",
  ) {}

  async probe(): Promise<RtkStatus> {
    if (this.disabled) {
      this.status = "disabled"
      return this.status
    }
    const result = await this.env.exec("rtk --version", { timeout: 2 })
    this.status =
      result.ok && result.value.exitCode === 0 ? "enabled" : "unavailable"
    return this.status
  }

  async rewrite(command: string, signal?: AbortSignal): Promise<string> {
    if (this.status === "unknown") await this.probe()
    if (
      this.status !== "enabled" ||
      command.trim() === "" ||
      command.trimStart().startsWith("rtk ")
    ) {
      return command
    }
    const result = await this.env.exec(
      `rtk rewrite ${shellArgument(command)}`,
      {
        abortSignal: signal,
        timeout: 2,
      },
    )
    return result.ok && result.value.exitCode === 0
      ? result.value.stdout.trim() || command
      : command
  }

  prepare(): BashPrepare<{ env: DockerExecutionEnv }> {
    return async (execution, _context, signal) => {
      execution.command = await this.rewrite(execution.command, signal)
    }
  }
}

function shellArgument(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}
