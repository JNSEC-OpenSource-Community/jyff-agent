import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"
import type { SubagentRecord } from "../collaboration/subagent-manager.ts"

export type RunStatus =
  | "preparing"
  | "running"
  | "solved"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "closed"
  | "interrupted"
  | "blocking"
  | "blocked"
  | "writing_writeup"

export type RunSource =
  | "direct"
  | "auto"
  | "manual"
  | "retry"
  | "revival"
  | "test"

export type RunCloseReason =
  | "submitted"
  | "manual"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "interrupted"
  | "blocked"

export interface RunRecord {
  id: string
  challengeId: string
  workspace: string
  attempt: number
  source: RunSource
  status: RunStatus
  closeReason?: RunCloseReason
  error?: string
  cleanupError?: string
  createdAt: string
  updatedAt: string
  startedAt?: string
  finishedAt?: string
}

/**
 * RunEvent.type 已知 kind 集合。
 * 保留 string 逃逸口：run_events 表按透传持久化任意 kind（见 appendEvent），
 * 已知集合仅用于窄化与文档化。
 */
export type RunEventType =
  | "run_created"
  | "run_started"
  | "run_updated"
  | "run_finished"
  | "run_interrupted"
  | "agent_started"
  | "tool_started"
  | "tool_finished"
  | "flag_submitted"
  | "agent_thinking"
  | "agent_usage"
  | "thinking_level_update"
  | "human_message"
  | "agent_message"
  | (string & {})

export interface RunEvent {
  id: number
  runId: string
  type: RunEventType
  data?: unknown
  createdAt: string
}

