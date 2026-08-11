import { spawn } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vite-plus/test"

const roots: string[] = []
const setup = {
  label: "Demo",
  description: "Demo platform",
  defaultConfig: {},
  fields: [],
  authStrategies: [],
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("Father validation runner", () => {
  it("导入候选插件、校验静态 setup，并输出脱敏验收报告", async () => {
    const directory = await candidateDirectory("demo-platform")
    const result = await runRunner({
      entry: join(directory, "index.mjs"),
      pluginId: "demo-platform",
      manifestSetup: setup,
    })

    expect(result.code).toBe(0)
    const report = reportFrom(result.stdout)
    expect(report).toMatchObject({
      pluginId: "demo-platform",
      status: "read_only_verified",
      cleanup: { projectClosed: true },
    })
    expect(result.stdout).not.toContain("top-secret")
  })

  it("拒绝 manifest 与候选导出 ID 不一致的插件", async () => {
    const directory = await candidateDirectory("actual-platform")
    const result = await runRunner({
      entry: join(directory, "index.mjs"),
      pluginId: "declared-platform",
      manifestSetup: setup,
    })

    expect(result.code).not.toBe(0)
    expect(`${result.stdout}\n${result.stderr}`).toContain("manifest ID 与插件导出 ID 不一致")
    expect(result.stdout).not.toContain("__FATHER_REPORT__")
  })

  it("拒绝与 manifest setup 不一致的候选插件", async () => {
    const directory = await candidateDirectory("demo-platform", {
      ...setup,
      label: "Different",
    })
    const result = await runRunner({
      entry: join(directory, "index.mjs"),
      pluginId: "demo-platform",
      manifestSetup: setup,
    })

    expect(result.code).not.toBe(0)
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "manifest setup 与插件导出的 setup 不一致",
    )
  })
})

async function candidateDirectory(
  pluginId: string,
  pluginSetup: typeof setup = setup,
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "validation-runner-"))
  roots.push(directory)
  await writeFile(
    join(directory, "index.mjs"),
    `
const setup = ${JSON.stringify(pluginSetup)}
const overview = { id: "contest", name: "Contest", challenges: 1, announcements: 0 }
export const platformPlugin = {
  id: ${JSON.stringify(pluginId)},
  setup,
  config: { parse: value => value },
  async connect() {
    return {
      async getOverview() { return overview },
      async refresh() { return overview },
      async listChallenges() { return [{ id: "web-1", title: "Web", category: "web", score: 100 }] },
      async listAnnouncements() { return [] },
      async listRemoteEnvironments() { return [] },
      async getRemoteEnvironment() { return null },
      async destroyRemoteEnvironment() {},
      async bindChallenge(id) {
        return {
          async getInfo() { return { id, title: "Web", category: "web", score: 100, description: "test", attachments: [] } },
          async downloadAttachment() { throw new Error("not used") },
          async submitFlag() { return { status: "rejected", message: "Wrong" } },
        }
      },
      async close() {},
    }
  },
}
`,
  )
  return directory
}

async function runRunner(input: {
  entry: string
  pluginId: string
  manifestSetup: unknown
}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--experimental-transform-types", "packages/core/src/extensions/validation-runner.ts"],
      { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] },
    )
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.once("error", reject)
    child.once("close", (code) => resolve({ code, stdout, stderr }))
    child.stdin.end(
      JSON.stringify({
        ...input,
        revision: "revision-1",
        contentHash: "hash-1",
        authorSessionId: "father-1",
        profile: {
          id: "profile-1",
          project: { id: "project-1", name: "Project" },
          config: {},
          secrets: { TOKEN: "top-secret" },
        },
      }),
    )
  })
}

function reportFrom(stdout: string): Record<string, unknown> {
  const marker = "__FATHER_REPORT__"
  const index = stdout.indexOf(marker)
  if (index < 0) throw new Error("runner did not emit a validation report")
  return JSON.parse(stdout.slice(index + marker.length)) as Record<string, unknown>
}
