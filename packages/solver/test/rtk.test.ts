import { describe, expect, it } from "vitest"
import { RtkRewriter } from "../src/rtk.js"
import type { CommandResult, Sandbox } from "../src/sandbox.js"

class UnavailableSandbox implements Sandbox {
  readonly id = "unavailable"
  calls: string[][] = []
  async exec(args: string[]): Promise<CommandResult> {
    this.calls.push(args)
    throw new Error("rtk 不存在")
  }
  async close(): Promise<void> {}
}

describe("RtkRewriter", () => {
  it("RTK 在容器中不可用时 fail-open，并且不在宿主机探测", async () => {
    const sandbox = new UnavailableSandbox()
    const rtk = new RtkRewriter(sandbox)
    await expect(rtk.rewrite("cat flag.txt")).resolves.toBe("cat flag.txt")
    expect(sandbox.calls).toEqual([["rtk", "--version"]])
  })
})
