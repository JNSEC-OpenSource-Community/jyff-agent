import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { resolvePlatformConfig, withPlatformConfigOverride } from "./platform-env.ts"

const roots: string[] = []
const savedEnv: Record<string, string | undefined> = {}

afterEach(async () => {
  vi.restoreAllMocks()
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })))
})

function setEnv(key: string, value: string | undefined): void {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key]
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

describe("resolvePlatformConfig", () => {
  it("env 有值时覆盖 base 配置,无值时保留 base", () => {
    setEnv("CTF_PLATFORM_BASE_URL", "http://env.example:9999")
    setEnv("CTF_PLATFORM_TOKEN", "env-token")
    expect(resolvePlatformConfig({
      baseUrl: "http://file.example:25001",
      token: "__PLACEHOLDER__",
      name: "MyCTF",
    })).toEqual({ baseUrl: "http://env.example:9999", token: "env-token", name: "MyCTF" })

    setEnv("CTF_PLATFORM_BASE_URL", undefined)
    setEnv("CTF_PLATFORM_TOKEN", undefined)
    expect(resolvePlatformConfig({
      baseUrl: "http://file.example:25001",
      token: "file-token",
    })).toEqual({ baseUrl: "http://file.example:25001", token: "file-token" })
  })

  it("token 为占位符时打印指引并 exit(1)", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never)
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined)
    setEnv("CTF_PLATFORM_TOKEN", undefined)
    resolvePlatformConfig({ baseUrl: "http://file.example:25001", token: "__PLACEHOLDER__" })
    expect(exit).toHaveBeenCalledWith(1)
    expect(error).toHaveBeenCalledWith(expect.stringContaining("CTF_PLATFORM_TOKEN"))
  })

  it("env 空串覆盖时视为未配置,exit(1)", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never)
    setEnv("CTF_PLATFORM_TOKEN", "")
    resolvePlatformConfig({ baseUrl: "http://file.example:25001", token: "file-token" })
    expect(exit).toHaveBeenCalledWith(1)
  })

  it("base 缺失 token 字段(undefined)时 exit(1)", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never)
    setEnv("CTF_PLATFORM_TOKEN", undefined)
    resolvePlatformConfig({
      baseUrl: "http://file.example:25001",
      token: undefined,
    } as unknown as Parameters<typeof resolvePlatformConfig>[0])
    expect(exit).toHaveBeenCalledWith(1)
  })
})

describe("withPlatformConfigOverride", () => {
  it("remote 模式写回 env 覆盖并在结束后恢复原文件", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctf-platform-env-"))
    roots.push(root)
    const configPath = join(root, "ctf-config.json")
    const original = JSON.stringify({
      version: 1,
      contest: { platform: "remote" },
      platform: { config: { baseUrl: "http://file.example:25001", token: "__PLACEHOLDER__", name: "MyCTF" } },
    }, null, 2)
    await writeFile(configPath, original)
    setEnv("CTF_PLATFORM_TOKEN", "env-token")

    let seenDuringRun: unknown
    const result = await withPlatformConfigOverride(configPath, async () => {
      seenDuringRun = JSON.parse(await readFile(configPath, "utf8"))
      return 42
    })

    expect(result).toBe(42)
    expect(seenDuringRun).toMatchObject({
      contest: { platform: "remote" },
      platform: { config: { token: "env-token", name: "MyCTF" } },
    })
    expect(await readFile(configPath, "utf8")).toBe(original)
  })

  it("mock 模式不写文件、不校验 token 占位符", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctf-platform-env-"))
    roots.push(root)
    const configPath = join(root, "ctf-config.json")
    const original = JSON.stringify({
      version: 1,
      contest: { platform: "mock" },
      platform: { config: { challenges: [{ id: "warmup-flag" }] } },
    })
    await writeFile(configPath, original)
    setEnv("CTF_PLATFORM_TOKEN", undefined)

    await expect(withPlatformConfigOverride(configPath, async () => "mock-ok")).resolves.toBe("mock-ok")
    expect(await readFile(configPath, "utf8")).toBe(original)
  })

  it("run 抛错时 finally 仍恢复原文件", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctf-platform-env-"))
    roots.push(root)
    const configPath = join(root, "ctf-config.json")
    const original = JSON.stringify({
      version: 1,
      contest: { platform: "remote" },
      platform: { config: { baseUrl: "http://file.example:25001", token: "__PLACEHOLDER__", name: "MyCTF" } },
    }, null, 2)
    await writeFile(configPath, original)
    setEnv("CTF_PLATFORM_TOKEN", "env-token")

    await expect(
      withPlatformConfigOverride(configPath, async () => { throw new Error("open-boom") }),
    ).rejects.toThrow("open-boom")
    expect(await readFile(configPath, "utf8")).toBe(original)
  })

  it("run 期间文件被第三方改动时,finally 不覆盖(并发恢复守卫)", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctf-platform-env-"))
    roots.push(root)
    const configPath = join(root, "ctf-config.json")
    const original = JSON.stringify({
      version: 1,
      contest: { platform: "remote" },
      platform: { config: { baseUrl: "http://file.example:25001", token: "__PLACEHOLDER__" } },
    }, null, 2)
    await writeFile(configPath, original)
    setEnv("CTF_PLATFORM_TOKEN", "env-token")

    let seenDuringRun = ""
    await withPlatformConfigOverride(configPath, async () => {
      seenDuringRun = await readFile(configPath, "utf8")
      await writeFile(configPath, "third-party content")
    })
    expect(seenDuringRun).toContain("env-token")
    expect(await readFile(configPath, "utf8")).toBe("third-party content")
  })

  it("启动快照已含他人真实 token 时,恢复回占位状态而非残留 token", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctf-platform-env-"))
    roots.push(root)
    const configPath = join(root, "ctf-config.json")
    // 模拟并发窗口内进入:启动读到的"original"已是他人(进程 A)写回的含真实 token 内容
    const tokenAContent = JSON.stringify({
      version: 1,
      contest: { platform: "remote" },
      platform: { config: { baseUrl: "http://a.example:25001", token: "token-a" } },
    }, null, 2)
    await writeFile(configPath, tokenAContent)
    setEnv("CTF_PLATFORM_TOKEN", "token-b")

    await withPlatformConfigOverride(configPath, async () => {})

    const after = JSON.parse(await readFile(configPath, "utf8")) as {
      platform: { config: { token: string } }
    }
    expect(after.platform.config.token).toBe("__PLACEHOLDER__")
  })
})
