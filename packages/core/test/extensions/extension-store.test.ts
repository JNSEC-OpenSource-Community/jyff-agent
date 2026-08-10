import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PlatformPluginRegistry } from "@ctf-agent/platform"
import { afterEach, describe, expect, it, vi } from "vitest"
import { PlatformExtensionStore } from "../../src/index.ts"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe("PlatformExtensionStore", () => {
  it("静态描述候选且不执行入口模块", async () => {
    const root = await mkdtemp(join(tmpdir(), "extension-store-static-"))
    roots.push(root)
    const candidate = join(root, "candidate")
    const marker = join(root, "imported")
    await mkdir(candidate)
    await writeFile(
      join(candidate, "extension.json"),
      JSON.stringify({
        schemaVersion: 2,
        id: "demo-platform",
        name: "Demo",
        version: "1.0.0",
        entry: "index.ts",
        setup: candidateSetup,
      }),
    )
    await writeFile(
      join(candidate, "index.ts"),
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "bad")`,
    )
    const store = await PlatformExtensionStore.open({
      root,
      registry: new PlatformPluginRegistry([]),
    })

    const described = await store.describeCandidate(candidate)
    expect(described.setup).toEqual(candidateSetup)
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" })
    expect((await store.readCandidateEntry(candidate)).filename).toBe(
      "demo-platform.ts",
    )
  })

  it("仅激活通过 Gate 且内容未变化的 revision", async () => {
    const root = await mkdtemp(join(tmpdir(), "extension-store-"))
    roots.push(root)
    const candidate = join(root, "candidate")
    await mkdir(candidate)
    await writeFile(
      join(candidate, "extension.json"),
      JSON.stringify({
        schemaVersion: 2,
        id: "demo-platform",
        name: "Demo",
        version: "1.0.0",
        entry: "index.mjs",
        setup: candidateSetup,
      }),
    )
    await writeFile(join(candidate, "index.mjs"), candidateSource())
    const registry = new PlatformPluginRegistry([])
    const store = await PlatformExtensionStore.open({
      root,
      registry,
      validationSandbox: fakeValidationSandbox(),
    })
    const profile = {
      id: "profile",
      project: { id: "test", name: "Test" },
      config: {},
    }

    const report = await store.validate({
      sessionId: "father-1",
      candidateDirectory: candidate,
      profile,
    })
    expect(report.status).toBe("read_only_verified")
    await writeFile(join(candidate, "README.md"), "changed")
    await expect(
      store.activate({ sessionId: "father-1", candidateDirectory: candidate }),
    ).rejects.toThrow("发生变化")

    await store.validate({
      sessionId: "father-1",
      candidateDirectory: candidate,
      profile,
    })
    const restartedRegistry = new PlatformPluginRegistry([])
    const restarted = await PlatformExtensionStore.open({
      root,
      registry: restartedRegistry,
      validationSandbox: fakeValidationSandbox(),
    })
    const activated = await restarted.activate({
      sessionId: "father-1",
      candidateDirectory: candidate,
    })
    expect(activated.authorSessionId).toBe("father-1")
    expect(
      restartedRegistry
        .list()
        .find(({ plugin }) => plugin.id === "demo-platform")?.source,
    ).toBe("extension")
  })

  it("通过 Docker runner 验证并脱敏报告", async () => {
    const root = await mkdtemp(join(tmpdir(), "extension-store-sandbox-"))
    roots.push(root)
    const candidate = join(root, "workspace", "output")
    await mkdir(candidate, { recursive: true })
    await writeFile(
      join(candidate, "extension.json"),
      JSON.stringify({
        schemaVersion: 2,
        id: "demo-platform",
        name: "Demo",
        version: "1.0.0",
        entry: "index.ts",
        setup: candidateSetup,
      }),
    )
    await writeFile(
      join(candidate, "index.ts"),
      "throw new Error('host import')",
    )
    const close = vi.fn(async () => undefined)
    const exec = vi.fn(
      async (_args: string[], options?: { input?: string }) => {
        const runnerInput = JSON.parse(
          options?.input ?? "{}",
        ) as RunnerInput & {
          profile: { secrets: { TOKEN: string } }
        }
        const report = validationReport(
          runnerInput,
          `upstream rejected ${runnerInput.profile.secrets.TOKEN}`,
          "failed",
        )
        return {
          code: 0,
          stdout: `plugin log\n__FATHER_REPORT__${JSON.stringify(report)}`,
          stderr: "",
        }
      },
    )
    const store = await PlatformExtensionStore.open({
      root,
      registry: new PlatformPluginRegistry([]),
      validationSandbox: {
        image: "test-image",
        sandboxFactory: vi.fn(async () => ({ exec, close })) as never,
      },
    })

    const report = await store.validate({
      sessionId: "father-1",
      candidateDirectory: candidate,
      profile: {
        id: "profile",
        project: { id: "test", name: "Test" },
        config: {},
        secrets: { TOKEN: "super-secret" },
      },
    })

    expect(report.checks[0]?.message).toBe("upstream rejected [redacted]")
    expect(exec).toHaveBeenCalledWith(
      expect.arrayContaining([
        "node",
        "/workspace/.father-runtime/validation-runner.ts",
      ]),
      expect.objectContaining({
        input: expect.stringContaining("super-secret"),
      }),
    )
    expect(close).toHaveBeenCalledOnce()
  })
})

interface RunnerInput {
  pluginId: string
  revision: string
  contentHash: string
  authorSessionId: string
}

function fakeValidationSandbox() {
  return {
    image: "test-image",
    sandboxFactory: vi.fn(async () => ({
      close: vi.fn(async () => undefined),
      exec: vi.fn(async (_args: string[], options?: { input?: string }) => {
        const input = JSON.parse(options?.input ?? "{}") as RunnerInput
        return {
          code: 0,
          stdout: `__FATHER_REPORT__${JSON.stringify(
            validationReport(input, "通过", "read_only_verified"),
          )}`,
          stderr: "",
        }
      }),
    })) as never,
  }
}

function validationReport(
  input: RunnerInput,
  message: string,
  status: "failed" | "read_only_verified",
) {
  return {
    pluginId: input.pluginId,
    revision: input.revision,
    contentHash: input.contentHash,
    harnessVersion: "1",
    profileId: "profile",
    profileFingerprint: "fingerprint",
    authorSessionId: input.authorSessionId,
    status,
    startedAt: "2026-08-09T00:00:00.000Z",
    completedAt: "2026-08-09T00:00:01.000Z",
    checks: [
      {
        id: "connect",
        status: status === "failed" ? ("failed" as const) : ("passed" as const),
        message,
        durationMs: 1,
      },
    ],
    capabilities: {},
    cleanup: { projectClosed: false, environmentDestroyed: null },
  }
}

function candidateSource(): string {
  return `
const setup = ${JSON.stringify(candidateSetup)};
const overview = { id: "contest", name: "Contest", challenges: 1, announcements: 0 };
export const platformPlugin = {
  id: "demo-platform",
  setup,
  config: { parse: value => value },
  async connect() { return {
    async refresh() { return overview }, async getOverview() { return overview },
    async listChallenges() { return [{ id: "web-1", title: "Web", category: "web", score: 100 }] },
    async listAnnouncements() { return [] }, async listRemoteEnvironments() { return [] },
    async getRemoteEnvironment() { return null }, async destroyRemoteEnvironment() {},
    async bindChallenge(id) { return { async getInfo() { return { id, title: "Web", category: "web", score: 100, description: "test", attachments: [] } }, async downloadAttachment() {}, async submitFlag() { return { status: "rejected" } } } },
    async close() {}
  } }
}`
}

const candidateSetup = {
  label: "Demo",
  description: "Demo platform",
  defaultConfig: {},
  fields: [],
  authStrategies: [],
}
