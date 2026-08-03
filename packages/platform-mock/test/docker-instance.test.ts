import { describe, expect, it, beforeAll } from "vitest"
import { DockerInstanceProvider } from "../src/docker-instance.ts"

describe("DockerInstanceProvider(需要本地 Docker)", () => {
  beforeAll(async () => { await DockerInstanceProvider.ensureNetwork() })

  it("启动容器、注入 FLAG、endpoint 指向宿主发布端口", async () => {
    const flag = `myctf{test-${Date.now()}}`
    const provider = new DockerInstanceProvider(
      { image: "alpine:3.21", port: 80, network: "ctf-net", flag },
      "mock-test-basic",
    )
    const env = await provider.start()
    expect(env.status).toBe("running")
    expect(env.endpoint).toMatch(/^tcp:\/\/127\.0\.0\.1:\d+$/)
    // Windows 下 execSync 经 cmd.exe 会把单引号参数拆坏(docker exec 无法收到
    // "echo -n \"$FLAG\""),故用 execFileSync 直传 argv;容器内 sh 语义与简报一致
    const { execFileSync } = await import("node:child_process")
    expect(execFileSync("docker", ["exec", "mock-test-basic", "sh", "-c", 'echo -n "$FLAG"']).toString()).toBe(flag)
    await provider.destroy()
  })

  it("destroy 幂等且容器真实删除", async () => {
    const provider = new DockerInstanceProvider(
      { image: "alpine:3.21", port: 80, network: "ctf-net", flag: "myctf{x}" },
      "mock-test-destroy",
    )
    await provider.start()
    await provider.destroy()
    await provider.destroy()   // 第二次调用不抛错
    const { execSync } = await import("node:child_process")
    expect(() => execSync(`docker inspect mock-test-destroy`)).toThrow()
  })

  it("static destroyByName 幂等删除(集成路径使用的 API)", async () => {
    const provider = new DockerInstanceProvider(
      { image: "alpine:3.21", port: 80, network: "ctf-net", flag: "myctf{x}" },
      "mock-test-static-destroy",
    )
    await provider.start()
    await DockerInstanceProvider.destroyByName("mock-test-static-destroy")
    await DockerInstanceProvider.destroyByName("mock-test-static-destroy")
    const { execSync } = await import("node:child_process")
    expect(() => execSync(`docker inspect mock-test-static-destroy`)).toThrow()
  })

  it("MockContest 接入:配 container 的远程题真实容器启动 + 动态 FLAG 判定", async () => {
    const { MockPlatformPlugin } = await import("../src/index.ts")
    const platform = await new MockPlatformPlugin().connect({
      eventId: "event",
      config: {
        challenges: [
          {
            id: "dyn-flag", title: "Dyn", category: "pwn", score: 3, description: "dyn",
            attachments: [], flag: "MOCK{static}", remote: true, container: { image: "alpine:3.21", port: 80 },
          },
        ],
      },
    })
    const capability = await platform.bindChallenge("dyn-flag")
    const { execFileSync } = await import("node:child_process")
    // endpoint 不再含容器名;用 before/after 快照差集定位本次启动的容器
    // (platform-mock 内容器名为 challenge-<slug>-<随机8>;差集法在存在历史残留容器时也唯一)
    const listDynFlag = () => execFileSync(
      "docker", ["ps", "--filter", "name=challenge-dyn-flag", "--format", "{{.Names}}"],
    ).toString().trim().split(/\r?\n/).filter(Boolean)
    const before = new Set(listDynFlag())
    const env = await capability.instance!.start()
    expect(env.endpoint).toMatch(/^tcp:\/\/127\.0\.0\.1:\d+$/)
    expect(await capability.submitFlag("MOCK{static}")).toMatchObject({ status: "rejected" })
    const containerName = listDynFlag().find((name) => !before.has(name))!
    const dynamic = execFileSync("docker", ["exec", containerName, "sh", "-c", 'echo -n "$FLAG"']).toString()
    expect(dynamic).toMatch(/^myctf\{[0-9a-f]{12}\}$/)
    expect(await capability.submitFlag(dynamic)).toMatchObject({ status: "accepted" })
    await capability.instance!.destroy()
    expect(await capability.submitFlag(dynamic)).toMatchObject({ status: "already_solved" })
    const { execSync } = await import("node:child_process")
    expect(() => execSync(`docker inspect ${containerName}`)).toThrow()
  })
})
