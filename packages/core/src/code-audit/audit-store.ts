import { randomUUID } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"
import type {
  CodeAuditProject,
  CodeAuditProgress,
  CodeAuditRun,
  CreateCodeAuditProject,
  CreateCodeAuditRunOptions,
  UpdateCodeAuditProject,
} from "./types.ts"

/** 独立审计域的权威持久化；绝不借用 CTF Project/RunStore。 */
export class AuditStore {
  private constructor(private readonly database: DatabaseSync) {}

  static async open(path: string): Promise<AuditStore> {
    await mkdir(dirname(path), { recursive: true })
    const database = new DatabaseSync(path)
    database.exec("PRAGMA foreign_keys = ON")
    database.exec("PRAGMA journal_mode = WAL")
    database.exec(`
      CREATE TABLE IF NOT EXISTS audit_projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, archive_name TEXT NOT NULL,
        archive_size INTEGER NOT NULL, archive_path TEXT NOT NULL, status TEXT NOT NULL,
        include_paths TEXT NOT NULL DEFAULT '[]', exclude_paths TEXT NOT NULL DEFAULT '[]',
        audit_model_id TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit_runs (
        id TEXT PRIMARY KEY, audit_project_id TEXT NOT NULL REFERENCES audit_projects(id) ON DELETE CASCADE,
        status TEXT NOT NULL, mode TEXT NOT NULL, purpose TEXT NOT NULL DEFAULT 'scan',
        parent_run_id TEXT, follow_up_prompt TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        progress_phase TEXT, progress_message TEXT, progress_files_completed INTEGER, progress_files_total INTEGER, progress_updated_at TEXT
      );
      CREATE TABLE IF NOT EXISTS audit_reports (
        run_id TEXT PRIMARY KEY REFERENCES audit_runs(id) ON DELETE CASCADE,
        markdown TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit_findings (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES audit_runs(id) ON DELETE CASCADE,
        finding_id TEXT NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL, severity TEXT NOT NULL,
        confidence TEXT NOT NULL, path TEXT NOT NULL, start_line INTEGER NOT NULL, remediation TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS audit_findings_run_id ON audit_findings(run_id, severity);
      CREATE INDEX IF NOT EXISTS audit_projects_updated_at ON audit_projects(updated_at DESC);
      CREATE INDEX IF NOT EXISTS audit_runs_project_created_at ON audit_runs(audit_project_id, created_at DESC);
    `)
    ensureColumn(database, "audit_projects", "audit_model_id", "TEXT NOT NULL DEFAULT ''")
    ensureColumn(database, "audit_runs", "purpose", "TEXT NOT NULL DEFAULT 'scan'")
    ensureColumn(database, "audit_runs", "parent_run_id", "TEXT")
    ensureColumn(database, "audit_runs", "follow_up_prompt", "TEXT")
    ensureColumn(database, "audit_runs", "progress_phase", "TEXT")
    ensureColumn(database, "audit_runs", "progress_message", "TEXT")
    ensureColumn(database, "audit_runs", "progress_files_completed", "INTEGER")
    ensureColumn(database, "audit_runs", "progress_files_total", "INTEGER")
    ensureColumn(database, "audit_runs", "progress_updated_at", "TEXT")
    return new AuditStore(database)
  }

  list(): CodeAuditProject[] {
    return (
      this.database
        .prepare("SELECT * FROM audit_projects ORDER BY updated_at DESC")
        .all() as unknown as ProjectRow[]
    ).map(toProject)
  }

  get(id: string): CodeAuditProject | undefined {
    const row = this.database
      .prepare("SELECT * FROM audit_projects WHERE id = ?")
      .get(id) as unknown as ProjectRow | undefined
    return row ? toProject(row) : undefined
  }

  create(input: CreateCodeAuditProject): CodeAuditProject {
    const now = new Date().toISOString()
    const record: CodeAuditProject = {
      id: randomUUID(),
      name: text(input.name, "审计项目名称"),
      archiveName: text(input.archiveName, "压缩包名称"),
      archiveSize: positive(input.archiveSize, "压缩包大小"),
      archivePath: text(input.archivePath, "压缩包路径"),
      status: "draft",
      includePaths: [],
      excludePaths: [],
      auditModelId: "",
      createdAt: now,
      updatedAt: now,
    }
    this.database
      .prepare(
        "INSERT INTO audit_projects (id, name, archive_name, archive_size, archive_path, status, include_paths, exclude_paths, created_at, updated_at, audit_model_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        record.id,
        record.name,
        record.archiveName,
        record.archiveSize,
        record.archivePath,
        record.status,
        "[]",
        "[]",
        now,
        now,
        "",
      )
    return record
  }

