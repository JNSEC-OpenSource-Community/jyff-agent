import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vite-plus/test"
import { createFileShellPoopConfiguration } from "../src/domain/shellpoop-config.ts"

describe("ShellPoop 配置服务", () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  async function open() {
    const root = await mkdtemp(join(tmpdir(), "ctf-shellpoop-"))
    roots.push(root)
    const configuration = await createFileShellPoopConfiguration({
      storagePath: join(root, "shellpoop.json"),
    })
    return { configuration, root }
  }

  it("初始为空：禁用、默认 baseUrl、无超时覆盖", async () => {
    const { configuration } = await open()
    const snapshot = await configuration.snapshot()
    expect(snapshot.enabled).toBe(false)
    expect(snapshot.baseUrl).toBe("http://127.0.0.1:8000")
    expect(snapshot.timeoutMs).toBeUndefined()
  })

  it("update 持久化 enabled/baseUrl/timeoutMs", async () => {
    const { configuration } = await open()
    await configuration.update({ enabled: true, baseUrl: "http://shellpoop:8000", timeoutMs: 5000 })

    const snapshot = await configuration.snapshot()
    expect(snapshot.enabled).toBe(true)
    expect(snapshot.baseUrl).toBe("http://shellpoop:8000")
    expect(snapshot.timeoutMs).toBe(5000)
  })

  it("projectSnapshot 为禁用时也返回默认超时 15000", async () => {
    const { configuration } = await open()
    const snapshot = await configuration.projectSnapshot()
    expect(snapshot.enabled).toBe(false)
    expect(snapshot.timeoutMs).toBe(15_000)
  })

  it("拒绝非法 baseUrl", async () => {
    const { configuration } = await open()
    await expect(configuration.update({ baseUrl: "not-a-url" })).rejects.toThrow(
      /baseUrl 必须是 http/,
    )
  })

  it("从磁盘重新加载保留配置（含去掉尾部斜杠）", async () => {
    const { root } = await open()
    await createFileShellPoopConfiguration({
      storagePath: join(root, "shellpoop.json"),
    }).then((configuration) =>
      configuration.update({ enabled: true, baseUrl: "http://127.0.0.1:8000//" }),
    )

    const reloaded = await createFileShellPoopConfiguration({
      storagePath: join(root, "shellpoop.json"),
    })
    const snapshot = await reloaded.snapshot()
    expect(snapshot.enabled).toBe(true)
    expect(snapshot.baseUrl).toBe("http://127.0.0.1:8000")
  })
})
