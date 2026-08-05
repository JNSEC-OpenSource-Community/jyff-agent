import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const dockerDirectory = join(import.meta.dirname, "..", "docker")

describe("solver Docker image manifest", () => {
  it("pins ffuf and OneListForAll and installs hashcat", async () => {
    const dockerfile = await readFile(
      join(dockerDirectory, "Dockerfile"),
      "utf8",
    )
    const tools = await readFile(join(dockerDirectory, "tools.txt"), "utf8")

    expect(dockerfile).toContain("hashcat")
    expect(dockerfile).toContain("ARG FFUF_VERSION=2.1.0")
    expect(dockerfile).toContain(
      "ARG ONELISTFORALL_COMMIT=32292ee62433c246826946824471d9b878b016c8",
    )
    expect(dockerfile).toContain("sha256sum -c -")
    expect(dockerfile).toContain(
      "ENV ONELISTFORALL=/usr/share/wordlists/onelistforall.txt",
    )
    expect(tools).toContain("ffuf -noninteractive")
    expect(tools).toContain("hashcat -m 0")
  })
})
