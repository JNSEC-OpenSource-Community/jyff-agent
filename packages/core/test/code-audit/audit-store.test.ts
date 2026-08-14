import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vite-plus/test"
import { AuditStore } from "../../src/code-audit/audit-store.ts"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ctf-audit-store-"))
  roots.push(root)
  return AuditStore.open(join(root, "audits.sqlite"))
}

describe("AuditStore", () => {
  it("persists an independent project, configuration, run, findings, and report", async () => {
    const store = await fixture()
    const audit = store.create({
      name: "支付服务",
      archiveName: "payment.zip",
      archiveSize: 42,
      archivePath: "/safe/payment.zip",
    })
    const configured = store.update(audit.id, {
      includePaths: ["src/**"],
      excludePaths: ["node_modules/**"],
      auditModelId: "audit-model",
    })
    expect(configured).toMatchObject({ status: "ready", includePaths: ["src/**"] })
    const run = store.createRun(audit.id, "standard")
    expect(run).toMatchObject({ status: "blocked", purpose: "scan" })
    if (!run) throw new Error("expected run")
    store.updateRun(run.id, { status: "completed" })
    store.replaceFindings(run.id, [
      {
        id: "record-1",
        runId: run.id,
        findingId: "finding-1",
        title: "权限绕过",
        summary: "缺少授权检查",
        severity: "high",
        confidence: "high",
        path: "src/auth.ts",
        startLine: 42,
        remediation: "在访问前检查所有权",
      },
    ])
    store.saveReport(run.id, "# 审计报告\n\n发现一个高危问题。")
    expect(store.findings(run.id)).toMatchObject([
      { findingId: "finding-1", severity: "high", startLine: 42 },
    ])
    expect(store.report(run.id)).toContain("审计报告")
    store.close()
  })
  it("persists a follow-up prompt with its parent run", async () => {
    const store = await fixture()
    const audit = store.create({
      name: "服务",
      archiveName: "service.zip",
      archiveSize: 1,
      archivePath: "/safe/service.zip",
    })
    const parent = store.createRun(audit.id, "deep")
    if (!parent) throw new Error("expected parent run")
    const followUp = store.createRun(audit.id, parent.mode, {
      purpose: "follow_up",
      parentRunId: parent.id,
      followUpPrompt: "继续检查认证边界",
    })
    expect(followUp).toMatchObject({
      purpose: "follow_up",
      parentRunId: parent.id,
      followUpPrompt: "继续检查认证边界",
    })
    expect(store.runs(audit.id)[0]).toMatchObject({
      purpose: "follow_up",
      parentRunId: parent.id,
    })
    store.close()
  })

  it("marks active and paused runs failed after backend restart instead of claiming recovery", async () => {
    const store = await fixture()
    const audit = store.create({
      name: "服务",
      archiveName: "service.tar",
      archiveSize: 1,
      archivePath: "/safe/service.tar",
    })
    const run = store.createRun(audit.id, "deep")
    if (!run) throw new Error("expected run")
    store.updateRun(run.id, { status: "paused" })
    expect(store.interruptActiveRuns()).toBe(1)
    expect(store.runs(audit.id)[0]).toMatchObject({
      status: "failed",
      error: expect.stringContaining("Backend restarted"),
    })
    store.close()
  })
})
