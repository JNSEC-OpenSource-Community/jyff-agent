import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const dockerfilePath = fileURLToPath(
  new URL("../docker/Dockerfile", import.meta.url),
)

describe("solver Dockerfile", () => {
  it("安装提供 ping 命令的 iputils-ping", async () => {
    const dockerfile = await readFile(dockerfilePath, "utf8")
    expect(dockerfile).toMatch(/\biputils-ping\b/)
  })
})
