import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vite-plus/test"
import {
  createFileModelAuthentication,
  FileCredentialStore,
  parseCredentialImport,
} from "../src/domain/model-auth.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("model authentication", () => {
  it("串行化并原子持久化同一 Provider 的并发更新", async () => {
    const root = await temporaryRoot()
    const path = join(root, "auth.json")
    const store = await FileCredentialStore.open(path)

    await Promise.all([
      store.modify("openai", async () => {
        await new Promise((resolve) => setTimeout(resolve, 10))
        return { type: "api_key", key: "first" }
      }),
      store.modify("openai", async (current) => ({
        type: "api_key",
        key: `${current?.type === "api_key" ? current.key : "missing"}-second`,
      })),
    ])

    expect(await store.read("openai")).toEqual({
      type: "api_key",
      key: "first-second",
    })
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      openai: { type: "api_key", key: "first-second" },
    })
  })

  it("解析 Pi、Codex CLI 与 Claude Code 的常见凭据格式", () => {
    const jwt = syntheticJwt(Math.floor(Date.now() / 1_000) + 3_600)
    const pi = parseCredentialImport({
      openai: { type: "api_key", key: "openai-test" },
      anthropic: {
        type: "oauth",
        access: "claude-access",
        refresh: "claude-refresh",
        expires: Date.now() + 3_600_000,
      },
    })
    expect(pi.get("openai")).toEqual({
      type: "api_key",
      key: "openai-test",
    })
    expect(pi.get("anthropic")?.type).toBe("oauth")

    const codex = parseCredentialImport({
      tokens: {
        access_token: jwt,
        refresh_token: "codex-refresh",
        account_id: "account-test",
      },
    }).get("openai-codex")
    expect(codex).toMatchObject({
      type: "oauth",
      access: jwt,
      refresh: "codex-refresh",
      accountId: "account-test",
    })

    const claude = parseCredentialImport({
      claudeAiOauth: {
        accessToken: "claude-access",
        refreshToken: "claude-refresh",
        expiresAt: Date.now() + 3_600_000,
        scopes: ["user:inference"],
      },
    }).get("anthropic")
    expect(claude).toMatchObject({
      type: "oauth",
      access: "claude-access",
      refresh: "claude-refresh",
      scopes: ["user:inference"],
    })

    expect(
      parseCredentialImport({
        CLAUDE_CODE_OAUTH_TOKEN: "claude-setup-token",
      }).get("anthropic"),
    ).toMatchObject({
      type: "oauth",
      access: "claude-setup-token",
      refresh: "claude-setup-token",
      staticToken: true,
    })
  })

  it("可从指定 auth.json 导入且状态接口不会返回密钥", async () => {
    const root = await temporaryRoot()
    const importPath = join(root, "import-auth.json")
    await writeFile(importPath, JSON.stringify({ ANTHROPIC_API_KEY: "anthropic-test-secret" }))
    const authentication = await createFileModelAuthentication({
      storagePath: join(root, "stored-auth.json"),
      importPath,
    })

    expect((await authentication.snapshot()).importFileAvailable).toBe(true)
    expect(await authentication.importFile()).toMatchObject({
      source: "file",
      imported: [{ provider: "anthropic", type: "api_key" }],
    })
    const snapshot = await authentication.snapshot()
    expect(snapshot.providers.find((provider) => provider.id === "anthropic")).toMatchObject({
      configured: true,
      credentialType: "api_key",
    })
    expect(JSON.stringify(snapshot)).not.toContain("anthropic-test-secret")
  })

  it("将 Claude setup-token 作为 Bearer OAuth 凭据保存", async () => {
    const root = await temporaryRoot()
    const authentication = await createFileModelAuthentication({
      storagePath: join(root, "auth.json"),
    })

    const login = await authentication.startLogin({
      provider: "anthropic",
      method: "oauth_token",
      secret: "claude-setup-token",
    })
    await expect.poll(() => authentication.loginSession(login.id).status).toBe("success")

    const provider = (await authentication.snapshot()).providers.find(
      (candidate) => candidate.id === "anthropic",
    )
    expect(provider).toMatchObject({
      configured: true,
      credentialType: "oauth",
    })
    expect(JSON.stringify(provider)).not.toContain("claude-setup-token")
  })
})

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ctf-model-auth-"))
  roots.push(root)
  return root
}

function syntheticJwt(exp: number): string {
  return [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(JSON.stringify({ exp })).toString("base64url"),
    "signature",
  ].join(".")
}
