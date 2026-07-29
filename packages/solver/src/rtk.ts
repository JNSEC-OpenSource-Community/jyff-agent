import type { Sandbox } from "./sandbox.ts"

export type RtkStatus = "unknown" | "enabled" | "unavailable" | "disabled"

/** RTK 在 sandbox 内运行，避免 solver 在宿主机执行任何分析命令。 */
export class RtkRewriter {
  private status: RtkStatus = "unknown"

  constructor(private readonly sandbox: Sandbox, private readonly disabled = process.env.RTK_DISABLED === "1") {}

  async probe(): Promise<RtkStatus> {
    if (this.disabled) return this.status = "disabled"
    try {
      await this.sandbox.exec(["rtk", "--version"], { timeoutMs: 2_000 })
      return this.status = "enabled"
    } catch {
      return this.status = "unavailable"
    }
  }

  async rewrite(command: string, signal?: AbortSignal): Promise<string> {
    if (this.status === "unknown") await this.probe()
    if (this.status !== "enabled" || command.trim() === "" || command.trimStart().startsWith("rtk ")) {
      return command
    }
    try {
      const result = await this.sandbox.exec(["rtk", "rewrite", command], { signal, timeoutMs: 2_000 })
      return result.stdout.trim() || command
    } catch {
      // RTK 只是输出优化层，失败时绝不能阻断解题。
      return command
    }
  }
}
