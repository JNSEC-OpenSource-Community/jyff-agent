import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { basename, join, relative, resolve } from "node:path"
import { randomUUID } from "node:crypto"
import {
  listWorkspaceArtifacts,
  readWorkspaceArtifact,
  type WorkspaceArtifactListing,
} from "@ctf-agent/core"
import { executeDockerCommand } from "@ctf-agent/sandbox"
import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import { z } from "zod"
import type { App, AppContext, AppEnv } from "../context.ts"
import { HttpError } from "../errors.ts"
import { auditFollowUpSchema, codeAuditCreateSchema, parseJsonBody } from "../schema.ts"
import { WORKSPACE_PREVIEW_MAX_BYTES, workspacePreviewDescriptor } from "../workspace-files.ts"
import type { Services } from "../services.ts"

/** 独立代码审计 API：不接受或解析 CTF Project ID。 */
export function codeAuditRoutes(services: Services): App {
  const app = new Hono<AppEnv>()
  app.get("/audits", async (c) => {
    const [audits, adapter] = await Promise.all([
      services.withAuditStore((store) => store.list()),
      services.auditAdapterStatus(),
    ])
    return c.json({ audits, adapter })
  })
  app.post("/audits", async (c) => {
    const input = await parseJsonBody(c, codeAuditCreateSchema, { code: "invalid_code_audit" })
    const archivePath = resolve(input.archivePath)
    const archiveRoot = resolve(services.auditArchiveDirectory)
    if (relative(archiveRoot, archivePath).startsWith("..")) {
      throw new HttpError(400, "invalid_archive", "压缩包不属于审计归档目录")
    }
    const metadata = await stat(archivePath).catch(() => undefined)
    if (!metadata?.isFile() || metadata.size !== input.archiveSize) {
      throw new HttpError(400, "invalid_archive", "上传的压缩包不存在或大小不一致")
    }
    const audit = await services.withAuditStore((store) => store.create({ ...input, archivePath }))
    return c.json({ audit }, 201)
  })
  app.delete("/audits/:auditId", async (c) => {
    const audit = await services.withAuditStore((store) => store.get(c.req.param("auditId")))
    if (!audit) throw new HttpError(404, "audit_not_found", "审计项目不存在")
    const active = await services.withAuditStore((store) =>
      store.runs(audit.id).some((run) => run.status === "running" || run.status === "paused"),
    )
    if (active) throw new HttpError(409, "audit_run_active", "请先取消正在运行的审计")
    await services.withAuditStore((store) => store.delete(audit.id))
    return c.body(null, 204)
  })
  app.get("/audits/:auditId", async (c) => {
    const audit = await services.withAuditStore((store) => store.get(c.req.param("auditId")))
    if (!audit) throw new HttpError(404, "audit_not_found", "审计项目不存在")
    const models = services
      .modelView()
      .models.filter((model) => model.configured && model.provider.startsWith("custom-"))
      .map((model) => ({ id: model.id, name: model.modelId, provider: model.provider }))
    const runs = await services.withAuditStore((store) => store.runs(audit.id))
    const findings = await services.withAuditStore((store) =>
      runs.flatMap((run) => store.findings(run.id)),
    )
    const reports = await services.withAuditStore((store) =>
      runs.flatMap((run) => {
        const markdown = store.report(run.id)
        return markdown === undefined ? [] : [{ runId: run.id, markdown }]
      }),
    )
    return c.json({
      audit,
      runs,
      findings,
      reports,
      models,
      adapter: await services.auditAdapterStatus(),
    })
  })
  app.get("/audits/:auditId/files", async (c) => {
    const audit = await services.withAuditStore((store) => store.get(c.req.param("auditId")))
    if (!audit) throw new HttpError(404, "audit_not_found", "审计项目不存在")
    const archive = archiveContainerAccess(audit.archivePath)
    const result = await executeDockerCommand(
      [
        "run",
        "--rm",
        "--network",
        "none",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        ...archive.arguments,
        "ctf-agent-solver:latest",
        "python3",
        "-c",
        archiveFileListScript(audit.archiveName, archive.path),
      ],
      { timeoutMs: 60_000 },
    )
    if (result.code !== 0) {
      const detail = result.stderr.trim().replaceAll(/(?:[A-Za-z]:)?[/\\][^\n]*/g, "[path]")
      throw new HttpError(
        400,
        "invalid_archive",
        `无法读取安全的归档文件清单${detail ? `：${detail.slice(0, 500)}` : ""}`,
      )
    }
    const files = JSON.parse(result.stdout) as string[]
    return c.json({ files })
  })
  app.get("/audits/:auditId/runs/:runId/log", async (c) => {
    await requireAuditRun(services, c.req.param("auditId"), c.req.param("runId"))
    const snapshot = await readAuditLog(services, c.req.param("runId"))
    c.header("Cache-Control", "no-store")
    return c.json({ runId: c.req.param("runId"), ...snapshot })
  })
  app.get("/audits/:auditId/runs/:runId/events", async (c) => {
    await requireAuditRun(services, c.req.param("auditId"), c.req.param("runId"))
    return auditLogStream(c, services, c.req.param("auditId"), c.req.param("runId"))
  })
  app.get("/audits/:auditId/runs/:runId/result", async (c) => {
    await requireAuditRun(services, c.req.param("auditId"), c.req.param("runId"))
    c.header("Cache-Control", "no-store")
    return c.json({
      runId: c.req.param("runId"),
      ...(await readAuditResult(services, c.req.param("runId"))),
    })
  })
  app.get("/audits/:auditId/runs/:runId/files", async (c) => {
    await requireAuditRun(services, c.req.param("auditId"), c.req.param("runId"))
    const listing = await listAuditOutputFiles(services, c.req.param("runId"))
    c.header("Cache-Control", "no-store")
    return c.json({
      ...listing,
      files: listing.files.map((file) => ({
        ...file,
        preview: workspacePreviewDescriptor(file.path),
      })),
    })
  })
  app.get("/audits/:auditId/runs/:runId/files/preview", async (c) => {
    await requireAuditRun(services, c.req.param("auditId"), c.req.param("runId"))
    const artifactPath = c.req.query("path")
    if (!artifactPath) throw new HttpError(400, "invalid_audit_output_path", "缺少文件路径")
    const preview = workspacePreviewDescriptor(artifactPath)
    if (!preview) {
      throw new HttpError(415, "audit_output_preview_unsupported", "该输出文件类型不支持预览")
    }
    const listing = await listAuditOutputFiles(services, c.req.param("runId"))
    const file = listing.files.find((candidate) => candidate.path === artifactPath)
    if (!file) throw new HttpError(404, "audit_output_file_not_found", "输出文件不存在")
    if (file.size > WORKSPACE_PREVIEW_MAX_BYTES) {
      throw new HttpError(413, "audit_output_preview_too_large", "文件超过 256 KiB，无法在线预览")
    }
    let content: Uint8Array
    try {
      content = await readWorkspaceArtifact(
        auditOutputDirectory(services, c.req.param("runId")),
        artifactPath,
        WORKSPACE_PREVIEW_MAX_BYTES,
      )
    } catch {
      throw new HttpError(404, "audit_output_file_not_found", "输出文件不存在")
    }
    let text: string
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(content)
    } catch {
      throw new HttpError(415, "audit_output_preview_invalid_text", "文件不是有效的 UTF-8 文本")
    }
    c.header("Cache-Control", "no-store")
    return c.json({ path: artifactPath, size: content.byteLength, content: text, ...preview })
  })
  app.get("/audits/:auditId/runs/:runId/files/download", async (c) => {
    await requireAuditRun(services, c.req.param("auditId"), c.req.param("runId"))
    const artifactPath = c.req.query("path")
    if (!artifactPath) throw new HttpError(400, "invalid_audit_output_path", "缺少文件路径")
    let content: Uint8Array
    try {
      content = await readWorkspaceArtifact(
        auditOutputDirectory(services, c.req.param("runId")),
        artifactPath,
        64 * 1024 * 1024,
      )
    } catch {
      throw new HttpError(404, "audit_output_file_not_found", "输出文件不存在")
    }
    const name = basename(artifactPath)
    c.header("Content-Type", "application/octet-stream")
    c.header(
      "Content-Disposition",
      `attachment; filename="${filenameSafe(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    )
    c.header("Content-Length", String(content.byteLength))
    c.header("Cache-Control", "no-store")
    return c.body(Buffer.from(content))
  })
  app.patch("/audits/:auditId", async (c) => {
    const body = await parseJsonBody(c, codeAuditConfigSchema, { code: "invalid_audit_config" })
    const audit = await services.withAuditStore((store) =>
      store.update(c.req.param("auditId"), body),
    )
    if (!audit) throw new HttpError(404, "audit_not_found", "审计项目不存在")
    return c.json({ audit })
  })
  app.post("/audits/:auditId/runs", async (c) => {
    const body = await parseJsonBody(c, runSchema, { code: "invalid_audit_run" })
    const audit = await services.withAuditStore((store) => store.get(c.req.param("auditId")))
    if (!audit) throw new HttpError(404, "audit_not_found", "审计项目不存在")
    if (!audit.auditModelId)
      throw new HttpError(400, "audit_model_required", "请先在审计项目配置中选择模型")
    await services.validateAuditModel(audit.auditModelId)
    await services.preflightAudit()
    const run = await services.withAuditStore((store) => store.createRun(audit.id, body.mode))
    if (!run) throw new HttpError(404, "audit_not_found", "审计项目不存在")
    services.startAudit(run, audit)
    return c.json({ run }, 202)
  })
  app.post("/audits/:auditId/runs/:runId/follow-up", async (c) => {
    const body = await parseJsonBody(c, auditFollowUpSchema, { code: "invalid_audit_follow_up" })
    const audit = await services.withAuditStore((store) => store.get(c.req.param("auditId")))
    if (!audit) throw new HttpError(404, "audit_not_found", "审计项目不存在")
    const runs = await services.withAuditStore((store) => store.runs(audit.id))
    const parent = runs.find((run) => run.id === c.req.param("runId"))
    if (!parent) throw new HttpError(404, "audit_run_not_found", "审计运行不存在")
    if (["queued", "running", "paused", "blocked"].includes(parent.status)) {
      throw new HttpError(409, "audit_run_active", "请等待当前审计运行结束后再继续研究")
    }
    if (
      runs.some(
        (run) => run.status === "queued" || run.status === "running" || run.status === "paused",
      )
    ) {
      throw new HttpError(409, "audit_run_active", "该项目已有正在运行的审计")
    }
    if (!audit.auditModelId)
      throw new HttpError(400, "audit_model_required", "请先在审计项目配置中选择模型")
    await services.validateAuditModel(audit.auditModelId)
    await services.preflightAudit()
    const run = await services.withAuditStore((store) =>
      store.createRun(audit.id, parent.mode, {
        purpose: "follow_up",
        parentRunId: parent.id,
        followUpPrompt: body.prompt,
      }),
    )
    if (!run) throw new HttpError(404, "audit_not_found", "审计项目不存在")
    services.startAudit(run, audit)
    return c.json({ run }, 202)
  })
  app.post("/audits/:auditId/runs/:runId/resume-session", async (c) => {
    const run = await services.withAuditStore((store) =>
      store.runs(c.req.param("auditId")).find((item) => item.id === c.req.param("runId")),
    )
    if (!run) throw new HttpError(404, "audit_run_not_found", "审计运行不存在")
    throw new HttpError(
      409,
      "audit_session_unavailable",
      "Codex Security 当前仅支持重新运行；上次 Worker 的会话文件和运行卷已在退出时清理，无法安全恢复上下文。",
    )
  })
  app.post("/audits/:auditId/runs/:runId/:action", async (c) => {
    const run = await services.withAuditStore((store) =>
      store.runs(c.req.param("auditId")).find((item) => item.id === c.req.param("runId")),
    )
    if (!run) throw new HttpError(404, "audit_run_not_found", "审计运行不存在")
    const action = c.req.param("action")
    if (action === "cancel") {
      services.cancelAudit(run.id)
    } else if (action === "pause") {
      if (run.status !== "running")
        throw new HttpError(409, "audit_run_not_active", "审计运行当前不可暂停")
      await services.pauseAudit(run.id)
      await services.withAuditStore((store) => store.updateRun(run.id, { status: "paused" }))
    } else if (action === "resume") {
      if (run.status !== "paused")
        throw new HttpError(409, "audit_run_not_active", "审计运行当前不可恢复")
      await services.resumeAudit(run.id)
      await services.withAuditStore((store) => store.updateRun(run.id, { status: "running" }))
    } else throw new HttpError(400, "invalid_audit_action", "不支持的审计操作")
    return c.json({ action })
  })
  app.post("/audits/upload", async (c) => {
    const archiveName = basename(c.req.header("x-archive-name") ?? "source.zip")
    if (!/\.(zip|tar|tgz|gz)$/i.test(archiveName))
      throw new HttpError(400, "invalid_archive", "仅支持 zip、tar 或 tgz 压缩包")
    const buffer = Buffer.from(await c.req.raw.arrayBuffer())
    if (buffer.byteLength < 1 || buffer.byteLength > 250 * 1024 * 1024)
      throw new HttpError(413, "archive_size_invalid", "压缩包必须介于 1 B 和 250 MiB")
    const archivePath = join(services.auditArchiveDirectory, `${randomUUID()}-${archiveName}`)
    await mkdir(services.auditArchiveDirectory, { recursive: true })
    await writeFile(archivePath, buffer, { flag: "wx" })
    return c.json({ archiveName, archiveSize: buffer.byteLength, archivePath }, 201)
  })
  return app
}

const AUDIT_LOG_MAX_BYTES = 512 * 1024
const AUDIT_OUTPUT_MAX_FILES = 2_000

async function requireAuditRun(
  services: Services,
  auditId: string,
  runId: string,
): Promise<import("@ctf-agent/core").CodeAuditRun> {
  const run = await services.withAuditStore((store) =>
    store.runs(auditId).find((item) => item.id === runId),
  )
  if (!run) throw new HttpError(404, "audit_run_not_found", "审计运行不存在")
  return run
}

function auditOutputDirectory(services: Services, runId: string): string {
  return resolve(services.auditWorkDirectory, "runs", runId, "output")
}

function auditLogPath(services: Services, runId: string): string {
  return resolve(services.auditWorkDirectory, "runs", runId, "worker.log")
}

async function listAuditOutputFiles(
  services: Services,
  runId: string,
): Promise<WorkspaceArtifactListing> {
  return listWorkspaceArtifacts(auditOutputDirectory(services, runId), AUDIT_OUTPUT_MAX_FILES)
}

async function readAuditResult(
  services: Services,
  runId: string,
): Promise<{
  findings: import("@ctf-agent/core").CodeAuditFindingsDocument | null
  coverage: import("@ctf-agent/core").CodeAuditCoverageDocument | null
  manifest: import("@ctf-agent/core").CodeAuditManifest | null
}> {
  const [findings, coverage, manifest] = await Promise.all([
    readCanonicalJson(services, runId, "findings.json"),
    readCanonicalJson(services, runId, "coverage.json"),
    readCanonicalJson(services, runId, "scan-manifest.json"),
  ])
  return {
    findings: isFindingsDocument(findings) ? findings : null,
    coverage: isCoverageDocument(coverage) ? coverage : null,
    manifest: isManifestDocument(manifest) ? manifest : null,
  }
}

async function readCanonicalJson(
  services: Services,
  runId: string,
  name: string,
): Promise<unknown> {
  try {
    const content = await readFile(join(auditOutputDirectory(services, runId), name), "utf8")
    if (content.length > 12 * 1024 * 1024) {
      throw new HttpError(413, "audit_result_too_large", `${name} 超过 12 MiB，无法加载到 WebUI`)
    }
    return JSON.parse(content) as unknown
  } catch (error) {
    if (error instanceof HttpError) throw error
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw new HttpError(422, "audit_result_invalid", `${name} 不是有效的 JSON 产物`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isFindingsDocument(
  value: unknown,
): value is import("@ctf-agent/core").CodeAuditFindingsDocument {
  if (!isRecord(value) || !Array.isArray(value.findings)) return false
  return value.findings.every((finding) => {
    if (!isRecord(finding)) return false
    const severity = finding.severity
    const confidence = finding.confidence
    const taxonomy = finding.taxonomy
    return (
      typeof finding.findingId === "string" &&
      typeof finding.occurrenceId === "string" &&
      typeof finding.ruleId === "string" &&
      typeof finding.title === "string" &&
      typeof finding.summary === "string" &&
      typeof finding.remediation === "string" &&
      isRecord(severity) &&
      typeof severity.level === "string" &&
      isRecord(confidence) &&
      typeof confidence.level === "string" &&
      typeof confidence.rationale === "string" &&
      isRecord(taxonomy) &&
      typeof taxonomy.category === "string" &&
      Array.isArray(taxonomy.cwe) &&
      taxonomy.cwe.every((cwe) => typeof cwe === "string") &&
      Array.isArray(finding.locations) &&
      finding.locations.every(
        (location) =>
          isRecord(location) &&
          typeof location.path === "string" &&
          typeof location.startLine === "number",
      ) &&
      isRecord(finding.identity) &&
      isRecord(finding.fingerprints) &&
      isRecord(finding.provenance)
    )
  })
}

function isCoverageDocument(
  value: unknown,
): value is import("@ctf-agent/core").CodeAuditCoverageDocument {
  if (!isRecord(value) || !Array.isArray(value.surfaces) || !Array.isArray(value.deferred)) {
    return false
  }
  return (
    typeof value.completeness === "string" &&
    typeof value.mode === "string" &&
    Array.isArray(value.includePaths) &&
    value.includePaths.every((path) => typeof path === "string") &&
    Array.isArray(value.excludePaths) &&
    value.excludePaths.every((path) => typeof path === "string") &&
    value.surfaces.every(
      (surface) =>
        isRecord(surface) &&
        typeof surface.id === "string" &&
        typeof surface.label === "string" &&
        typeof surface.disposition === "string" &&
        Array.isArray(surface.receiptRefs) &&
        surface.receiptRefs.every((receipt) => typeof receipt === "string"),
    ) &&
    value.deferred.every(
      (item) => isRecord(item) && typeof item.id === "string" && typeof item.reason === "string",
    )
  )
}

function isManifestDocument(value: unknown): value is import("@ctf-agent/core").CodeAuditManifest {
  if (!isRecord(value) || !isRecord(value.scan)) return false
  const scan = value.scan
  return (
    isRecord(scan.target) &&
    isRecord(scan.producer) &&
    isRecord(scan.scope) &&
    Array.isArray(scan.artifacts) &&
    typeof scan.id === "string"
  )
}

async function readAuditLog(
  services: Services,
  runId: string,
): Promise<{
  text: string
  offset: number
  total: number
  updatedAt: string | null
}> {
  try {
    const [text, metadata] = await Promise.all([
      readFile(auditLogPath(services, runId), "utf8"),
      stat(auditLogPath(services, runId)),
    ])
    const offset = Math.max(0, text.length - AUDIT_LOG_MAX_BYTES)
    return {
      text: text.slice(offset),
      offset,
      total: text.length,
      updatedAt: metadata.mtime.toISOString(),
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { text: "", offset: 0, total: 0, updatedAt: null }
    }
    throw error
  }
}

function auditLogStream(
  c: AppContext,
  services: Services,
  auditId: string,
  runId: string,
): Response {
  c.header("Content-Type", "text/event-stream; charset=utf-8")
  c.header("Cache-Control", "no-cache, no-transform")
  c.header("Connection", "keep-alive")
  c.header("X-Accel-Buffering", "no")
  return streamSSE(c, async (stream) => {
    let offset = 0
    let aborted = false
    let lastHeartbeat = Date.now()
    stream.onAbort(() => {
      aborted = true
    })
    await stream.write(": connected\n\n")
    try {
      while (!aborted) {
        const snapshot = await readAuditLog(services, runId)
        if (snapshot.total < offset) offset = 0
        const availableEnd = snapshot.offset + snapshot.text.length
        if (availableEnd > offset) {
          const start = Math.max(offset, snapshot.offset)
          const text = snapshot.text.slice(start - snapshot.offset)
          await stream.writeSSE({
            event: "audit_log",
            data: JSON.stringify({ runId, offset: start, total: snapshot.total, text }),
          })
          offset = start + text.length
        }
        const run = await services.withAuditStore((store) =>
          store.runs(auditId).find((item) => item.id === runId),
        )
        if (!run) break
        if (["completed", "failed", "cancelled"].includes(run.status) && offset >= snapshot.total) {
          break
        }
        if (Date.now() - lastHeartbeat >= 15_000) {
          await stream.write(": heartbeat\n\n")
          lastHeartbeat = Date.now()
        }
        await waitForAuditLog(750)
      }
    } catch (error) {
      if (!aborted) throw error
    }
  })
}

async function waitForAuditLog(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds))
}

function filenameSafe(value: string): string {
  return value.replace(/[^\\w.\\-]+/g, "_").slice(0, 160) || "audit-output"
}

function archiveContainerAccess(path: string): { arguments: string[]; path: string } {
  // In compose the backend sees /data inside its own container. Docker's daemon
  // cannot bind that container path, so mount only the named data volume—not the
  // whole WebUI container (which also carries the Docker socket).
  const volume = process.env.CTF_AGENT_DATA_VOLUME
  const dataRoot = "/data/.ctf-agent"
  if (process.env.CONTAINER_ENV === "docker" && volume && path.startsWith(`${dataRoot}/`)) {
    return {
      arguments: ["--mount", `type=volume,src=${volume},dst=${dataRoot},readonly`],
      path,
    }
  }
  return { arguments: ["--mount", `type=bind,src=${path},dst=/archive,readonly`], path: "/archive" }
}

function archiveFileListScript(archiveName: string, path: string): string {
  const kind = /\.zip$/i.test(archiveName) ? "zip" : "tar"
  return `import json, tarfile, zipfile\npath=${JSON.stringify(path)}\nkind='${kind}'\nentries=zipfile.ZipFile(path).infolist() if kind=='zip' else tarfile.open(path,'r:*').getmembers()\nnames=[item.filename if kind=='zip' else item.name for item in entries]\ndef safe(name):\n n=name.replace('\\\\','/'); return n and not n.startswith('/') and '..' not in n.split('/')\nif len(names)>100000 or any(not safe(name) for name in names): raise SystemExit(1)\nfiles=sorted({name.rstrip('/') for name in names if not name.endswith('/')})\nroots={name.split('/',1)[0] for name in files}\nif len(roots)==1 and all('/' in name for name in files):\n root=next(iter(roots)); files=[name[len(root)+1:] for name in files]\nprint(json.dumps(files))`
}

const codeAuditConfigSchema = z
  .object({
    includePaths: z.array(z.string().trim().min(1).max(1_024)).max(256),
    excludePaths: z.array(z.string().trim().min(1).max(1_024)).max(256),
    auditModelId: z.string().trim().min(1).max(256),
  })
  .strict()
const runSchema = z.object({ mode: z.enum(["standard", "deep"]) }).strict()