  delete(id: string): boolean {
    return this.database.prepare("DELETE FROM audit_projects WHERE id = ?").run(id).changes > 0
  }

  update(id: string, input: UpdateCodeAuditProject): CodeAuditProject | undefined {
    const current = this.get(id)
    if (!current) return undefined
    const now = new Date().toISOString()
    const includePaths = paths(input.includePaths)
    const excludePaths = paths(input.excludePaths)
    this.database
      .prepare(
        "UPDATE audit_projects SET include_paths = ?, exclude_paths = ?, audit_model_id = ?, status = ?, updated_at = ? WHERE id = ?",
      )
      .run(
        JSON.stringify(includePaths),
        JSON.stringify(excludePaths),
        text(input.auditModelId, "审计模型"),
        "ready",
        now,
        id,
      )
    return this.get(id)
  }

  createRun(
    auditProjectId: string,
    mode: "standard" | "deep",
    options: Omit<CreateCodeAuditRunOptions, "mode"> = {},
  ): CodeAuditRun | undefined {
    const project = this.get(auditProjectId)
    if (!project) return undefined
    const now = new Date().toISOString()
    const purpose = options.purpose ?? "scan"
    const run: CodeAuditRun = {
      id: randomUUID(),
      auditProjectId,
      mode,
      purpose,
      ...(options.parentRunId ? { parentRunId: options.parentRunId } : {}),
      ...(options.followUpPrompt ? { followUpPrompt: options.followUpPrompt } : {}),
      status: "blocked",
      createdAt: now,
      updatedAt: now,
      error: "Codex Security worker 尚未配置",
    }
    this.database
      .prepare(
        "INSERT INTO audit_runs (id, audit_project_id, status, mode, purpose, parent_run_id, follow_up_prompt, error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        run.id,
        run.auditProjectId,
        run.status,
        run.mode,
        run.purpose,
        run.parentRunId ?? null,
        run.followUpPrompt ?? null,
        run.error ?? null,
        now,
        now,
      )
    return run
  }

  updateRun(
    id: string,
    update: {
      status: CodeAuditRun["status"]
      error?: string | null
      progress?: CodeAuditProgress | null
    },
  ): CodeAuditRun | undefined {
    const now = new Date().toISOString()
    if (update.progress === undefined) {
      this.database
        .prepare("UPDATE audit_runs SET status = ?, error = ?, updated_at = ? WHERE id = ?")
        .run(update.status, update.error ?? null, now, id)
    } else {
      const progress = update.progress
      this.database
        .prepare(
          "UPDATE audit_runs SET status = ?, error = ?, updated_at = ?, progress_phase = ?, progress_message = ?, progress_files_completed = ?, progress_files_total = ?, progress_updated_at = ? WHERE id = ?",
        )
        .run(
          update.status,
          update.error ?? null,
          now,
          progress?.phase ?? null,
          progress?.message ?? null,
          progress?.filesCompleted ?? null,
          progress?.filesTotal ?? null,
          progress?.updatedAt ?? null,
          id,
        )
    }
    const row = this.database
      .prepare("SELECT * FROM audit_runs WHERE id = ?")
      .get(id) as unknown as RunRow | undefined
    return row ? toRun(row) : undefined
  }

  interruptActiveRuns(): number {
    const now = new Date().toISOString()
    const result = this.database
      .prepare(
        "UPDATE audit_runs SET status = 'failed', error = 'Backend restarted before the audit worker completed', updated_at = ? WHERE status IN ('queued', 'running', 'paused')",
      )
      .run(now)
    return Number(result.changes)
  }

  saveReport(runId: string, markdown: string): void {
    this.database
      .prepare(
        "INSERT INTO audit_reports (run_id, markdown) VALUES (?, ?) ON CONFLICT(run_id) DO UPDATE SET markdown = excluded.markdown",
      )
      .run(runId, markdown)
  }

  report(runId: string): string | undefined {
    const row = this.database
      .prepare("SELECT markdown FROM audit_reports WHERE run_id = ?")
      .get(runId) as unknown as { markdown: string } | undefined
    return row?.markdown
  }

