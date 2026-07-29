import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"

export type RunStatus =
  | "preparing"
  | "running"
  | "solved"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "closed"
  | "interrupted"

export type RunCloseReason = "submitted" | "manual" | "failed" | "timed_out" | "cancelled" | "interrupted"

export interface RunRecord {
  id: string
  challengeId: string
  workspace: string
  attempt: number
  status: RunStatus
  closeReason?: RunCloseReason
  error?: string
  cleanupError?: string
  createdAt: string
  updatedAt: string
  startedAt?: string
  finishedAt?: string
}

export interface RunEvent {
  id: number
  runId: string
  type: string
  data?: unknown
  createdAt: string
}

export interface CreateRunRecord {
  id: string
  challengeId: string
  workspace: string
  attempt: number
  createdAt?: string
}

export interface UpdateRunRecord {
  status?: RunStatus
  closeReason?: RunCloseReason | null
  error?: string | null
  cleanupError?: string | null
  startedAt?: string | null
  finishedAt?: string | null
}

export interface RunFilter {
  challengeId?: string
  status?: RunStatus | readonly RunStatus[]
}

interface RunRow {
  id: string
  challenge_id: string
  workspace: string
  attempt: number
  status: RunStatus
  close_reason: RunCloseReason | null
  error: string | null
  cleanup_error: string | null
  created_at: string
  updated_at: string
  started_at: string | null
  finished_at: string | null
}

interface EventRow {
  id: number
  run_id: string
  type: string
  data_json: string | null
  created_at: string
}

