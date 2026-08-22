import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MemorySecretStore } from "@ctf-agent/core"
import { afterAll, describe, expect, it } from "vite-plus/test"
import type { BuildIdentity } from "../src/domain/build-identity.ts"
import {
  createFileGitHubSourceUpdater,
  type GitHubSourceUpdater,
  type SourceUpdateExecutor,
} from "../src/domain/github-source-updater.ts"
import {
  createFileSourceUpdaterConfiguration,
  GITHUB_SOURCE_UPDATER_TOKEN,
} from "../src/domain/source-updater-config.ts"

const roots: string[] = []
const updaters: GitHubSourceUpdater[] = []

const currentRevision = "a".repeat(40)
const targetRevision = "b".repeat(40)

const buildIdentity: BuildIdentity = {
  version: "0.1.0",
  revision: currentRevision,
  repository: "acme/agent",
  builtAt: null,
  dirty: false,
  source: "git",
}

afterAll(async () => {
  for (const updater of updaters) updater.close()
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

describe("GitHub 源码更新配置", () => {
  it("只允许受信仓库，并把 token 独立保存到 SecretStore", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctf-source-updater-config-"))
    roots.push(root)
    const secrets = new MemorySecretStore()
    const configuration = await createFileSourceUpdaterConfiguration({
      storagePath: join(root, "config.json"),
      secretStore: secrets,
      repository: "acme/agent",
    })

    expect(configuration.snapshot()).toMatchObject({
      enabled: false,
      repository: "acme/agent",
      channel: { kind: "branch", ref: "main" },
      githubTokenConfigured: false,
    })
    await configuration.update({ enabled: true, intervalMinutes: 30 })
    await configuration.setGitHubToken("ghs_secret")

    expect(configuration.snapshot()).toMatchObject({ enabled: true, intervalMinutes: 30 })
    expect(secrets.get(GITHUB_SOURCE_UPDATER_TOKEN)).toBe("ghs_secret")
    expect(await readFile(join(root, "config.json"), "utf8")).not.toContain("ghs_secret")
    await expect(configuration.update({ repository: "other/repository" })).rejects.toThrow(
      "只允许更新受信仓库",
    )
    await expect(configuration.update({ automaticApply: true })).rejects.toThrow(
      "自动应用只支持经过验证的 GitHub Release 通道",
    )
  })
})

describe("GitHub 源码更新检查", () => {
  it("使用 commit compare 判断快进关系，并复用 ETag 缓存", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctf-source-updater-github-"))
    roots.push(root)
    const requests: Array<{ url: string; headers: Headers }> = []
    let conditionalRequests = 0
    const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = requestUrl(input)
      const headers = new Headers(init?.headers)
      requests.push({ url, headers })
      if (headers.has("if-none-match")) conditionalRequests += 1
      if (url.endsWith("/commits/main")) {
        if (headers.has("if-none-match")) return new Response(null, { status: 304 })
        return json(
          {
            sha: targetRevision,
            html_url: "https://github.com/acme/agent/commit/bbbbbbbbbbbb",
            commit: {
              message: "release: update agent",
              verification: { verified: true },
            },
          },
          "commit-etag",
        )
      }
      if (url.includes(`/compare/${currentRevision}...${targetRevision}`)) {
        if (headers.has("if-none-match")) return new Response(null, { status: 304 })
        return json({ status: "ahead", ahead_by: 3, behind_by: 0 }, "compare-etag")
      }
      throw new Error(`unexpected GitHub request: ${url}`)
    }
    const updater = await createFileGitHubSourceUpdater({
      storageDirectory: root,
      secretStore: new MemorySecretStore({ [GITHUB_SOURCE_UPDATER_TOKEN]: "token-value" }),
      buildIdentity,
      fetch,
    })
    updaters.push(updater)
    await updater.updateConfiguration({ enabled: true })

    const first = await updater.checkNow()
    expect(first).toMatchObject({ status: "succeeded", targetRevision })
    expect((await updater.snapshot()).candidate).toMatchObject({
      revision: targetRevision,
      relation: "ahead",
      aheadBy: 3,
      signatureVerified: true,
    })
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer token-value")

    await updater.checkNow()
    expect(conditionalRequests).toBeGreaterThanOrEqual(2)
    expect((await updater.snapshot()).candidate?.relation).toBe("ahead")
  })

  it("拒绝 diverged candidate，避免自动覆盖本地分叉", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctf-source-updater-diverged-"))
    roots.push(root)
    const fetch = async (input: RequestInfo | URL): Promise<Response> => {
      const url = requestUrl(input)
      if (url.endsWith("/commits/main")) {
        return json({
          sha: targetRevision,
          html_url: "https://github.com/acme/agent/commit/bbbbbbbbbbbb",
          commit: { verification: { verified: false } },
        })
      }
      return json({ status: "diverged", ahead_by: 2, behind_by: 1 })
    }
    const updater = await createFileGitHubSourceUpdater({
      storageDirectory: root,
      secretStore: new MemorySecretStore(),
      buildIdentity,
      fetch,
    })
    updaters.push(updater)
    await updater.updateConfiguration({ enabled: true })
    await updater.checkNow()

    expect((await updater.snapshot()).candidate?.relation).toBe("diverged")
    await expect(updater.prepare(targetRevision)).rejects.toMatchObject({
      code: "source_update_not_available",
    })
  })

  it("Release 通道在获准时自动准备并应用已签名更新", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctf-source-updater-auto-"))
    roots.push(root)
    const calls: string[] = []
    const executor: SourceUpdateExecutor = {
      snapshot: () => ({
        connected: true,
        protocolVersion: 1,
        canPrepare: true,
        canApply: true,
        reason: null,
      }),
      prepare: async () => {
        calls.push("prepare")
        return {}
      },
      apply: async () => {
        calls.push("apply")
        return {}
      },
      rollback: async () => ({}),
    }
    const updater = await createFileGitHubSourceUpdater({
      storageDirectory: root,
      secretStore: new MemorySecretStore(),
      buildIdentity,
      executor,
      automaticApplyAllowed: () => true,
      fetch: async (input: RequestInfo | URL) => {
        const url = requestUrl(input)
        if (url.endsWith("/releases/latest")) {
          return json({
            tag_name: "v0.2.0",
            html_url: "https://github.com/acme/agent/releases/tag/v0.2.0",
            body: "stable update",
            draft: false,
            prerelease: false,
          })
        }
        if (url.endsWith("/commits/v0.2.0")) {
          return json({
            sha: targetRevision,
            html_url: "https://github.com/acme/agent/commit/bbbbbbbbbbbb",
            commit: { verification: { verified: true } },
          })
        }
        return json({ status: "ahead", ahead_by: 2, behind_by: 0 })
      },
    })
    updaters.push(updater)
    await updater.updateConfiguration({
      enabled: true,
      channel: { kind: "release" },
      automaticCheck: false,
      automaticApply: true,
    })
    await updater.checkNow()
    for (let attempt = 0; attempt < 50 && calls.length < 2; attempt += 1) {
      await delay(20)
    }

    expect((await updater.snapshot()).candidate).toMatchObject({
      version: "0.2.0",
      relation: "ahead",
      verified: true,
    })
    expect(calls).toEqual(["prepare", "apply"])
  })

  it("通过 Update Worker 准备并应用快进版本，同时拒绝活跃任务", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctf-source-updater-worker-"))
    roots.push(root)
    const calls: string[] = []
    let active = 1
    const executor: SourceUpdateExecutor = {
      snapshot: () => ({
        connected: true,
        protocolVersion: 1,
        canPrepare: true,
        canApply: true,
        reason: null,
      }),
      prepare: async () => {
        calls.push("prepare")
        return {}
      },
      apply: async () => {
        calls.push("apply")
        return {}
      },
      rollback: async () => {
        calls.push("rollback")
        return {}
      },
    }
    const updater = await createFileGitHubSourceUpdater({
      storageDirectory: root,
      secretStore: new MemorySecretStore(),
      buildIdentity,
      executor,
      activity: () => ({ activeSolvers: active, activeFatherTurns: 0, activeAudits: 0 }),
      fetch: async (input: RequestInfo | URL) => {
        const url = requestUrl(input)
        if (url.endsWith("/commits/main")) {
          return json({
            sha: targetRevision,
            html_url: "https://github.com/acme/agent/commit/bbbbbbbbbbbb",
            commit: { verification: { verified: true } },
          })
        }
        return json({ status: "ahead", ahead_by: 1, behind_by: 0 })
      },
    })
    updaters.push(updater)
    await updater.updateConfiguration({ enabled: true })
    await updater.checkNow()
    const prepared = await updater.prepare(targetRevision)
    expect(prepared.status).toBe("prepared")

    await expect(
      updater.apply({
        operationId: prepared.id,
        expectedCurrentRevision: currentRevision,
        expectedTargetRevision: targetRevision,
      }),
    ).rejects.toMatchObject({ code: "source_update_system_busy" })
    expect(calls).toEqual(["prepare"])

    active = 0
    const applied = await updater.apply({
      operationId: prepared.id,
      expectedCurrentRevision: currentRevision,
      expectedTargetRevision: targetRevision,
    })
    expect(applied.status).toBe("succeeded")
    expect(calls).toEqual(["prepare", "apply"])
  })
})

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input
  if (input instanceof URL) return input.toString()
  return input.url
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function json(value: unknown, etag?: string): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: {
      "content-type": "application/json",
      ...(etag ? { etag } : {}),
    },
  })
}
