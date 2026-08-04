import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
  PlatformConnectOptions,
  PlatformPlugin,
  PlatformProject,
} from "@ctf-agent/platform"
import { afterEach, describe, expect, it } from "vitest"
import { ControlPlane } from "../../src/control-plane/control-plane.ts"
import { FileSecretStore } from "../../src/control-plane/secret-store.ts"
import type { ProjectConfig } from "../../src/project/config.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

class CredentialPlatform implements PlatformPlugin {
  readonly id = "credential-test"
  readonly setup = {
    label: "Credential test",
    description: "test",
    defaultConfig: {},
    fields: [],
    authStrategies: [
      {
        id: "token",
        label: "Token",
        config: {},
        secrets: [
          {
            name: "TEST_TOKEN",
            label: "Token",
            type: "token" as const,
            required: true,
          },
        ],
      },
    ],
  }
  readonly config = {
    parse(value: unknown) {
      if (typeof value !== "object" || value === null) {
        throw new Error("平台配置必须是对象")
      }
      return value
    },
  }
  connections = 0
  closes = 0

  async connect(options: PlatformConnectOptions): Promise<PlatformProject> {
    if (options.resolveSecret("TEST_TOKEN") !== "secret-token") {
      throw new Error("缺少 TEST_TOKEN")
    }
    this.connections++
    return {
      refresh: async () => await this.overview(options),
      getOverview: async () => await this.overview(options),
      listChallenges: async () => [],
      listAnnouncements: async () => [],
      listRemoteEnvironments: async () => [],
      getRemoteEnvironment: async () => null,
      destroyRemoteEnvironment: async () => undefined,
      bindChallenge: async () => {
        throw new Error("本测试没有题目")
      },
      close: async () => {
        this.closes++
      },
    }
  }

  private async overview(options: PlatformConnectOptions) {
    return {
      id: options.project.id,
      name: options.project.name,
      challenges: 0,
      announcements: 0,
    }
  }
}

function config(name = "Setup Test"): ProjectConfig {
  return {
    version: 1,
    project: { id: "setup-test", name },
    platform: { plugin: "credential-test", config: {} },
    sandbox: { image: "unused", privileged: false, networkMode: "none" },
  }
}

async function rootFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ctf-control-plane-"))
  roots.push(root)
  return root
}

describe("ControlPlane", () => {
  it("没有项目配置时以 unconfigured 状态启动", async () => {
    const root = await rootFixture()
    const control = await ControlPlane.create({
      root,
      platforms: [new CredentialPlatform()],
    })

    expect(await control.start()).toMatchObject({
      phase: "unconfigured",
      configured: false,
    })
  })

  it("平台凭据不从环境变量回退，认证失败进入 degraded", async () => {
    const root = await rootFixture()
    await writeConfig(root, config())
    const previous = process.env.TEST_TOKEN
    process.env.TEST_TOKEN = "secret-token"
    try {
      const control = await ControlPlane.create({
        root,
        platforms: [new CredentialPlatform()],
      })

      expect(control.setupSnapshot().secrets.TEST_TOKEN).toEqual({
        configured: false,
        source: "none",
      })
      expect(await control.start()).toMatchObject({
        phase: "degraded",
        configured: true,
        lastError: "缺少 TEST_TOKEN",
      })
    } finally {
      if (previous === undefined) delete process.env.TEST_TOKEN
      else process.env.TEST_TOKEN = previous
    }
  })

  it("测试连接成功后原子保存配置和 Secret，并建立运行时", async () => {
    const root = await rootFixture()
    const plugin = new CredentialPlatform()
    const secretPath = join(root, ".ctf-agent", "secrets.json")
    const control = await ControlPlane.create({
      root,
      platforms: [plugin],
      secretStore: await FileSecretStore.open(secretPath),
    })

    expect(
      await control.testConnection({
        config: config(),
        secrets: { TEST_TOKEN: "secret-token" },
      }),
    ).toMatchObject({ ok: true, overview: { name: "Setup Test" } })
    expect(plugin.closes).toBe(1)

    expect(
      await control.applySetup({
        config: config(),
        secrets: { TEST_TOKEN: "secret-token" },
      }),
    ).toMatchObject({ phase: "ready", platformId: "credential-test" })
    expect(control.currentProject()).toBeDefined()
    expect(await readFile(secretPath, "utf8")).toContain("secret-token")
    expect(
      await readFile(join(root, ".ctf-agent", "project-config.json"), "utf8"),
    ).not.toContain("secret-token")

    await control.close()
    expect(plugin.closes).toBe(3)
  })

  it("串行处理并发配置变更，最终运行时与最后一次配置一致", async () => {
    const root = await rootFixture()
    const plugin = new CredentialPlatform()
    const control = await ControlPlane.create({ root, platforms: [plugin] })

    const [first, second] = await Promise.all([
      control.applySetup({
        config: config("First"),
        secrets: { TEST_TOKEN: "secret-token" },
      }),
      control.applySetup({
        config: config("Second"),
        secrets: { TEST_TOKEN: "secret-token" },
      }),
    ])

    expect(first.phase).toBe("ready")
    expect(second).toMatchObject({ phase: "ready", projectName: "Second" })
    expect((await control.currentProject()?.overview())?.name).toBe("Second")
    await control.close()
  })
})

async function writeConfig(root: string, value: ProjectConfig): Promise<void> {
  await mkdir(join(root, ".pi"), { recursive: true })
  await writeFile(join(root, ".pi", "ctf-config.json"), JSON.stringify(value))
}