  replaceFindings(runId: string, findings: readonly import("./types.ts").CodeAuditFinding[]): void {
    this.database.prepare("DELETE FROM audit_findings WHERE run_id = ?").run(runId)
    const insert = this.database.prepare(
      "INSERT INTO audit_findings VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    for (const finding of findings) {
      insert.run(
        finding.id,
        finding.runId,
        finding.findingId,
        finding.title,
        finding.summary,
        finding.severity,
        finding.confidence,
        finding.path,
        finding.startLine,
        finding.remediation,
      )
    }
  }

  findings(runId: string): import("./types.ts").CodeAuditFinding[] {
    return (
      this.database
        .prepare(
          "SELECT * FROM audit_findings WHERE run_id = ? ORDER BY CASE severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 ELSE 5 END",
        )
        .all(runId) as unknown as FindingRow[]
    ).map(toFinding)
  }

  runs(auditProjectId: string): CodeAuditRun[] {
    return (
      this.database
        .prepare(
          "SELECT * FROM audit_runs WHERE audit_project_id = ? ORDER BY created_at DESC, rowid DESC",
        )
        .all(auditProjectId) as unknown as RunRow[]
    ).map(toRun)
  }

  close(): void {
    this.database.close()
  }
}

type ProjectRow = {
  id: string
  name: string
  archive_name: string
  archive_size: number
  archive_path: string
  status: CodeAuditProject["status"]
  include_paths: string
  exclude_paths: string
  audit_model_id: string
  created_at: string
  updated_at: string
}
type FindingRow = {
  id: string
  run_id: string
  finding_id: string
  title: string
  summary: string
  severity: import("./types.ts").CodeAuditFinding["severity"]
  confidence: import("./types.ts").CodeAuditFinding["confidence"]
  path: string
  start_line: number
  remediation: string
}
function toFinding(row: FindingRow): import("./types.ts").CodeAuditFinding {
  return {
    id: row.id,
    runId: row.run_id,
    findingId: row.finding_id,
    title: row.title,
    summary: row.summary,
    severity: row.severity,
    confidence: row.confidence,
    path: row.path,
    startLine: row.start_line,
    remediation: row.remediation,
  }
}
type RunRow = {
  id: string
  audit_project_id: string
  status: CodeAuditRun["status"]
  mode: CodeAuditRun["mode"]
  purpose: CodeAuditRun["purpose"]
  parent_run_id: string | null
  follow_up_prompt: string | null
  error: string | null
  created_at: string
  updated_at: string
  progress_phase: string | null
  progress_message: string | null
  progress_files_completed: number | null
  progress_files_total: number | null
  progress_updated_at: string | null
}
function toProject(row: ProjectRow): CodeAuditProject {
  return {
    id: row.id,
    name: row.name,
    archiveName: row.archive_name,
    archiveSize: row.archive_size,
    archivePath: row.archive_path,
    status: row.status,
    includePaths: JSON.parse(row.include_paths) as string[],
    excludePaths: JSON.parse(row.exclude_paths) as string[],
    auditModelId: row.audit_model_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
function toRun(row: RunRow): CodeAuditRun {
  const progress =
    row.progress_phase && row.progress_message && row.progress_updated_at
      ? {
          phase: row.progress_phase,
          message: row.progress_message,
          updatedAt: row.progress_updated_at,
          ...(row.progress_files_completed === null
            ? {}
            : { filesCompleted: row.progress_files_completed }),
          ...(row.progress_files_total === null ? {} : { filesTotal: row.progress_files_total }),
        }
      : undefined
  return {
    id: row.id,
    auditProjectId: row.audit_project_id,
    status: row.status,
    mode: row.mode,
    purpose: row.purpose,
    ...(row.parent_run_id ? { parentRunId: row.parent_run_id } : {}),
    ...(row.follow_up_prompt ? { followUpPrompt: row.follow_up_prompt } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.error ? { error: row.error } : {}),
    ...(progress ? { progress } : {}),
  }
}
function ensureColumn(
  database: DatabaseSync,
  table: string,
  column: string,
  definition: string,
): void {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  if (!columns.some((item) => item.name === column)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }
}

function text(value: string, label: string): string {
  const next = value.trim()
  if (
    !next ||
    Array.from(next).some((character) => character.charCodeAt(0) <= 0x1f || character === "\x7f")
  )
    throw new Error(`${label}无效`)
  return next
}
function positive(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label}无效`)
  return value
}
function paths(value: string[]): string[] {
  return value.map((item) => text(item, "路径")).slice(0, 256)
}
