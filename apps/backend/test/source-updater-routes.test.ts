import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MemorySecretStore } from "@ctf-agent/core"
import { afterEach, describe, expect, it } from "vite-plus/test"
import {
  createFileGitHubSourceUpdater,
  type SourceUpdateExecutor,
} from "../src/domain/github-source-updater.ts"
import { createTestApp, jsonOf, jsonRequest, type TestApp } from "./helpers.ts"

const currentRevision = "a".repeat(40)
const targetRevision = "b".repeat(40)
const roots: string[] = []
const updaters: Array<{ close(): void }> = []
let testApp: TestApp | undefined

const buildIdentity = {
  version: "0.1.0",
  revision: currentRevision,
  repository: "acme/agent",
  builtAt: null,
  dirty: false,
  source: "git" as const,
}

const executor: SourceUpdateExecutor = {
  snapshot: () => ({
    connected: true,
    protocolVersion: 1,
    canPrepare: true,
    canApply: true,
    reason: null,
  }),
  prepare: async () => ({}),
  apply: async () => ({}),
  rollback: async () => ({}),
}

afterEach(async () => {
  await testApp?.cleanup()
  testApp = undefined
  for (const updater of updaters.splice(0)) updater.close()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("源码更新 HTTP 路由", () => {
  it("把 updater 状态汇总到全局配置，并执行 GitHub 检查", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctf-source-updater-routes-"))
    roots.push(root)
    const updater = await createFileGitHubSourceUpdater({
      storageDirectory: root,
      secretStore: new MemorySecretStore(),
      buildIdentity,
      executor,
      fetch: fakeGitHubFetch,
    })
    updaters.push(updater)
    testApp = await createTestApp({ sourceUpdater: updater, buildIdentity })
    const { app } = testApp

    const initial = await jsonOf(await app.request("/api/global-config"))
    expect(initial.sourceUpdater).toMatchObject({
      id: "github-source-updater",
      current: { revision: currentRevision },
      executor: { canApply: true },
    })

    const enabled = await jsonRequest(app, "/api/global-config/source-updater", "POST", {
      enabled: true,
      automaticCheck: false,
    })
    expect(enabled.status).toBe(200)

    const checked = await jsonRequest(app, "/api/global-config/source-updater/check", "POST", {})
    expect(checked.status).toBe(200)
    expect(await jsonOf(await app.request("/api/global-config/source-updater"))).toMatchObject({
      candidate: { revision: targetRevision, relation: "ahead" },
    })
  })

  it("未启用 WebUI 鉴权时拒绝准备和自动应用，Token 不回传", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctf-source-updater-auth-"))
    roots.push(root)
    const secrets = new MemorySecretStore()
    const updater = await createFileGitHubSourceUpdater({
      storageDirectory: root,
      secretStore: secrets,
      buildIdentity,
      executor,
      fetch: fakeGitHubFetch,
    })
    updaters.push(updater)
    testApp = await createTestApp({ sourceUpdater: updater, buildIdentity })
    const { app } = testApp

    const config = await jsonRequest(app, "/api/global-config/source-updater", "POST", {
      enabled: true,
      automaticApply: true,
    })
    expect(config.status).toBe(403)
    expect(await jsonOf(config)).toMatchObject({ error: "source_update_authentication_required" })

    const token = await jsonRequest(app, "/api/global-config/source-updater/github-token", "POST", {
      token: "secret-token",
    })
    expect(token.status).toBe(200)
    expect(secrets.get("CTF_GITHUB_UPDATER_TOKEN")).toBe("secret-token")
    expect(JSON.stringify(await jsonOf(token))).not.toContain("secret-token")

    const prepare = await jsonRequest(app, "/api/global-config/source-updater/prepare", "POST", {
      expectedTargetRevision: targetRevision,
    })
    expect(prepare.status).toBe(403)
  })
})

async function fakeGitHubFetch(input: RequestInfo | URL): Promise<Response> {
  const url = requestUrl(input)
  if (url.endsWith("/commits/main")) {
    return new Response(
      JSON.stringify({
        sha: targetRevision,
        html_url: "https://github.com/acme/agent/commit/bbbbbbbbbbbb",
        commit: { verification: { verified: true } },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  }
  return new Response(JSON.stringify({ status: "ahead", ahead_by: 1, behind_by: 0 }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input
  if (input instanceof URL) return input.toString()
  return input.url
}
