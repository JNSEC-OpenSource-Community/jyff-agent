import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createFileWebUiAuthentication } from "../src/domain/webui-auth.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ctf-webui-auth-"))
  roots.push(root)
  const path = join(root, "global-config.json")
  return { path, authentication: await createFileWebUiAuthentication(path) }
}

describe("FileWebUiAuthentication", () => {
  it("默认关闭，启用后只接受正确凭据并可撤销 session", async () => {
    const { path, authentication } = await fixture()
    expect(authentication.snapshot()).toEqual({
      enabled: false,
      username: null,
    })
    expect(authentication.authenticate(undefined)).toBe(true)

    await authentication.configure({
      enabled: true,
      username: "operator",
      password: "strong-password",
    })
    await expect(
      authentication.login("operator", "wrong-password"),
    ).rejects.toThrow("用户名或密码错误")

    const session = await authentication.login("operator", "strong-password")
    expect(authentication.authenticate(session.token)).toBe(true)
    authentication.logout(session.token)
    expect(authentication.authenticate(session.token)).toBe(false)

    const reopened = await createFileWebUiAuthentication(path)
    expect(reopened.snapshot()).toEqual({ enabled: true, username: "operator" })
    expect(reopened.authenticate(session.token)).toBe(false)
  })

  it("拒绝过短密码且不改变原配置", async () => {
    const { authentication } = await fixture()
    await expect(
      authentication.configure({
        enabled: true,
        username: "operator",
        password: "short",
      }),
    ).rejects.toThrow("密码长度必须为 8–1024")
    expect(authentication.snapshot()).toEqual({
      enabled: false,
      username: null,
    })
  })
})