export interface CreateRunRecord {
  id: string
  challengeId: string
  workspace: string
  attempt: number
  source?: RunSource
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

export interface EvidenceRecord {
  id: number
  challengeId: string
  description: string
  runId: string
  createdAt: string
}

export type OpportunityStatus = "open" | "concluded"
export type OpportunityResolution = "confirmed" | "dead_end"

export interface OpportunityRecord {
  id: number
  challengeId: string
  description: string
  status: OpportunityStatus
  resolution: OpportunityResolution | null
  runId: string
  sourceEvidenceIds: number[]
  targetEvidenceId: number | null
  createdAt: string
  concludedAt: string | null
}

export interface BlackboardSummary {
  evidence: { id: number; description: string; runId: string }[]
  opportunities: {
    id: number
    description: string
    status: OpportunityStatus
    resolution: OpportunityResolution | null
    sourceEvidenceIds: number[]
    targetEvidenceId: number | null
  }[]
}

export interface ChallengeRuntimeState {
  challengeId: string
  blockScore: number
  baseBlockThreshold: number
  revivalCount: number
  effectiveBlockThreshold: number
  blocked: boolean
  blockedAt: string | null
  blockedRunId: string | null
  lifecycleGeneration: number
  /** Legacy audit field; the v2 supervisor must not write it. */
  sessionInterruptions: number
  updatedAt: string | null
}

export interface RecordChallengeBlockEvent {
  challengeId: string
  runId: string
  eventKey: string
  delta: 0 | 1 | 2
  reason: string
  compactPerformed?: boolean
  createdAt?: string
}

export type SchedulerQueueLane = "normal" | "blocked"

export interface SchedulerQueueRecord {
  challengeId: string
  source: RunSource
  lane: SchedulerQueueLane
  position: number
  manualOverride: boolean
  enqueuedAt: string
  version: number
}

export interface EnqueueSchedulerChallenge {
  challengeId: string
  source: RunSource
  lane?: SchedulerQueueLane
  manualOverride?: boolean
  enqueuedAt?: string
}

export interface MoveSchedulerChallenge {
  challengeId: string
  position: number
  expectedVersion: number
  overrideBlockedLane?: boolean
}

export interface TldrRecord {
  challengeId: string
  content: string
  model: string
  sessionPath: string
  updatedAt: string
  error: string | null
}

export interface UpsertTldr {
  challengeId: string
  content?: string
  model: string
  sessionPath: string
  updatedAt?: string
  error?: string | null
}

export interface ContestAnnouncementRecord {
  key: string
  platformAnnouncementId: string
  revisionHash: string
  title: string
  content: string
  publishedAt: string
  kind: string
  classificationReason: string | null
  ignored: boolean
  firstSeenAt: string
  lastSeenAt: string
}

export interface PersistContestAnnouncement {
  key: string
  platformAnnouncementId: string
  revisionHash: string
  title: string
  content: string
  publishedAt: string
  kind: string
  classificationReason?: string
  ignored?: boolean
  seenAt?: string
}

export interface ChallengeAnnouncementRecord extends ContestAnnouncementRecord {
  challengeId: string
  matchType: string
  matchedValue: string
  linkedAt: string
}

export interface ChallengeBlockEvent {
  id: number
  challengeId: string
  runId: string
  eventKey: string
  delta: number
  reason: string
  scoreBefore: number
  scoreAfter: number
  threshold: number
  compactPerformed: boolean | null
  createdAt: string
}

export interface BlackboardStats {
  challengeId: string
  evidence: number
  openOpportunities: number
  concludedOpportunities: number
}

export interface ChallengeInfoForOrigin {
  title: string
  category: string
  score: number
  description: string
  attachments: { name: string; size?: number }[]
}

export const DEFAULT_BLOCK_THRESHOLD = 8
export const BLOCK_THRESHOLD_REVIVAL_INCREMENT = 4

export const BLACKBOARD_DESCRIPTION_MAX_LENGTH = 4_000
export const BLACKBOARD_ORIGIN_MAX_LENGTH = 8_000
export const BLACKBOARD_SOURCE_MAX_ITEMS = 32
export const BLACKBOARD_MAX_EVIDENCE_PER_CHALLENGE = 256
export const BLACKBOARD_MAX_OPPORTUNITIES_PER_CHALLENGE = 256

interface EvidenceRow {
  id: number
  challenge_id: string
  description: string
  run_id: string
  created_at: string
}

interface OpportunityRow {
  id: number
  challenge_id: string
  description: string
  status: string
  resolution: string | null
  run_id: string
  target_evidence_id: number | null
  created_at: string
  concluded_at: string | null
}

interface OpportunitySourceRow {
  opportunity_id: number
  evidence_id: number
}

interface RunRow {
  id: string
  challenge_id: string
  workspace: string
  attempt: number
  source: RunSource
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

interface SubagentRow {
  id: string
  run_id: string
  role: string
  display_name: string
  description: string
  status: SubagentRecord["status"]
  background: number
  prompt: string
  session_path: string
  container_cwd: string
  result: string | null
  error: string | null
  active_tool: string | null
  turns: number
  tool_uses: number
  total_tokens: number
  created_at: string
  updated_at: string
  started_at: string | null
  completed_at: string | null
}

interface TldrRow {
  challenge_id: string
  content: string
  model: string
  session_path: string
  updated_at: string
  error: string | null
}

interface ContestAnnouncementRow {
  announcement_key: string
  platform_announcement_id: string
  revision_hash: string
  title: string
  content: string
  published_at: string
  kind: string
  classification_reason: string | null
  ignored: number
  first_seen_at: string
  last_seen_at: string
}

interface ChallengeAnnouncementRow extends ContestAnnouncementRow {
  challenge_id: string
  match_type: string
  matched_value: string
  linked_at: string
}

interface SchedulerQueueRow {
  challenge_id: string
  source: RunSource
  lane: SchedulerQueueLane
  position: number
  manual_override: number
  enqueued_at: string
  version: number
}

interface ChallengeRuntimeStateRow {
  challenge_id: string
  session_interruptions: number
  blocked: number
  block_score: number
  base_block_threshold: number
  revival_count: number
  blocked_at: string | null
  blocked_run_id: string | null
  lifecycle_generation: number
  updated_at: string
}

interface ChallengeBlockEventRow {
  id: number
  challenge_id: string
  run_id: string
  event_key: string
  delta: number
  reason: string
  score_before: number
  score_after: number
  threshold: number
  compact_performed: number | null
  created_at: string
}

interface BlackboardStatsRow {
  challenge_id: string
  evidence_count: number
  open_count: number
  concluded_count: number
}

function opportunityFromRow(
  row: OpportunityRow,
  sourceEvidenceIds: number[],
): OpportunityRecord {
  return {
    id: row.id,
    challengeId: row.challenge_id,
    description: row.description,
    status: row.status as OpportunityStatus,
    resolution: row.resolution as OpportunityResolution | null,
    runId: row.run_id,
    sourceEvidenceIds,
    targetEvidenceId: row.target_evidence_id,
    createdAt: row.created_at,
    concludedAt: row.concluded_at,
  }
}

function evidenceToSummary(
  row: EvidenceRow,
): BlackboardSummary["evidence"][number] {
  return { id: row.id, description: row.description, runId: row.run_id }
}

function tldrFromRow(row: TldrRow): TldrRecord {
  return {
    challengeId: row.challenge_id,
    content: row.content,
    model: row.model,
    sessionPath: row.session_path,
    updatedAt: row.updated_at,
    error: row.error,
  }
}

function contestAnnouncementFromRow(
  row: ContestAnnouncementRow,
): ContestAnnouncementRecord {
  return {
    key: row.announcement_key,
    platformAnnouncementId: row.platform_announcement_id,
    revisionHash: row.revision_hash,
    title: row.title,
    content: row.content,
    publishedAt: row.published_at,
    kind: row.kind,
    classificationReason: row.classification_reason,
    ignored: row.ignored === 1,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  }
}

function schedulerQueueFromRow(row: SchedulerQueueRow): SchedulerQueueRecord {
  return {
    challengeId: row.challenge_id,
    source: row.source,
    lane: row.lane,
    position: row.position,
    manualOverride: row.manual_override === 1,
    enqueuedAt: row.enqueued_at,
    version: row.version,
  }
}

function challengeRuntimeStateFromRow(
  row: ChallengeRuntimeStateRow,
): ChallengeRuntimeState {
  return {
    challengeId: row.challenge_id,
    blockScore: row.block_score,
    baseBlockThreshold: row.base_block_threshold,
    revivalCount: row.revival_count,
    effectiveBlockThreshold:
      row.base_block_threshold +
      row.revival_count * BLOCK_THRESHOLD_REVIVAL_INCREMENT,
    blocked: row.blocked === 1,
    blockedAt: row.blocked_at,
    blockedRunId: row.blocked_run_id,
    lifecycleGeneration: row.lifecycle_generation,
    sessionInterruptions: row.session_interruptions,
    updatedAt: row.updated_at,
  }
}

function challengeBlockEventFromRow(
  row: ChallengeBlockEventRow,
): ChallengeBlockEvent {
  return {
    id: row.id,
    challengeId: row.challenge_id,
    runId: row.run_id,
    eventKey: row.event_key,
    delta: row.delta,
    reason: row.reason,
    scoreBefore: row.score_before,
    scoreAfter: row.score_after,
    threshold: row.threshold,
    compactPerformed:
      row.compact_performed === null ? null : row.compact_performed === 1,
    createdAt: row.created_at,
  }
}

function normalizedDescription(value: string, field: string): string {
  const normalized = value.trim()
  if (!normalized) throw new Error(`${field} must not be empty`)
  if (normalized.length > BLACKBOARD_DESCRIPTION_MAX_LENGTH) {
    throw new Error(
      `${field} must not exceed ${BLACKBOARD_DESCRIPTION_MAX_LENGTH} characters`,
    )
  }
  return normalized
}

function truncateOrigin(value: string): string {
  if (value.length <= BLACKBOARD_ORIGIN_MAX_LENGTH) return value
  const suffix =
    "\n[Origin truncated; consult the initial challenge_context for the complete challenge description.]"
  return value.slice(0, BLACKBOARD_ORIGIN_MAX_LENGTH - suffix.length) + suffix
}

function runFromRow(row: RunRow): RunRecord {
  return {
    id: row.id,
    challengeId: row.challenge_id,
    workspace: row.workspace,
    attempt: row.attempt,
    source: row.source,
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

function subagentFromRow(row: SubagentRow): SubagentRecord {
  return {
    id: row.id,
    runId: row.run_id,
    role: row.role,
    displayName: row.display_name,
    description: row.description,
    status: row.status,
    background: row.background === 1,
    prompt: row.prompt,
    sessionPath: row.session_path,
    containerCwd: row.container_cwd,
    ...(row.result === null ? {} : { result: row.result }),
    ...(row.error === null ? {} : { error: row.error }),
    ...(row.active_tool === null ? {} : { activeTool: row.active_tool }),
    turns: row.turns,
    toolUses: row.tool_uses,
    totalTokens: row.total_tokens,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.started_at === null ? {} : { startedAt: row.started_at }),
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
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
        source TEXT NOT NULL DEFAULT 'direct',
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

      CREATE TABLE IF NOT EXISTS run_subagents (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        display_name TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL,
        background INTEGER NOT NULL CHECK (background IN (0, 1)),
        prompt TEXT NOT NULL,
        session_path TEXT NOT NULL,
        container_cwd TEXT NOT NULL,
        result TEXT,
        error TEXT,
        active_tool TEXT,
        turns INTEGER NOT NULL DEFAULT 0,
        tool_uses INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT
      ) STRICT;

      CREATE INDEX IF NOT EXISTS run_subagents_run_status
        ON run_subagents(run_id, status, created_at);

      CREATE TABLE IF NOT EXISTS challenge_evidence (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        challenge_id   TEXT NOT NULL,
        description    TEXT NOT NULL,
        run_id         TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        created_at     TEXT NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_evidence_challenge
        ON challenge_evidence(challenge_id, id);

      CREATE TABLE IF NOT EXISTS challenge_opportunities (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        challenge_id        TEXT NOT NULL,
        description         TEXT NOT NULL,
        status              TEXT NOT NULL DEFAULT 'open'
                            CHECK (status IN ('open', 'concluded')),
        resolution          TEXT CHECK (resolution IN ('confirmed', 'dead_end')),
        run_id              TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        target_evidence_id  INTEGER REFERENCES challenge_evidence(id) ON DELETE SET NULL,
        created_at          TEXT NOT NULL,
        concluded_at        TEXT
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_opportunities_challenge
        ON challenge_opportunities(challenge_id, status);

      CREATE TABLE IF NOT EXISTS challenge_opportunity_sources (
        opportunity_id  INTEGER NOT NULL REFERENCES challenge_opportunities(id) ON DELETE CASCADE,
        evidence_id     INTEGER NOT NULL REFERENCES challenge_evidence(id) ON DELETE CASCADE,
        PRIMARY KEY (opportunity_id, evidence_id)
      );

      CREATE TABLE IF NOT EXISTS challenge_runtime_state (
        challenge_id TEXT PRIMARY KEY,
        session_interruptions INTEGER NOT NULL DEFAULT 0
          CHECK (session_interruptions >= 0),
        blocked INTEGER NOT NULL DEFAULT 0 CHECK (blocked IN (0, 1)),
        block_score INTEGER NOT NULL DEFAULT 0 CHECK (block_score >= 0),
        base_block_threshold INTEGER NOT NULL DEFAULT 8
          CHECK (base_block_threshold >= 0),
        revival_count INTEGER NOT NULL DEFAULT 0 CHECK (revival_count >= 0),
        blocked_at TEXT,
        blocked_run_id TEXT,
        lifecycle_generation INTEGER NOT NULL DEFAULT 0
          CHECK (lifecycle_generation >= 0),
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS challenge_block_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        challenge_id TEXT NOT NULL,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        event_key TEXT NOT NULL UNIQUE,
        delta INTEGER NOT NULL CHECK (delta IN (0, 1, 2)),
        reason TEXT NOT NULL,
        score_before INTEGER NOT NULL CHECK (score_before >= 0),
        score_after INTEGER NOT NULL CHECK (score_after >= 0),
        threshold INTEGER NOT NULL CHECK (threshold >= 0),
        compact_performed INTEGER CHECK (compact_performed IN (0, 1)),
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS challenge_block_events_challenge
        ON challenge_block_events(challenge_id, id);

      CREATE TABLE IF NOT EXISTS scheduler_queue (
        challenge_id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        lane TEXT NOT NULL CHECK (lane IN ('normal', 'blocked')),
        position INTEGER NOT NULL CHECK (position >= 1),
        manual_override INTEGER NOT NULL DEFAULT 0
          CHECK (manual_override IN (0, 1)),
        enqueued_at TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS scheduler_queue_order
        ON scheduler_queue(manual_override DESC, lane, position, enqueued_at);

      CREATE TABLE IF NOT EXISTS contest_announcements (
        announcement_key TEXT PRIMARY KEY,
        platform_announcement_id TEXT NOT NULL,
        revision_hash TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        published_at TEXT NOT NULL,
        kind TEXT NOT NULL,
        classification_reason TEXT,
        ignored INTEGER NOT NULL DEFAULT 0 CHECK (ignored IN (0, 1)),
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS challenge_tldr (
        challenge_id TEXT PRIMARY KEY,
        content TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL,
        session_path TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        error TEXT
      ) STRICT;

      CREATE TABLE IF NOT EXISTS challenge_announcements (
        challenge_id TEXT NOT NULL,
        announcement_key TEXT NOT NULL
          REFERENCES contest_announcements(announcement_key) ON DELETE CASCADE,
        match_type TEXT NOT NULL,
        matched_value TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (challenge_id, announcement_key)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS announcement_deliveries (
        challenge_id TEXT NOT NULL,
        announcement_key TEXT NOT NULL
          REFERENCES contest_announcements(announcement_key) ON DELETE CASCADE,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        queued_at TEXT,
        observed_at TEXT,
        last_error TEXT,
        PRIMARY KEY (challenge_id, announcement_key, run_id)
      ) STRICT;
    `)
    const runColumns = database
      .prepare("PRAGMA table_info(runs)")
      .all() as unknown as Array<{ name: string }>
    if (!runColumns.some((column) => column.name === "source")) {
      database.exec(
        "ALTER TABLE runs ADD COLUMN source TEXT NOT NULL DEFAULT 'direct'",
      )
    }

    const opportunityColumns = database
      .prepare("PRAGMA table_info(challenge_opportunities)")
      .all() as unknown as Array<{ name: string }>
    if (!opportunityColumns.some((column) => column.name === "resolution")) {
      database.exec(
        "ALTER TABLE challenge_opportunities ADD COLUMN resolution TEXT CHECK (resolution IN ('confirmed', 'dead_end'))",
      )
      database.exec(`
        UPDATE challenge_opportunities
        SET resolution = 'confirmed'
        WHERE status = 'concluded' AND resolution IS NULL
      `)
    }

    const runtimeColumns = database
      .prepare("PRAGMA table_info(challenge_runtime_state)")
      .all() as unknown as Array<{ name: string }>
    const hadBlockScore = runtimeColumns.some(
      (column) => column.name === "block_score",
    )
    const runtimeMigrations = [
      [
        "block_score",
        "ALTER TABLE challenge_runtime_state ADD COLUMN block_score INTEGER NOT NULL DEFAULT 0 CHECK (block_score >= 0)",
      ],
      [
        "base_block_threshold",
        `ALTER TABLE challenge_runtime_state ADD COLUMN base_block_threshold INTEGER NOT NULL DEFAULT ${DEFAULT_BLOCK_THRESHOLD} CHECK (base_block_threshold >= 0)`,
      ],
      [
        "revival_count",
        "ALTER TABLE challenge_runtime_state ADD COLUMN revival_count INTEGER NOT NULL DEFAULT 0 CHECK (revival_count >= 0)",
      ],
      [
        "blocked_at",
        "ALTER TABLE challenge_runtime_state ADD COLUMN blocked_at TEXT",
      ],
      [
        "blocked_run_id",
        "ALTER TABLE challenge_runtime_state ADD COLUMN blocked_run_id TEXT",
      ],
      [
        "lifecycle_generation",
        "ALTER TABLE challenge_runtime_state ADD COLUMN lifecycle_generation INTEGER NOT NULL DEFAULT 0 CHECK (lifecycle_generation >= 0)",
      ],
    ] as const
    const existingRuntimeColumns = new Set(
      runtimeColumns.map((column) => column.name),
    )
    database.exec("BEGIN IMMEDIATE")
    try {
      for (const [name, sql] of runtimeMigrations) {
        if (!existingRuntimeColumns.has(name)) database.exec(sql)
      }
      if (!hadBlockScore) {
        database.exec(`
          UPDATE challenge_runtime_state
          SET
            block_score = CASE
              WHEN blocked = 1 AND session_interruptions <= base_block_threshold
                THEN base_block_threshold + 1
              ELSE session_interruptions
            END,
            blocked_at = CASE WHEN blocked = 1 THEN updated_at ELSE NULL END,
            blocked_run_id = CASE WHEN blocked = 1 THEN (
              SELECT id FROM runs
              WHERE runs.challenge_id = challenge_runtime_state.challenge_id
                AND close_reason = 'blocked'
              ORDER BY attempt DESC
              LIMIT 1
            ) ELSE NULL END
        `)
      }

      // 旧库可能因崩溃窗口遗留同题多个 active Run。保留最新一个，
      // 其余标为 interrupted 后再建立数据库级唯一约束。
      const activeRows = database
        .prepare(`
          SELECT id, challenge_id FROM runs
          WHERE status IN ('preparing', 'running', 'blocking', 'writing_writeup')
          ORDER BY challenge_id ASC, created_at DESC, id DESC
        `)
        .all() as unknown as Array<{ id: string; challenge_id: string }>
      const activeChallenges = new Set<string>()
      const migrationTimestamp = new Date().toISOString()
      const interruptDuplicate = database.prepare(`
        UPDATE runs
        SET status = 'interrupted', close_reason = 'interrupted',
            error = COALESCE(error, ?), updated_at = ?,
            finished_at = COALESCE(finished_at, ?)
        WHERE id = ?
      `)
      const recordDuplicate = database.prepare(`
        INSERT INTO run_events (run_id, type, data_json, created_at)
        VALUES (?, 'run_interrupted', ?, ?)
      `)
      for (const row of activeRows) {
        if (!activeChallenges.has(row.challenge_id)) {
          activeChallenges.add(row.challenge_id)
          continue
        }
        const message = "数据库迁移修复了同题重复 active Run"
        interruptDuplicate.run(
          message,
          migrationTimestamp,
          migrationTimestamp,
          row.id,
        )
        recordDuplicate.run(
          row.id,
          JSON.stringify({ reason: "duplicate_active_run_migration" }),
          migrationTimestamp,
        )
      }
      database.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS runs_one_active_per_challenge
        ON runs(challenge_id)
        WHERE status IN ('preparing', 'running', 'blocking', 'writing_writeup')
      `)
      database.exec("COMMIT")
    } catch (error) {
      database.exec("ROLLBACK")
      database.close()
      throw error
    }
    return new RunStore(path, database)
  }

  createRun(input: CreateRunRecord): RunRecord {
    this.assertOpen()
    const timestamp = input.createdAt ?? new Date().toISOString()
    this.database.exec("BEGIN IMMEDIATE")
    try {
      this.database
        .prepare(`
        INSERT INTO runs (
          id, challenge_id, workspace, attempt, source, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'preparing', ?, ?)
      `)
        .run(
          input.id,
          input.challengeId,
          input.workspace,
          input.attempt,
          input.source ?? "direct",
          timestamp,
          timestamp,
        )
      this.insertEvent(
        input.id,
        "run_created",
        {
          attempt: input.attempt,
          source: input.source ?? "direct",
        },
        timestamp,
      )
      this.database.exec("COMMIT")
    } catch (error) {
      this.database.exec("ROLLBACK")
      throw error
    }
    return this.getRunOrThrow(input.id)
  }

  getRun(id: string): RunRecord | undefined {
    this.assertOpen()
    const row = this.database
      .prepare("SELECT * FROM runs WHERE id = ?")
      .get(id) as RunRow | undefined
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
      const statuses = Array.isArray(filter.status)
        ? filter.status
        : [filter.status]
      if (statuses.length === 0) return []
      clauses.push(`status IN (${statuses.map(() => "?").join(", ")})`)
      parameters.push(...statuses)
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""
    const rows = this.database
      .prepare(`
      SELECT * FROM runs ${where}
      ORDER BY created_at ASC, id ASC
    `)
      .all(...parameters) as unknown as RunRow[]
    return rows.map(runFromRow)
  }

  updateRun(
    id: string,
    patch: UpdateRunRecord,
    eventType = "run_updated",
    eventData?: unknown,
  ): RunRecord {
    this.assertOpen()
    const current = this.getRunOrThrow(id)
    const timestamp = new Date().toISOString()
    const closeReason =
      patch.closeReason === undefined
        ? (current.closeReason ?? null)
        : patch.closeReason
    const error =
      patch.error === undefined ? (current.error ?? null) : patch.error
    const cleanupError =
      patch.cleanupError === undefined
        ? (current.cleanupError ?? null)
        : patch.cleanupError
    const startedAt =
      patch.startedAt === undefined
        ? (current.startedAt ?? null)
        : patch.startedAt
    const finishedAt =
      patch.finishedAt === undefined
        ? (current.finishedAt ?? null)
        : patch.finishedAt
    const status = patch.status ?? current.status

    const recordsSessionInterruption =
      (closeReason === "interrupted" || closeReason === "blocked") &&
      current.closeReason !== "interrupted" &&
      current.closeReason !== "blocked"
    this.database.exec("BEGIN IMMEDIATE")
    try {
      this.database
        .prepare(`
        UPDATE runs
        SET status = ?, close_reason = ?, error = ?, cleanup_error = ?,
            updated_at = ?, started_at = ?, finished_at = ?
        WHERE id = ?
      `)
        .run(
          status,
          closeReason,
          error,
          cleanupError,
          timestamp,
          startedAt,
          finishedAt,
          id,
        )
      if (recordsSessionInterruption) {
        this.database
          .prepare(`
            INSERT INTO challenge_runtime_state (
              challenge_id, session_interruptions, blocked, block_score,
              blocked_at, blocked_run_id, updated_at
            ) VALUES (?, 1, ?, 1, ?, ?, ?)
            ON CONFLICT(challenge_id) DO UPDATE SET
              session_interruptions = session_interruptions + 1,
              block_score = block_score + 1,
              blocked = excluded.blocked,
              blocked_at = CASE
                WHEN excluded.blocked = 1
                  THEN COALESCE(blocked_at, excluded.blocked_at)
                ELSE blocked_at
              END,
              blocked_run_id = CASE
                WHEN excluded.blocked = 1 THEN excluded.blocked_run_id
                ELSE blocked_run_id
              END,
              updated_at = excluded.updated_at
          `)
          .run(
            current.challengeId,
            closeReason === "blocked" ? 1 : 0,
            closeReason === "blocked" ? timestamp : null,
            closeReason === "blocked" ? id : null,
            timestamp,
          )
      }
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
    return active.map((run) =>
      this.updateRun(
        run.id,
        {
          status: "interrupted",
          closeReason: "interrupted",
          error: message,
          finishedAt: new Date().toISOString(),
        },
        "run_interrupted",
        { previousStatus: run.status },
      ),
    )
  }

  nextAttempt(challengeId: string): number {
    this.assertOpen()
    const row = this.database
      .prepare(`
      SELECT COALESCE(MAX(attempt), 0) AS attempt
      FROM runs
      WHERE challenge_id = ?
    `)
      .get(challengeId) as { attempt: number }
    return row.attempt + 1
  }

  schedulerAttemptCount(challengeId: string): number {
    this.assertOpen()
    const row = this.database
      .prepare(`
      SELECT COUNT(*) AS attempts
      FROM runs
      WHERE challenge_id = ?
        AND source IN ('auto', 'manual', 'retry')
        AND COALESCE(close_reason, '') NOT IN ('interrupted', 'blocked')
        AND NOT EXISTS (
          SELECT 1
          FROM run_events
          WHERE run_events.run_id = runs.id
            AND run_events.type IN ('run_creation_failed', 'run_transient_failure')
            AND json_extract(run_events.data_json, '$.retryable') = 1
        )
    `)
      .get(challengeId) as { attempts: number }
    return row.attempts
  }

  sessionInterruptionCount(challengeId: string): number {
    this.assertOpen()
    const row = this.database
      .prepare(`
        SELECT session_interruptions AS count
        FROM challenge_runtime_state
        WHERE challenge_id = ?
      `)
      .get(challengeId) as { count: number } | undefined
    return row?.count ?? 0
  }

  upsertTldr(input: UpsertTldr): TldrRecord {
    this.assertOpen()
    const updatedAt = input.updatedAt ?? new Date().toISOString()
    this.database
      .prepare(`
        INSERT INTO challenge_tldr (
          challenge_id, content, model, session_path, updated_at, error
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(challenge_id) DO UPDATE SET
          content = excluded.content,
          model = excluded.model,
          session_path = excluded.session_path,
          updated_at = excluded.updated_at,
          error = excluded.error
      `)
      .run(
        input.challengeId,
        input.content ?? "",
        input.model,
        input.sessionPath,
        updatedAt,
        input.error ?? null,
      )
    const row = this.database
      .prepare("SELECT * FROM challenge_tldr WHERE challenge_id = ?")
      .get(input.challengeId) as unknown as TldrRow
    return tldrFromRow(row)
  }

  tldr(challengeId: string): TldrRecord | undefined {
    this.assertOpen()
    const row = this.database
      .prepare("SELECT * FROM challenge_tldr WHERE challenge_id = ?")
      .get(challengeId) as unknown as TldrRow | undefined
    return row ? tldrFromRow(row) : undefined
  }

  persistContestAnnouncement(
    input: PersistContestAnnouncement,
  ): ContestAnnouncementRecord {
    this.assertOpen()
    const seenAt = input.seenAt ?? new Date().toISOString()
    this.database.exec("BEGIN IMMEDIATE")
    try {
      const existing = this.database
        .prepare(
          "SELECT * FROM contest_announcements WHERE announcement_key = ?",
        )
        .get(input.key) as unknown as ContestAnnouncementRow | undefined
      if (existing) {
        if (
          existing.platform_announcement_id !== input.platformAnnouncementId ||
          existing.revision_hash !== input.revisionHash
        ) {
          throw new Error(`Announcement key collision: ${input.key}`)
        }
        this.database
          .prepare(`
            UPDATE contest_announcements SET last_seen_at = ?
            WHERE announcement_key = ?
          `)
          .run(seenAt, input.key)
      } else {
        this.database
          .prepare(`
            INSERT INTO contest_announcements (
              announcement_key, platform_announcement_id, revision_hash,
              title, content, published_at, kind, classification_reason,
              ignored, first_seen_at, last_seen_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `)
          .run(
            input.key,
            input.platformAnnouncementId,
            input.revisionHash,
            input.title,
            input.content,
            input.publishedAt,
            input.kind,
            input.classificationReason ?? null,
            input.ignored ? 1 : 0,
            seenAt,
            seenAt,
          )
      }
      const row = this.database
        .prepare(
          "SELECT * FROM contest_announcements WHERE announcement_key = ?",
        )
        .get(input.key) as unknown as ContestAnnouncementRow
      this.database.exec("COMMIT")
      return contestAnnouncementFromRow(row)
    } catch (error) {
      this.database.exec("ROLLBACK")
      throw error
    }
  }

  linkChallengeAnnouncement(input: {
    challengeId: string
    announcementKey: string
    matchType: string
    matchedValue: string
    createdAt?: string
  }): boolean {
    this.assertOpen()
    const result = this.database
      .prepare(`
        INSERT INTO challenge_announcements (
          challenge_id, announcement_key, match_type, matched_value, created_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(challenge_id, announcement_key) DO NOTHING
      `)
      .run(
        input.challengeId,
        input.announcementKey,
        input.matchType,
        input.matchedValue,
        input.createdAt ?? new Date().toISOString(),
      )
    return Number(result.changes) === 1
  }

  challengeAnnouncements(challengeId: string): ChallengeAnnouncementRecord[] {
    this.assertOpen()
    const rows = this.database
      .prepare(`
        SELECT a.*, ca.challenge_id, ca.match_type, ca.matched_value,
          ca.created_at AS linked_at
        FROM challenge_announcements ca
        JOIN contest_announcements a
          ON a.announcement_key = ca.announcement_key
        WHERE ca.challenge_id = ? AND a.ignored = 0
        ORDER BY a.published_at ASC, a.announcement_key ASC
      `)
      .all(challengeId) as unknown as ChallengeAnnouncementRow[]
    return rows.map((row) => ({
      ...contestAnnouncementFromRow(row),
      challengeId: row.challenge_id,
      matchType: row.match_type,
      matchedValue: row.matched_value,
      linkedAt: row.linked_at,
    }))
  }

  enqueueSchedulerChallenge(
    input: EnqueueSchedulerChallenge,
  ): SchedulerQueueRecord {
    this.assertOpen()
    const lane = input.lane ?? "normal"
    const timestamp = input.enqueuedAt ?? new Date().toISOString()
    this.database.exec("BEGIN IMMEDIATE")
    try {
      const existing = this.database
        .prepare("SELECT * FROM scheduler_queue WHERE challenge_id = ?")
        .get(input.challengeId) as unknown as SchedulerQueueRow | undefined
      if (existing) {
        this.database.exec("COMMIT")
        return schedulerQueueFromRow(existing)
      }
      const next = this.database
        .prepare(`
          SELECT COALESCE(MAX(position), 0) + 1 AS position
          FROM scheduler_queue WHERE lane = ?
        `)
        .get(lane) as { position: number }
      this.database
        .prepare(`
          INSERT INTO scheduler_queue (
            challenge_id, source, lane, position, manual_override,
            enqueued_at, version
          ) VALUES (?, ?, ?, ?, ?, ?, 1)
        `)
        .run(
          input.challengeId,
          input.source,
          lane,
          next.position,
          input.manualOverride ? 1 : 0,
          timestamp,
        )
      const row = this.database
        .prepare("SELECT * FROM scheduler_queue WHERE challenge_id = ?")
        .get(input.challengeId) as unknown as SchedulerQueueRow
      this.database.exec("COMMIT")
      return schedulerQueueFromRow(row)
    } catch (error) {
      this.database.exec("ROLLBACK")
      throw error
    }
  }

  schedulerQueue(): SchedulerQueueRecord[] {
    this.assertOpen()
    const rows = this.database
      .prepare(`
        SELECT * FROM scheduler_queue
        ORDER BY manual_override DESC,
          CASE lane WHEN 'normal' THEN 0 ELSE 1 END,
          position ASC, enqueued_at ASC, challenge_id ASC
      `)
      .all() as unknown as SchedulerQueueRow[]
    return rows.map(schedulerQueueFromRow)
  }

  moveSchedulerChallenge(input: MoveSchedulerChallenge): SchedulerQueueRecord {
    this.assertOpen()
    if (!Number.isInteger(input.position) || input.position < 1) {
      throw new Error("position must be a positive integer")
    }
    this.database.exec("BEGIN IMMEDIATE")
    try {
      const row = this.database
        .prepare("SELECT * FROM scheduler_queue WHERE challenge_id = ?")
        .get(input.challengeId) as unknown as SchedulerQueueRow | undefined
      if (!row) throw new Error(`Challenge is not queued: ${input.challengeId}`)
      if (row.version !== input.expectedVersion) {
        throw new Error(
          `Scheduler queue version conflict: expected ${input.expectedVersion}, actual ${row.version}`,
        )
      }
      const count = this.database
        .prepare("SELECT COUNT(*) AS count FROM scheduler_queue WHERE lane = ?")
        .get(row.lane) as { count: number }
      const position = Math.min(input.position, count.count)
      if (position < row.position) {
        this.database
          .prepare(`
            UPDATE scheduler_queue
            SET position = position + 1, version = version + 1
            WHERE lane = ? AND position >= ? AND position < ?
          `)
          .run(row.lane, position, row.position)
      } else if (position > row.position) {
        this.database
          .prepare(`
            UPDATE scheduler_queue
            SET position = position - 1, version = version + 1
            WHERE lane = ? AND position > ? AND position <= ?
          `)
          .run(row.lane, row.position, position)
      }
      this.database
        .prepare(`
          UPDATE scheduler_queue
          SET position = ?, manual_override = ?, version = version + 1
          WHERE challenge_id = ?
        `)
        .run(
          position,
          input.overrideBlockedLane && row.lane === "blocked" ? 1 : 0,
          input.challengeId,
        )
      const updated = this.database
        .prepare("SELECT * FROM scheduler_queue WHERE challenge_id = ?")
        .get(input.challengeId) as unknown as SchedulerQueueRow
      this.database.exec("COMMIT")
      return schedulerQueueFromRow(updated)
    } catch (error) {
      this.database.exec("ROLLBACK")
      throw error
    }
  }

  removeSchedulerChallenge(challengeId: string): boolean {
    this.assertOpen()
    const row = this.database
      .prepare(
        "SELECT lane, position FROM scheduler_queue WHERE challenge_id = ?",
      )
      .get(challengeId) as
      | { lane: SchedulerQueueLane; position: number }
      | undefined
    if (!row) return false
    this.database.exec("BEGIN IMMEDIATE")
    try {
      this.database
        .prepare("DELETE FROM scheduler_queue WHERE challenge_id = ?")
        .run(challengeId)
      this.database
        .prepare(`
          UPDATE scheduler_queue
          SET position = position - 1, version = version + 1
          WHERE lane = ? AND position > ?
        `)
        .run(row.lane, row.position)
      this.database.exec("COMMIT")
      return true
    } catch (error) {
      this.database.exec("ROLLBACK")
      throw error
    }
  }

  reviveChallenge(challengeId: string): ChallengeRuntimeState {
    this.assertOpen()
    const timestamp = new Date().toISOString()
    this.database.exec("BEGIN IMMEDIATE")
    try {
      const current = this.database
        .prepare("SELECT * FROM challenge_runtime_state WHERE challenge_id = ?")
        .get(challengeId) as unknown as ChallengeRuntimeStateRow | undefined
      if (!current?.blocked) {
        throw new Error(`Challenge is not blocked: ${challengeId}`)
      }
      this.database
        .prepare(`
          UPDATE challenge_runtime_state
          SET revival_count = revival_count + 1,
              lifecycle_generation = lifecycle_generation + 1,
              blocked = 0, blocked_at = NULL, blocked_run_id = NULL,
              updated_at = ?
          WHERE challenge_id = ?
        `)
        .run(timestamp, challengeId)
      const updated = this.database
        .prepare("SELECT * FROM challenge_runtime_state WHERE challenge_id = ?")
        .get(challengeId) as unknown as ChallengeRuntimeStateRow
      this.database.exec("COMMIT")
      return challengeRuntimeStateFromRow(updated)
    } catch (error) {
      this.database.exec("ROLLBACK")
      throw error
    }
  }

  challengeRuntimeState(challengeId: string): ChallengeRuntimeState {
    this.assertOpen()
    const row = this.database
      .prepare(`
        SELECT * FROM challenge_runtime_state
        WHERE challenge_id = ?
      `)
      .get(challengeId) as unknown as ChallengeRuntimeStateRow | undefined
    if (row) return challengeRuntimeStateFromRow(row)
    return {
      challengeId,
      blockScore: 0,
      baseBlockThreshold: DEFAULT_BLOCK_THRESHOLD,
      revivalCount: 0,
      effectiveBlockThreshold: DEFAULT_BLOCK_THRESHOLD,
      blocked: false,
      blockedAt: null,
      blockedRunId: null,
      lifecycleGeneration: 0,
      sessionInterruptions: 0,
      updatedAt: null,
    }
  }

  recordChallengeBlockEvent(
    input: RecordChallengeBlockEvent,
  ): ChallengeBlockEvent {
    this.assertOpen()
    const eventKey = input.eventKey.trim()
    const reason = input.reason.trim()
    if (!eventKey || eventKey.length > 256) {
      throw new Error("eventKey must contain 1 to 256 characters")
    }
    if (!reason || reason.length > 128) {
      throw new Error("reason must contain 1 to 128 characters")
    }
    if (input.delta !== 0 && input.delta !== 1 && input.delta !== 2) {
      throw new Error("delta must be 0, 1, or 2")
    }
    const timestamp = input.createdAt ?? new Date().toISOString()
    this.database.exec("BEGIN IMMEDIATE")
    try {
      this.assertRunBelongsToChallenge(input.runId, input.challengeId)
      const existing = this.database
        .prepare(`
          SELECT * FROM challenge_block_events WHERE event_key = ?
        `)
        .get(eventKey) as unknown as ChallengeBlockEventRow | undefined
      if (existing) {
        if (
          existing.challenge_id !== input.challengeId ||
          existing.run_id !== input.runId
        ) {
          throw new Error(
            `Block event key already belongs to another Run: ${eventKey}`,
          )
        }
        this.database.exec("COMMIT")
        return challengeBlockEventFromRow(existing)
      }

      this.database
        .prepare(`
          INSERT INTO challenge_runtime_state (
            challenge_id, session_interruptions, blocked, block_score,
            base_block_threshold, revival_count, lifecycle_generation, updated_at
          ) VALUES (?, 0, 0, 0, ?, 0, 0, ?)
          ON CONFLICT(challenge_id) DO NOTHING
        `)
        .run(input.challengeId, DEFAULT_BLOCK_THRESHOLD, timestamp)
      const state = this.database
        .prepare(`
          SELECT * FROM challenge_runtime_state WHERE challenge_id = ?
        `)
        .get(input.challengeId) as unknown as ChallengeRuntimeStateRow
      const threshold =
        state.base_block_threshold +
        state.revival_count * BLOCK_THRESHOLD_REVIVAL_INCREMENT
      const scoreBefore = state.block_score
      const scoreAfter = scoreBefore + input.delta
      const blocked = state.blocked === 1 || scoreAfter > threshold
      const blockedAt = blocked
        ? (state.blocked_at ?? timestamp)
        : state.blocked_at
      const blockedRunId = blocked
        ? (state.blocked_run_id ?? input.runId)
        : null

      const result = this.database
        .prepare(`
          INSERT INTO challenge_block_events (
            challenge_id, run_id, event_key, delta, reason,
            score_before, score_after, threshold, compact_performed, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          input.challengeId,
          input.runId,
          eventKey,
          input.delta,
          reason,
          scoreBefore,
          scoreAfter,
          threshold,
          input.compactPerformed === undefined
            ? null
            : input.compactPerformed
              ? 1
              : 0,
          timestamp,
        )
      this.database
        .prepare(`
          UPDATE challenge_runtime_state
          SET block_score = ?, blocked = ?, blocked_at = ?, blocked_run_id = ?,
              updated_at = ?
          WHERE challenge_id = ?
        `)
        .run(
          scoreAfter,
          blocked ? 1 : 0,
          blockedAt,
          blockedRunId,
          timestamp,
          input.challengeId,
        )
      const event = this.database
        .prepare("SELECT * FROM challenge_block_events WHERE id = ?")
        .get(result.lastInsertRowid) as unknown as ChallengeBlockEventRow
      this.database.exec("COMMIT")
      return challengeBlockEventFromRow(event)
    } catch (error) {
      this.database.exec("ROLLBACK")
      throw error
    }
  }

  challengeBlockEvents(challengeId: string): ChallengeBlockEvent[] {
    this.assertOpen()
    const rows = this.database
      .prepare(`
        SELECT * FROM challenge_block_events
        WHERE challenge_id = ?
        ORDER BY id ASC
      `)
      .all(challengeId) as unknown as ChallengeBlockEventRow[]
    return rows.map(challengeBlockEventFromRow)
  }

  isChallengeBlocked(challengeId: string): boolean {
    this.assertOpen()
    const row = this.database
      .prepare(`
        SELECT blocked
        FROM challenge_runtime_state
        WHERE challenge_id = ?
      `)
      .get(challengeId) as { blocked: number } | undefined
    return row?.blocked === 1
  }

  resetSessionInterruptions(challengeId: string): void {
    this.assertOpen()
    const timestamp = new Date().toISOString()
    this.database.exec("BEGIN IMMEDIATE")
    try {
      this.database
        .prepare(`
          INSERT INTO challenge_runtime_state (
            challenge_id, session_interruptions, blocked, block_score,
            blocked_at, blocked_run_id, updated_at
          ) VALUES (?, 0, 0, 0, NULL, NULL, ?)
          ON CONFLICT(challenge_id) DO UPDATE SET
            session_interruptions = 0,
            block_score = 0,
            blocked = 0,
            blocked_at = NULL,
            blocked_run_id = NULL,
            updated_at = excluded.updated_at
        `)
        .run(challengeId, timestamp)
      const latest = this.database
        .prepare(`
          SELECT id FROM runs
          WHERE challenge_id = ?
          ORDER BY attempt DESC
          LIMIT 1
        `)
        .get(challengeId) as { id: string } | undefined
      if (latest) {
        this.insertEvent(
          latest.id,
          "session_interruptions_reset",
          { challengeId },
          timestamp,
        )
      }
      this.database.exec("COMMIT")
    } catch (error) {
      this.database.exec("ROLLBACK")
      throw error
    }
  }

  isSolved(challengeId: string): boolean {
    this.assertOpen()
    const row = this.database
      .prepare(`
      SELECT 1 AS solved
      FROM runs
      WHERE challenge_id = ? AND status = 'solved'
      LIMIT 1
    `)
      .get(challengeId)
    return row !== undefined
  }

  events(runId: string): RunEvent[] {
    this.assertOpen()
    const rows = this.database
      .prepare(`
      SELECT * FROM run_events
      WHERE run_id = ?
      ORDER BY id ASC
    `)
      .all(runId) as unknown as EventRow[]
    return rows.map((row) => ({
      id: row.id,
      runId: row.run_id,
      type: row.type,
      ...(row.data_json ? { data: JSON.parse(row.data_json) as unknown } : {}),
      createdAt: row.created_at,
    }))
  }

  latestEvent(runId: string): RunEvent | undefined {
    this.assertOpen()
    const row = this.database
      .prepare(`
      SELECT * FROM run_events
      WHERE run_id = ?
      ORDER BY id DESC
      LIMIT 1
    `)
      .get(runId) as unknown as EventRow | undefined
    if (!row) return undefined
    return {
      id: row.id,
      runId: row.run_id,
      type: row.type,
      ...(row.data_json ? { data: JSON.parse(row.data_json) as unknown } : {}),
      createdAt: row.created_at,
    }
  }

  appendEvent(runId: string, type: string, data?: unknown): RunEvent {
    this.assertOpen()
    const timestamp = new Date().toISOString()
    this.database.exec("BEGIN IMMEDIATE")
    try {
      const id = this.insertEvent(runId, type, data, timestamp)
      this.database.exec("COMMIT")
      return {
        id,
        runId,
        type,
        ...(data === undefined ? {} : { data }),
        createdAt: timestamp,
      }
    } catch (error) {
      this.database.exec("ROLLBACK")
      throw error
    }
  }

  /** Persist one worker snapshot; lifecycle events remain in run_events for replay. */
  upsertSubagent(record: SubagentRecord): SubagentRecord {
    this.assertOpen()
    this.getRunOrThrow(record.runId)
    this.database
      .prepare(`
        INSERT INTO run_subagents (
          id, run_id, role, display_name, description, status, background,
          prompt, session_path, container_cwd, result, error, active_tool,
          turns, tool_uses, total_tokens, created_at, updated_at, started_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          role = excluded.role,
          display_name = excluded.display_name,
          description = excluded.description,
          status = excluded.status,
          background = excluded.background,
          prompt = excluded.prompt,
          session_path = excluded.session_path,
          container_cwd = excluded.container_cwd,
          result = excluded.result,
          error = excluded.error,
          active_tool = excluded.active_tool,
          turns = excluded.turns,
          tool_uses = excluded.tool_uses,
          total_tokens = excluded.total_tokens,
          updated_at = excluded.updated_at,
          started_at = excluded.started_at,
          completed_at = excluded.completed_at
      `)
      .run(
        record.id,
        record.runId,
        record.role,
        record.displayName,
        record.description,
        record.status,
        record.background ? 1 : 0,
        record.prompt,
        record.sessionPath,
        record.containerCwd,
        record.result ?? null,
        record.error ?? null,
        record.activeTool ?? null,
        record.turns,
        record.toolUses,
        record.totalTokens,
        record.createdAt,
        record.updatedAt,
        record.startedAt ?? null,
        record.completedAt ?? null,
      )
    return { ...record }
  }

  subagents(runId: string): SubagentRecord[] {
    this.assertOpen()
    const rows = this.database
      .prepare(`
        SELECT * FROM run_subagents
        WHERE run_id = ?
        ORDER BY created_at ASC, id ASC
      `)
      .all(runId) as unknown as SubagentRow[]
    return rows.map(subagentFromRow)
  }

  markInterruptedSubagents(
    message = "进程退出时 SubAgent 未进入终态",
  ): SubagentRecord[] {
    this.assertOpen()
    const timestamp = new Date().toISOString()
    this.database
      .prepare(`
        UPDATE run_subagents
        SET status = 'interrupted', error = ?, updated_at = ?, completed_at = ?
        WHERE status IN ('queued', 'running')
      `)
      .run(message, timestamp, timestamp)
    const rows = this.database
      .prepare("SELECT * FROM run_subagents WHERE completed_at = ?")
      .all(timestamp) as unknown as SubagentRow[]
    return rows.map(subagentFromRow)
  }

  recordEvidence(
    challengeId: string,
    runId: string,
    description: string,
  ): EvidenceRecord {
    this.assertOpen()
    const normalized = normalizedDescription(description, "description")
    const timestamp = new Date().toISOString()
    this.database.exec("BEGIN IMMEDIATE")
    try {
      this.assertRunBelongsToChallenge(runId, challengeId)
      this.assertChallengeEntryCapacity(
        "challenge_evidence",
        challengeId,
        BLACKBOARD_MAX_EVIDENCE_PER_CHALLENGE,
      )
      const result = this.database
        .prepare(`
        INSERT INTO challenge_evidence (challenge_id, description, run_id, created_at)
        VALUES (?, ?, ?, ?)
      `)
        .run(challengeId, normalized, runId, timestamp)
      this.database.exec("COMMIT")
      return {
        id: Number(result.lastInsertRowid),
        challengeId,
        description: normalized,
        runId,
        createdAt: timestamp,
      }
    } catch (error) {
      this.database.exec("ROLLBACK")
      throw error
    }
  }

  ensureOrigin(
    challengeId: string,
    runId: string,
    challengeInfo: ChallengeInfoForOrigin,
  ): EvidenceRecord {
    this.assertOpen()
    const attachments =
      challengeInfo.attachments.length > 0
        ? challengeInfo.attachments
            .map((a) => `  - ${a.name} (${a.size} bytes)`)
            .join("\n")
        : "  (none)"
    const description = truncateOrigin(
      [
        `Title: ${challengeInfo.title}`,
        `Category: ${challengeInfo.category}`,
        `Score: ${challengeInfo.score}`,
        `Description: ${challengeInfo.description}`,
        `Attachments:`,
        attachments,
      ].join("\n"),
    )
    const timestamp = new Date().toISOString()
    this.database.exec("BEGIN IMMEDIATE")
    try {
      this.assertRunBelongsToChallenge(runId, challengeId)
      const existing = this.database
        .prepare(`
        SELECT * FROM challenge_evidence WHERE challenge_id = ? ORDER BY id ASC LIMIT 1
      `)
        .get(challengeId) as unknown as EvidenceRow | undefined
      if (existing) {
        this.database.exec("COMMIT")
        return {
          id: existing.id,
          challengeId: existing.challenge_id,
          description: existing.description,
          runId: existing.run_id,
          createdAt: existing.created_at,
        }
      }
      this.assertChallengeEntryCapacity(
        "challenge_evidence",
        challengeId,
        BLACKBOARD_MAX_EVIDENCE_PER_CHALLENGE,
      )
      const result = this.database
        .prepare(`
        INSERT INTO challenge_evidence (challenge_id, description, run_id, created_at)
        VALUES (?, ?, ?, ?)
      `)
        .run(challengeId, description, runId, timestamp)
      this.database.exec("COMMIT")
      return {
        id: Number(result.lastInsertRowid),
        challengeId,
        description,
        runId,
        createdAt: timestamp,
      }
    } catch (error) {
      this.database.exec("ROLLBACK")
      throw error
    }
  }

  recordOpportunity(
    challengeId: string,
    runId: string,
    description: string,
    sourceEvidenceIds: number[],
  ): OpportunityRecord {
    this.assertOpen()
    const normalized = normalizedDescription(description, "description")
    if (sourceEvidenceIds.length === 0) {
      throw new Error("sourceEvidenceIds must not be empty")
    }
    if (sourceEvidenceIds.length > BLACKBOARD_SOURCE_MAX_ITEMS) {
      throw new Error(
        `sourceEvidenceIds must not contain more than ${BLACKBOARD_SOURCE_MAX_ITEMS} items`,
      )
    }
    const deduped = [...new Set(sourceEvidenceIds)]
    const timestamp = new Date().toISOString()
    this.database.exec("BEGIN IMMEDIATE")
    try {
      this.assertRunBelongsToChallenge(runId, challengeId)
      this.assertChallengeEntryCapacity(
        "challenge_opportunities",
        challengeId,
        BLACKBOARD_MAX_OPPORTUNITIES_PER_CHALLENGE,
      )
      // 校验所有 source evidence 属于同一个 challenge，防止跨题知识串联
      const placeholders = deduped.map(() => "?").join(", ")
      const rows = this.database
        .prepare(`
        SELECT id FROM challenge_evidence
        WHERE id IN (${placeholders}) AND challenge_id = ?
      `)
        .all(...deduped, challengeId) as unknown as { id: number }[]
      if (rows.length !== deduped.length) {
        throw new Error(
          "One or more source evidence IDs do not belong to this challenge",
        )
      }

      const result = this.database
        .prepare(`
        INSERT INTO challenge_opportunities (challenge_id, description, status, run_id, created_at)
        VALUES (?, ?, 'open', ?, ?)
      `)
        .run(challengeId, normalized, runId, timestamp)
      const opportunityId = Number(result.lastInsertRowid)
      const insertSource = this.database.prepare(`
        INSERT INTO challenge_opportunity_sources (opportunity_id, evidence_id) VALUES (?, ?)
      `)
      for (const evidenceId of deduped) {
        insertSource.run(opportunityId, evidenceId)
      }
      this.database.exec("COMMIT")
      return {
        id: opportunityId,
        challengeId,
        description: normalized,
        status: "open",
        resolution: null,
        runId,
        sourceEvidenceIds: deduped,
        targetEvidenceId: null,
        createdAt: timestamp,
        concludedAt: null,
      }
    } catch (error) {
      this.database.exec("ROLLBACK")
      throw error
    }
  }

  concludeOpportunity(
    challengeId: string,
    opportunityId: number,
    resultDescription: string,
    runId: string,
    resolution: OpportunityResolution = "confirmed",
  ): { evidence: EvidenceRecord; opportunity: OpportunityRecord } {
    this.assertOpen()
    if (resolution !== "confirmed" && resolution !== "dead_end") {
      throw new Error(`Unsupported opportunity resolution: ${resolution}`)
    }
    const normalized = normalizedDescription(
      resultDescription,
      "resultDescription",
    )
    const timestamp = new Date().toISOString()
    this.database.exec("BEGIN IMMEDIATE")
    try {
      this.assertRunBelongsToChallenge(runId, challengeId)
      const row = this.database
        .prepare(`
        SELECT * FROM challenge_opportunities
        WHERE id = ? AND challenge_id = ?
      `)
        .get(opportunityId, challengeId) as unknown as
        | OpportunityRow
        | undefined
      if (!row)
        throw new Error(
          `Opportunity ${opportunityId} not found for challenge ${challengeId}`,
        )
      if (row.status !== "open")
        throw new Error(`Opportunity ${opportunityId} is already ${row.status}`)
      this.assertChallengeEntryCapacity(
        "challenge_evidence",
        challengeId,
        BLACKBOARD_MAX_EVIDENCE_PER_CHALLENGE,
      )

      const evidenceResult = this.database
        .prepare(`
        INSERT INTO challenge_evidence (challenge_id, description, run_id, created_at)
        VALUES (?, ?, ?, ?)
      `)
        .run(challengeId, normalized, runId, timestamp)
      const evidenceId = Number(evidenceResult.lastInsertRowid)
      const update = this.database
        .prepare(`
        UPDATE challenge_opportunities
        SET status = 'concluded', resolution = ?, target_evidence_id = ?,
            concluded_at = ?
        WHERE id = ? AND challenge_id = ? AND status = 'open'
      `)
        .run(resolution, evidenceId, timestamp, opportunityId, challengeId)
      if (Number(update.changes) !== 1) {
        throw new Error(`Opportunity ${opportunityId} could not be concluded`)
      }
      const evidenceRow = this.database
        .prepare("SELECT * FROM challenge_evidence WHERE id = ?")
        .get(evidenceId) as unknown as EvidenceRow
      const oppRow = this.database
        .prepare("SELECT * FROM challenge_opportunities WHERE id = ?")
        .get(opportunityId) as unknown as OpportunityRow
      const sourceRows = this.database
        .prepare(`
        SELECT evidence_id FROM challenge_opportunity_sources WHERE opportunity_id = ?
      `)
        .all(opportunityId) as unknown as OpportunitySourceRow[]
      const concluded = {
        evidence: {
          id: evidenceRow.id,
          challengeId: evidenceRow.challenge_id,
          description: evidenceRow.description,
          runId: evidenceRow.run_id,
          createdAt: evidenceRow.created_at,
        },
        opportunity: opportunityFromRow(
          oppRow,
          sourceRows.map((s) => s.evidence_id),
        ),
      }
      this.database.exec("COMMIT")
      return concluded
    } catch (error) {
      this.database.exec("ROLLBACK")
      throw error
    }
  }

  getBlackboardSummary(challengeId: string): BlackboardSummary {
    this.assertOpen()
    const evidenceRows = this.database
      .prepare(`
      SELECT * FROM challenge_evidence WHERE challenge_id = ? ORDER BY id ASC
    `)
      .all(challengeId) as unknown as EvidenceRow[]
    const opportunityRows = this.database
      .prepare(`
      SELECT * FROM challenge_opportunities WHERE challenge_id = ? ORDER BY id ASC
    `)
      .all(challengeId) as unknown as OpportunityRow[]
    const allSourceRows = this.database
      .prepare(`
      SELECT os.* FROM challenge_opportunity_sources os
      JOIN challenge_opportunities o ON o.id = os.opportunity_id
      WHERE o.challenge_id = ?
      ORDER BY os.opportunity_id, os.evidence_id
    `)
      .all(challengeId) as unknown as OpportunitySourceRow[]
    const sourcesByOpp = new Map<number, number[]>()
    for (const row of allSourceRows) {
      const list = sourcesByOpp.get(row.opportunity_id)
      if (list) list.push(row.evidence_id)
      else sourcesByOpp.set(row.opportunity_id, [row.evidence_id])
    }
    return {
      evidence: evidenceRows.map(evidenceToSummary),
      opportunities: opportunityRows.map((row) =>
        opportunityFromRow(row, sourcesByOpp.get(row.id) ?? []),
      ),
    }
  }

  getBlackboardStats(): BlackboardStats[] {
    this.assertOpen()
    const rows = this.database
      .prepare(`
      SELECT
        ids.challenge_id,
        COALESCE(e.evidence_count, 0) AS evidence_count,
        COALESCE(o.open_count, 0) AS open_count,
        COALESCE(o.concluded_count, 0) AS concluded_count
      FROM (
        SELECT challenge_id FROM challenge_evidence
        UNION
        SELECT challenge_id FROM challenge_opportunities
      ) ids
      LEFT JOIN (
        SELECT challenge_id, COUNT(*) AS evidence_count
        FROM challenge_evidence
        GROUP BY challenge_id
      ) e ON e.challenge_id = ids.challenge_id
      LEFT JOIN (
        SELECT
          challenge_id,
          SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open_count,
          SUM(CASE WHEN status = 'concluded' THEN 1 ELSE 0 END) AS concluded_count
        FROM challenge_opportunities
        GROUP BY challenge_id
      ) o ON o.challenge_id = ids.challenge_id
      ORDER BY ids.challenge_id ASC
    `)
      .all() as unknown as BlackboardStatsRow[]
    return rows.map((row) => ({
      challengeId: row.challenge_id,
      evidence: row.evidence_count,
      openOpportunities: row.open_count,
      concludedOpportunities: row.concluded_count,
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

  private insertEvent(
    runId: string,
    type: string,
    data: unknown,
    timestamp: string,
  ): number {
    const result = this.database
      .prepare(`
      INSERT INTO run_events (run_id, type, data_json, created_at)
      VALUES (?, ?, ?, ?)
    `)
      .run(
        runId,
        type,
        data === undefined ? null : JSON.stringify(data),
        timestamp,
      )
    return Number(result.lastInsertRowid)
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("RunStore 已关闭")
  }

  private assertRunBelongsToChallenge(
    runId: string,
    challengeId: string,
  ): void {
    const row = this.database
      .prepare(`
      SELECT challenge_id FROM runs WHERE id = ?
    `)
      .get(runId) as { challenge_id: string } | undefined
    if (!row) throw new Error(`RunStore 中不存在 Run: ${runId}`)
    if (row.challenge_id !== challengeId) {
      throw new Error(
        `Run ${runId} does not belong to challenge ${challengeId}`,
      )
    }
  }

  private assertChallengeEntryCapacity(
    table: "challenge_evidence" | "challenge_opportunities",
    challengeId: string,
    maximum: number,
  ): void {
    const row = this.database
      .prepare(`
      SELECT COUNT(*) AS count FROM ${table} WHERE challenge_id = ?
    `)
      .get(challengeId) as { count: number }
    if (row.count >= maximum) {
      throw new Error(
        `${table} has reached the per-challenge limit of ${maximum}`,
      )
    }
  }
}