function runFromRow(row: RunRow): RunRecord {
  return {
    id: row.id,
    challengeId: row.challenge_id,
    workspace: row.workspace,
    attempt: row.attempt,
    status: row.status,
    ...(row.close_reason ? { closeReason: row.close_reason } : {}),
    ...(row.error ? { error: row.error } : {}),
    ...(row.cleanup_error ? { cleanupError: row.cleanup_error } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
  }
}

/**
 * SQLite-backed authoritative Run state.
 *
 * DatabaseSync calls are deliberately wrapped in a small synchronous critical
 * section. Node's event loop serializes calls in one process, while WAL and the
 * busy timeout protect readers and a second diagnostic process.
 */
export class RunStore {
  private closed = false

  private constructor(
    readonly path: string,
    private readonly database: DatabaseSync,
  ) {}

  static async open(path: string): Promise<RunStore> {
    await mkdir(dirname(path), { recursive: true })
    const database = new DatabaseSync(path)
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        challenge_id TEXT NOT NULL,
        workspace TEXT NOT NULL,
        attempt INTEGER NOT NULL CHECK (attempt >= 1),
        status TEXT NOT NULL,
        close_reason TEXT,
        error TEXT,
        cleanup_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      ) STRICT;

      CREATE UNIQUE INDEX IF NOT EXISTS runs_challenge_attempt
        ON runs(challenge_id, attempt);
      CREATE INDEX IF NOT EXISTS runs_challenge_status
        ON runs(challenge_id, status);

      CREATE TABLE IF NOT EXISTS run_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        data_json TEXT,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS run_events_run_id
        ON run_events(run_id, id);
    `)
    return new RunStore(path, database)
  }

  createRun(input: CreateRunRecord): RunRecord {
    this.assertOpen()
    const timestamp = input.createdAt ?? new Date().toISOString()
    this.database.exec("BEGIN IMMEDIATE")
    try {
      this.database.prepare(`
        INSERT INTO runs (
          id, challenge_id, workspace, attempt, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'preparing', ?, ?)
      `).run(input.id, input.challengeId, input.workspace, input.attempt, timestamp, timestamp)
      this.insertEvent(input.id, "run_created", { attempt: input.attempt }, timestamp)
      this.database.exec("COMMIT")
    } catch (error) {
      this.database.exec("ROLLBACK")
      throw error
    }
    return this.getRunOrThrow(input.id)
  }

  getRun(id: string): RunRecord | undefined {
    this.assertOpen()
    const row = this.database.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRow | undefined
    return row ? runFromRow(row) : undefined
  }

  listRuns(filter: RunFilter = {}): RunRecord[] {
    this.assertOpen()
    const clauses: string[] = []
    const parameters: Array<string> = []
    if (filter.challengeId) {
      clauses.push("challenge_id = ?")
      parameters.push(filter.challengeId)
    }
    if (filter.status) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status]
      if (statuses.length === 0) return []
      clauses.push(`status IN (${statuses.map(() => "?").join(", ")})`)
      parameters.push(...statuses)
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""
    const rows = this.database.prepare(`
      SELECT * FROM runs ${where}
      ORDER BY created_at ASC, id ASC
    `).all(...parameters) as unknown as RunRow[]
    return rows.map(runFromRow)
  }

  updateRun(id: string, patch: UpdateRunRecord, eventType = "run_updated", eventData?: unknown): RunRecord {
    this.assertOpen()
    const current = this.getRunOrThrow(id)
    const timestamp = new Date().toISOString()
    const closeReason = patch.closeReason === undefined ? current.closeReason ?? null : patch.closeReason
    const error = patch.error === undefined ? current.error ?? null : patch.error
    const cleanupError = patch.cleanupError === undefined ? current.cleanupError ?? null : patch.cleanupError
    const startedAt = patch.startedAt === undefined ? current.startedAt ?? null : patch.startedAt
    const finishedAt = patch.finishedAt === undefined ? current.finishedAt ?? null : patch.finishedAt
    const status = patch.status ?? current.status

    this.database.exec("BEGIN IMMEDIATE")
    try {
      this.database.prepare(`
        UPDATE runs
        SET status = ?, close_reason = ?, error = ?, cleanup_error = ?,
            updated_at = ?, started_at = ?, finished_at = ?
        WHERE id = ?
      `).run(status, closeReason, error, cleanupError, timestamp, startedAt, finishedAt, id)
      this.insertEvent(id, eventType, eventData ?? patch, timestamp)
      this.database.exec("COMMIT")
    } catch (updateError) {
      this.database.exec("ROLLBACK")
      throw updateError
    }
    return this.getRunOrThrow(id)
  }

  markInterruptedRuns(message = "进程退出时 Run 未进入终态"): RunRecord[] {
    this.assertOpen()
    const active = this.listRuns({ status: ["preparing", "running"] })
    return active.map((run) => this.updateRun(run.id, {
      status: "interrupted",
      closeReason: "interrupted",
      error: message,
      finishedAt: new Date().toISOString(),
    }, "run_interrupted", { previousStatus: run.status }))
  }

  nextAttempt(challengeId: string): number {
    this.assertOpen()
    const row = this.database.prepare(`
      SELECT COALESCE(MAX(attempt), 0) AS attempt
      FROM runs
      WHERE challenge_id = ?
    `).get(challengeId) as { attempt: number }
    return row.attempt + 1
  }

  isSolved(challengeId: string): boolean {
    this.assertOpen()
    const row = this.database.prepare(`
      SELECT 1 AS solved
      FROM runs
      WHERE challenge_id = ? AND status = 'solved'
      LIMIT 1
    `).get(challengeId)
    return row !== undefined
  }

  events(runId: string): RunEvent[] {
    this.assertOpen()
    const rows = this.database.prepare(`
      SELECT * FROM run_events
      WHERE run_id = ?
      ORDER BY id ASC
    `).all(runId) as unknown as EventRow[]
    return rows.map((row) => ({
      id: row.id,
      runId: row.run_id,
      type: row.type,
      ...(row.data_json ? { data: JSON.parse(row.data_json) as unknown } : {}),
      createdAt: row.created_at,
    }))
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.database.close()
  }

  private getRunOrThrow(id: string): RunRecord {
    const run = this.getRun(id)
    if (!run) throw new Error(`RunStore 中不存在 Run: ${id}`)
    return run
  }

  private insertEvent(runId: string, type: string, data: unknown, timestamp: string): void {
    this.database.prepare(`
      INSERT INTO run_events (run_id, type, data_json, created_at)
      VALUES (?, ?, ?, ?)
    `).run(runId, type, data === undefined ? null : JSON.stringify(data), timestamp)
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("RunStore 已关闭")
  }
}
