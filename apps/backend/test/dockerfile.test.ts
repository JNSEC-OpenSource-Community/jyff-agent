import { readFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"

describe("WebUI Docker 镜像依赖", () => {
  it("两个安装阶段都声明 web-access workspace", async () => {
    const dockerfile = await readFile(
      new URL("../Dockerfile", import.meta.url),
      "utf8",
    )

    expect(
      dockerfile.match(
        /COPY packages\/web-access\/package\.json packages\/web-access\/package\.json/g,
      ),
    ).toHaveLength(2)
  })
})
