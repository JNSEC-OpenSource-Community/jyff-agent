import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AuditStore } from "@ctf-agent/core"
import { afterEach, describe, expect, it } from "vite-plus/test"
import { createWebUiApp } from "../src/server.ts"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "audit-route-"))
  roots.push(root)
  return createWebUiApp({
    project: {} as never,
    auditStore: () => AuditStore.open(join(root, "audits.sqlite")),
    auditArchiveDirectory: join(root, "archives"),
    auditWorkDirectory: join(root, "work"),
    preflightAudit: async () => undefined,
    validateAuditModel: async () => undefined,
  })
}
describe("independent audit routes", () => {
  it("uploads an archive then creates a standalone audit without Project scope", async () => {
    const { app } = await fixture()
    const uploaded = await app.request("/api/audits/upload", {
      method: "POST",
      headers: { "X-Archive-Name": "service.zip" },
      body: new Uint8Array([1, 2, 3]),
    })
    expect(uploaded.status).toBe(201)
    const archive = await uploaded.json()
    const created = await app.request("/api/audits", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "服务", ...archive }),
    })
    expect(created.status).toBe(201)
    const audit = (await created.json()).audit
    const catalog = await app.request("/api/audits")
    expect(await catalog.json()).toMatchObject({
      audits: [{ id: audit.id, name: "服务", status: "draft" }],
    })
  })
  it("refuses to create a run when the audit worker preflight fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "audit-preflight-"))
    roots.push(root)
    const store = await AuditStore.open(join(root, "audits.sqlite"))
    const audit = store.create({
      name: "服务",
      archiveName: "source.zip",
      archiveSize: 1,
      archivePath: join(root, "source.zip"),
    })
    store.update(audit.id, { includePaths: [], excludePaths: [], auditModelId: "audit-model" })
    store.close()
    const { app } = createWebUiApp({
      project: {} as never,
      auditStore: () => AuditStore.open(join(root, "audits.sqlite")),
      auditArchiveDirectory: join(root, "archives"),
      preflightAudit: async () => {
        throw new Error("审计镜像未构建")
      },
      validateAuditModel: async () => undefined,
    })
    const response = await app.request(`/api/audits/${audit.id}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "standard" }),
    })
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ error: "code_audit_worker_unavailable" })
  })

  it("does not persist a pause state when the active worker rejects it", async () => {
    const root = await mkdtemp(join(tmpdir(), "audit-pause-"))
    roots.push(root)
    const store = await AuditStore.open(join(root, "audits.sqlite"))
    const audit = store.create({
      name: "服务",
      archiveName: "source.zip",
      archiveSize: 1,
      archivePath: join(root, "source.zip"),
    })
    const run = store.createRun(audit.id, "standard")
    if (!run) throw new Error("failed to create audit run")
    store.updateRun(run.id, { status: "running" })
    store.close()
    const { app } = createWebUiApp({
      project: {} as never,
      auditStore: () => AuditStore.open(join(root, "audits.sqlite")),
      auditArchiveDirectory: join(root, "archives"),
      preflightAudit: async () => undefined,
      validateAuditModel: async () => undefined,
      pauseAudit: async () => false,
    })
    const response = await app.request(`/api/audits/${audit.id}/runs/${run.id}/pause`, {
      method: "POST",
    })
    expect(response.status).toBe(409)
    const check = await AuditStore.open(join(root, "audits.sqlite"))
    expect(check.runs(audit.id)[0]?.status).toBe("running")
    check.close()
  })

  it("serves live run logs and canonical output files without exposing other paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "audit-output-routes-"))
    roots.push(root)
    const store = await AuditStore.open(join(root, "audits.sqlite"))
    const audit = store.create({
      name: "服务",
      archiveName: "source.zip",
      archiveSize: 1,
      archivePath: join(root, "source.zip"),
    })
    const run = store.createRun(audit.id, "standard")
    if (!run) throw new Error("failed to create audit run")
    store.updateRun(run.id, { status: "completed" })
    store.close()
    const output = join(root, "work", "runs", run.id, "output")
    await mkdir(output, { recursive: true })
    await writeFile(
      join(root, "work", "runs", run.id, "worker.log"),
      "[00:01] Running scan: reviewing files | Files: 1/2\\n",
    )
    await writeFile(
      join(output, "findings.json"),
      JSON.stringify({
        documentType: "codex-security.findings",
        findings: [
          {
            findingId: "f-1",
            occurrenceId: "o-1",
            ruleId: "auth.missing-check",
            title: "缺少授权",
            summary: "入口未检查权限",
            severity: { level: "high", score: 8.1 },
            confidence: { level: "high", rationale: "直接路径" },
            identity: { anchor: "auth-entry" },
            fingerprints: { primary: "codex-security/v1:sha256:test" },
            taxonomy: { category: "authorization", cwe: ["CWE-862"] },
            locations: [{ path: "src/auth.ts", startLine: 12 }],
            remediation: "补充授权检查",
            provenance: { source: "local_plugin" },
          },
        ],
      }),
    )
    await writeFile(
      join(output, "coverage.json"),
      JSON.stringify({
        documentType: "codex-security.coverage",
        completeness: "partial",
        mode: "repository",
        inventoryStrategy: "repository",
        includePaths: ["src/**"],
        excludePaths: [],
        surfaces: [],
        explicitExclusions: [],
        deferred: [],
        openQuestions: [
          { question: "检查 token 刷新边界", followUpPrompt: "继续检查 token 刷新边界" },
        ],
      }),
    )
    await writeFile(
      join(output, "scan-manifest.json"),
      JSON.stringify({
        documentType: "codex-security.scan-manifest",
        scan: {
          id: "scan-1",
          producer: { name: "plugin", version: "1" },
          target: { kind: "directory_snapshot", targetId: "target-1", displayName: "source" },
          scope: {},
          artifacts: [],
        },
      }),
    )
    await writeFile(join(output, "report.md"), "# 审计报告\\n")
    const { app } = createWebUiApp({
      project: {} as never,
      auditStore: () => AuditStore.open(join(root, "audits.sqlite")),
      auditArchiveDirectory: join(root, "archives"),
      auditWorkDirectory: join(root, "work"),
      preflightAudit: async () => undefined,
      validateAuditModel: async () => undefined,
    })

    const log = await app.request(`/api/audits/${audit.id}/runs/${run.id}/log`)
    expect(log.status).toBe(200)
    expect(await log.json()).toMatchObject({
      runId: run.id,
      text: expect.stringContaining("Files: 1/2"),
    })
    const events = await app.request(`/api/audits/${audit.id}/runs/${run.id}/events`)
    expect(events.status).toBe(200)
    expect(await events.text()).toContain("event: audit_log")
    const files = await app.request(`/api/audits/${audit.id}/runs/${run.id}/files`)
    expect(files.status).toBe(200)
    const fileData = await files.json()
    expect(fileData.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "findings.json",
          preview: { kind: "code", language: "json" },
        }),
        expect.objectContaining({
          path: "coverage.json",
          preview: { kind: "code", language: "json" },
        }),
        expect.objectContaining({
          path: "scan-manifest.json",
          preview: { kind: "code", language: "json" },
        }),
        expect.objectContaining({
          path: "report.md",
          preview: { kind: "markdown", language: "markdown" },
        }),
      ]),
    )
    const canonical = await app.request(`/api/audits/${audit.id}/runs/${run.id}/result`)
    expect(canonical.status).toBe(200)
    expect(await canonical.json()).toMatchObject({
      runId: run.id,
      findings: { findings: [{ taxonomy: { cwe: ["CWE-862"] } }] },
      coverage: { completeness: "partial", openQuestions: [{ question: "检查 token 刷新边界" }] },
      manifest: { documentType: "codex-security.scan-manifest" },
    })
    const preview = await app.request(
      `/api/audits/${audit.id}/runs/${run.id}/files/preview?path=report.md`,
    )
    expect(preview.status).toBe(200)
    expect(await preview.json()).toMatchObject({ path: "report.md", content: "# 审计报告\\n" })
    const download = await app.request(
      `/api/audits/${audit.id}/runs/${run.id}/files/download?path=findings.json`,
    )
    expect(download.status).toBe(200)
    expect(download.headers.get("content-disposition")).toContain("findings.json")
    expect(await download.text()).toContain('"documentType":"codex-security.findings"')
    const traversal = await app.request(
      `/api/audits/${audit.id}/runs/${run.id}/files/preview?path=${encodeURIComponent("../report.md")}`,
    )
    expect(traversal.status).toBe(404)
  })

  it("starts a follow-up run from a completed parent run", async () => {
    const root = await mkdtemp(join(tmpdir(), "audit-follow-up-"))
    roots.push(root)
    const store = await AuditStore.open(join(root, "audits.sqlite"))
    const audit = store.create({
      name: "服务",
      archiveName: "service.zip",
      archiveSize: 1,
      archivePath: join(root, "service.zip"),
    })
    store.update(audit.id, { includePaths: [], excludePaths: [], auditModelId: "audit-model" })
    const parent = store.createRun(audit.id, "standard")
    if (!parent) throw new Error("failed to create parent run")
    store.updateRun(parent.id, { status: "completed" })
    store.close()
    let started: string | undefined
    const { app } = createWebUiApp({
      project: {} as never,
      auditStore: () => AuditStore.open(join(root, "audits.sqlite")),
      auditArchiveDirectory: join(root, "archives"),
      auditWorkDirectory: join(root, "work"),
      preflightAudit: async () => undefined,
      validateAuditModel: async () => undefined,
      runAudit: async (run) => {
        started = run.id
      },
    })
    const response = await app.request(`/api/audits/${audit.id}/runs/${parent.id}/follow-up`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "继续检查 token 刷新边界" }),
    })
    expect(response.status).toBe(202)
    const followUp = (await response.json()).run
    expect(followUp).toMatchObject({
      purpose: "follow_up",
      parentRunId: parent.id,
      followUpPrompt: "继续检查 token 刷新边界",
    })
    expect(started).toBe(followUp.id)
  })

  it("deletes an inactive independent audit project", async () => {
    const { app } = await fixture()
    const uploaded = await app.request("/api/audits/upload", {
      method: "POST",
      headers: { "X-Archive-Name": "service.zip" },
      body: new Uint8Array([1]),
    })
    const created = await app.request("/api/audits", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "服务", ...(await uploaded.json()) }),
    })
    const { audit } = await created.json()
    expect((await app.request(`/api/audits/${audit.id}`, { method: "DELETE" })).status).toBe(204)
    expect((await app.request(`/api/audits/${audit.id}`)).status).toBe(404)
  })

  it("rejects arbitrary server paths instead of trusting the client", async () => {
    const { app } = await fixture()
    const response = await app.request("/api/audits", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "服务",
        archiveName: "x.zip",
        archiveSize: 1,
        archivePath: "/etc/passwd",
      }),
    })
    expect(response.status).toBe(400)
  })
})
