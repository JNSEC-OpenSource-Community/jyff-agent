import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"
import type {
  Announcement,
  ChallengeSummary,
  ContestOverview,
  RemoteEnvironment,
} from "@ctf-agent/platform"
import type { SubagentRecord } from "../collaboration/subagent-manager.ts"
import type {
  RemoteEnvironmentLeaseRecord,
  RemoteEnvironmentPriority,
} from "../project/remote-environment-coordinator.ts"

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

export type RunSource = "direct" | "auto" | "manual" | "retry" | "revival" | "test"

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

export interface ModelTokenUsage {
  provider: string
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTokens: number
  cacheHitRate: number | null
  attributed: boolean
}

export interface ProjectTokenUsageSnapshot {
  generatedAt: string
  models: ModelTokenUsage[]
  totals: Omit<ModelTokenUsage, "provider" | "model" | "attributed">
  unattributedTokens: number
}

export interface RecordModelTokenUsage {
  source: "solver" | "subagent" | "tldr" | (string & {})
  sourceId?: string
  provider: string
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens?: number
  createdAt?: string
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

export type ChallengeSchedulingDisposition = "excluded" | "solved"

export interface ChallengeSchedulingOverride {
  challengeId: string
  disposition: ChallengeSchedulingDisposition
  updatedAt: string
}

export interface PlatformViewCache {
  overview?: ContestOverview
  challenges?: ChallengeSummary[]
  announcements?: Announcement[]
  environments?: RemoteEnvironment[]
}

type PlatformViewCacheKey = keyof PlatformViewCache

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
export type SchedulerQueueStage = "idle" | "execution"
export type SchedulerMode = "stopped" | "manual" | "automatic"

export interface SchedulerStateRecord {
  mode: SchedulerMode
  idleVersion: number
  executionVersion: number
  updatedAt: string
}

export interface SchedulerQueueRecord {
  challengeId: string
  source: RunSource
  stage: SchedulerQueueStage
  lane: SchedulerQueueLane
  position: number
  manualOverride: boolean
  enqueuedAt: string
  version: number
}

export interface EnqueueSchedulerChallenge {
  challengeId: string
  source: RunSource
  stage?: SchedulerQueueStage
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
  inputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export interface UpsertTldr {
  challengeId: string
  content?: string
  model: string
  sessionPath: string
  updatedAt?: string
  error?: string | null
  inputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
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

export interface AnnouncementDeliveryRecord {
  challengeId: string
  announcementKey: string
  runId: string
  status: "queued" | "delivered" | "failed"
  attempts: number
  queuedAt: string | null
  observedAt: string | null
  lastError: string | null
}

export interface ChallengeAnnouncementRecord extends ContestAnnouncementRecord {
  challengeId: string
  matchType: string
  matchedValue: string
  matchedKeywords: string[]
  approvalStatus: AnnouncementApprovalStatus
  reviewedAt: string | null
  linkedAt: string
}

export type AnnouncementApprovalStatus = "pending" | "approved" | "rejected"

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

const PREVIOUS_DEFAULT_BLOCK_THRESHOLD = 8
export const DEFAULT_BLOCK_THRESHOLD = 10
export const BLOCK_THRESHOLD_REVIVAL_INCREMENT = 4

export const BLACKBOARD_DESCRIPTION_MAX_LENGTH = 4_000
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
  execution_id: string | null
  result: string | null
  result_kind: SubagentRecord["resultKind"] | null
  error: string | null
  active_tool: string | null
  turns: number
  tool_uses: number
  total_tokens: number
  input_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
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
  input_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
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

interface AnnouncementDeliveryRow {
  challenge_id: string
  announcement_key: string
  run_id: string
  status: "queued" | "delivered" | "failed"
  attempts: number
  queued_at: string | null
  observed_at: string | null
  last_error: string | null
}

interface ChallengeAnnouncementRow extends ContestAnnouncementRow {
  challenge_id: string
  match_type: string
  matched_value: string
  matched_keywords_json: string
  approval_status: AnnouncementApprovalStatus
  reviewed_at: string | null
  linked_at: string
}

interface SchedulerQueueRow {
  challenge_id: string
  source: RunSource
  stage: SchedulerQueueStage
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

interface RemoteEnvironmentLeaseRow {
  run_id: string
  challenge_id: string
  environment_id: string
  priority: RemoteEnvironmentPriority
  acquired_at: string
}

function opportunityFromRow(row: OpportunityRow, sourceEvidenceIds: number[]): OpportunityRecord {
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

function evidenceRecordFromRow(row: EvidenceRow): EvidenceRecord {
  return {
    id: row.id,
    challengeId: row.challenge_id,
    description: row.description,
    runId: row.run_id,
    createdAt: row.created_at,
  }
}

function tldrFromRow(row: TldrRow): TldrRecord {
  return {
    challengeId: row.challenge_id,
    content: row.content,
    model: row.model,
    sessionPath: row.session_path,
    updatedAt: row.updated_at,
    error: row.error,
    inputTokens: row.input_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens,
  }
}

function announcementDeliveryFromRow(row: AnnouncementDeliveryRow): AnnouncementDeliveryRecord {
  return {
    challengeId: row.challenge_id,
    announcementKey: row.announcement_key,
    runId: row.run_id,
    status: row.status,
    attempts: row.attempts,
    queuedAt: row.queued_at,
    observedAt: row.observed_at,
    lastError: row.last_error,
  }
}

function contestAnnouncementFromRow(row: ContestAnnouncementRow): ContestAnnouncementRecord {
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

function challengeAnnouncementFromRow(row: ChallengeAnnouncementRow): ChallengeAnnouncementRecord {
  const parsedKeywords = JSON.parse(row.matched_keywords_json) as unknown
  return {
    ...contestAnnouncementFromRow(row),
    challengeId: row.challenge_id,
    matchType: row.match_type,
    matchedValue: row.matched_value,
    matchedKeywords: Array.isArray(parsedKeywords)
      ? parsedKeywords.filter((keyword): keyword is string => typeof keyword === "string")
      : [],
    approvalStatus: row.approval_status,
    reviewedAt: row.reviewed_at,
    linkedAt: row.linked_at,
  }
}

function schedulerQueueFromRow(row: SchedulerQueueRow): SchedulerQueueRecord {
  return {
    challengeId: row.challenge_id,
    source: row.source,
    stage: row.stage,
    lane: row.lane,
    position: row.position,
    manualOverride: row.manual_override === 1,
    enqueuedAt: row.enqueued_at,
    version: row.version,
  }
}

function challengeRuntimeStateFromRow(row: ChallengeRuntimeStateRow): ChallengeRuntimeState {
  return {
    challengeId: row.challenge_id,
    blockScore: row.block_score,
    baseBlockThreshold: row.base_block_threshold,
    revivalCount: row.revival_count,
    effectiveBlockThreshold:
      row.base_block_threshold + row.revival_count * BLOCK_THRESHOLD_REVIVAL_INCREMENT,
    blocked: row.blocked === 1,
    blockedAt: row.blocked_at,
    blockedRunId: row.blocked_run_id,
    lifecycleGeneration: row.lifecycle_generation,
    sessionInterruptions: row.session_interruptions,
    updatedAt: row.updated_at,
  }
}

function challengeBlockEventFromRow(row: ChallengeBlockEventRow): ChallengeBlockEvent {
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
    compactPerformed: row.compact_performed === null ? null : row.compact_performed === 1,
    createdAt: row.created_at,
  }
}

function normalizedDescription(value: string, field: string): string {
  const normalized = value.trim()
  if (!normalized) throw new Error(`${field} must not be empty`)
  if (normalized.length > BLACKBOARD_DESCRIPTION_MAX_LENGTH) {
    throw new Error(`${field} must not exceed ${BLACKBOARD_DESCRIPTION_MAX_LENGTH} characters`)
  }
  return normalized
}

function normalizedSourceEvidenceIds(sourceEvidenceIds: number[]): number[] {
  if (sourceEvidenceIds.length === 0) {
    throw new Error("sourceEvidenceIds must not be empty")
  }
  if (sourceEvidenceIds.length > BLACKBOARD_SOURCE_MAX_ITEMS) {
    throw new Error(
      `sourceEvidenceIds must not contain more than ${BLACKBOARD_SOURCE_MAX_ITEMS} items`,
    )
  }
  return [...new Set(sourceEvidenceIds)]
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
    ...(row.execution_id === null ? {} : { executionId: row.execution_id }),
    ...(row.result === null ? {} : { result: row.result }),
    ...(row.result_kind
      ? { resultKind: row.result_kind }
      : row.result !== null && !row.execution_id
        ? { resultKind: "legacy" as const }
        : {}),
    ...(row.error === null ? {} : { error: row.error }),
    ...(row.active_tool === null ? {} : { activeTool: row.active_tool }),
    turns: row.turns,
    toolUses: row.tool_uses,
    totalTokens: row.total_tokens,
    inputTokens: row.input_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.started_at === null ? {} : { startedAt: row.started_at }),
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
  }
}

function modelTokenUsageFromValues(row: {
  provider: string
  model: string
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
}): ModelTokenUsage {
  const inputTokens = normalizedTokenCount(row.input_tokens)
  const outputTokens = normalizedTokenCount(row.output_tokens)
  const cacheReadTokens = normalizedTokenCount(row.cache_read_tokens)
  const cacheWriteTokens = normalizedTokenCount(row.cache_write_tokens)
  const eligibleInputTokens = inputTokens + cacheReadTokens
  return {
    provider: row.provider,
    model: row.model,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
    cacheHitRate: eligibleInputTokens > 0 ? cacheReadTokens / eligibleInputTokens : null,
    attributed: row.provider !== "legacy",
  }
}

function modelTokenUsageFromEvent(event: EventRow): RecordModelTokenUsage | undefined {
  if (!event.data_json) return undefined
  let data: unknown
  try {
    data = JSON.parse(event.data_json) as unknown
  } catch {
    return undefined
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined
  const usage = data as Record<string, unknown>
  const provider = typeof usage.provider === "string" ? usage.provider : "legacy"
  const model = typeof usage.model === "string" ? usage.model : "历史 Solver（模型未知）"
  const inputTokens = normalizedTokenCount(usage.input)
  const outputTokens = normalizedTokenCount(usage.output)
  const cacheReadTokens = normalizedTokenCount(usage.cacheRead)
  const cacheWriteTokens = normalizedTokenCount(usage.cacheWrite)
  if (inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens === 0) return undefined
  return {
    source: typeof usage.source === "string" ? usage.source : "legacy-solver",
    sourceId: String(event.id),
    provider,
    model,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    createdAt: event.created_at,
  }
}

function legacyModelIdentity(value: string): { provider: string; model: string } {
  const separator = value.indexOf("/")
  if (separator > 0 && separator < value.length - 1) {
    return { provider: value.slice(0, separator), model: value.slice(separator + 1) }
  }
  return { provider: "legacy", model: value || "历史 TLDR（模型未知）" }
}

function normalizedTokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

function normalizedUsageIdentity(value: string, field: string): string {
  const normalized = value.trim()
  if (!normalized) throw new Error(`${field} must not be empty`)
  if (normalized.length > 256) throw new Error(`${field} must not exceed 256 characters`)
  return normalized
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
    const hadModelTokenUsage =
      database
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'model_token_usage'")
        .get() !== undefined
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

      CREATE TABLE IF NOT EXISTS model_token_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        source_id TEXT,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
        output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
        cache_read_tokens INTEGER NOT NULL CHECK (cache_read_tokens >= 0),
        cache_write_tokens INTEGER NOT NULL CHECK (cache_write_tokens >= 0),
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS model_token_usage_model
        ON model_token_usage(provider, model, id);

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
        execution_id TEXT,
        result TEXT,
        result_kind TEXT,
        error TEXT,
        active_tool TEXT,
        turns INTEGER NOT NULL DEFAULT 0,
        tool_uses INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
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
        base_block_threshold INTEGER NOT NULL DEFAULT ${DEFAULT_BLOCK_THRESHOLD}
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
        stage TEXT NOT NULL DEFAULT 'execution'
          CHECK (stage IN ('idle', 'execution')),
        lane TEXT NOT NULL CHECK (lane IN ('normal', 'blocked')),
        position INTEGER NOT NULL CHECK (position >= 1),
        manual_override INTEGER NOT NULL DEFAULT 0
          CHECK (manual_override IN (0, 1)),
        enqueued_at TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS scheduler_queue_order
        ON scheduler_queue(manual_override DESC, lane, position, enqueued_at);

      CREATE TABLE IF NOT EXISTS scheduler_control (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        mode TEXT NOT NULL DEFAULT 'stopped'
          CHECK (mode IN ('stopped', 'manual', 'automatic')),
        idle_version INTEGER NOT NULL DEFAULT 1 CHECK (idle_version >= 1),
        execution_version INTEGER NOT NULL DEFAULT 1 CHECK (execution_version >= 1),
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS challenge_scheduling_overrides (
        challenge_id TEXT PRIMARY KEY,
        disposition TEXT NOT NULL CHECK (disposition IN ('excluded', 'solved')),
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS platform_view_cache (
        cache_key TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS remote_environment_leases (
        run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
        challenge_id TEXT NOT NULL,
        environment_id TEXT NOT NULL,
        priority TEXT NOT NULL CHECK (priority IN ('required', 'verification')),
        acquired_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS remote_environment_leases_challenge
        ON remote_environment_leases(challenge_id);

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
        error TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0
      ) STRICT;

      CREATE TABLE IF NOT EXISTS challenge_announcements (
        challenge_id TEXT NOT NULL,
        announcement_key TEXT NOT NULL
          REFERENCES contest_announcements(announcement_key) ON DELETE CASCADE,
        match_type TEXT NOT NULL,
        matched_value TEXT NOT NULL,
        matched_keywords_json TEXT NOT NULL DEFAULT '[]',
        approval_status TEXT NOT NULL DEFAULT 'pending'
          CHECK (approval_status IN ('pending', 'approved', 'rejected')),
        reviewed_at TEXT,
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
    const schedulerQueueColumns = new Set(
      (
        database.prepare("PRAGMA table_info(scheduler_queue)").all() as unknown as Array<{
          name: string
        }>
      ).map((column) => column.name),
    )
    if (!schedulerQueueColumns.has("stage")) {
      database.exec(
        "ALTER TABLE scheduler_queue ADD COLUMN stage TEXT NOT NULL DEFAULT 'execution' CHECK (stage IN ('idle', 'execution'))",
      )
    }
    database.exec(`
      DROP INDEX IF EXISTS scheduler_queue_order;
      CREATE INDEX scheduler_queue_order
        ON scheduler_queue(stage, manual_override DESC, lane, position, enqueued_at);
    `)
    database
      .prepare(`
        INSERT OR IGNORE INTO scheduler_control (
          singleton, mode, idle_version, execution_version, updated_at
        ) VALUES (1, 'stopped', 1, 1, ?)
      `)
      .run(new Date().toISOString())

    const runColumns = database.prepare("PRAGMA table_info(runs)").all() as unknown as Array<{
      name: string
    }>
    if (!runColumns.some((column) => column.name === "source")) {
      database.exec("ALTER TABLE runs ADD COLUMN source TEXT NOT NULL DEFAULT 'direct'")
    }

    const subagentColumns = new Set(
      (
        database.prepare("PRAGMA table_info(run_subagents)").all() as unknown as Array<{
          name: string
        }>
      ).map((column) => column.name),
    )
    const subagentUsageMigrations = [
      ["execution_id", "ALTER TABLE run_subagents ADD COLUMN execution_id TEXT"],
      ["result_kind", "ALTER TABLE run_subagents ADD COLUMN result_kind TEXT"],
      [
        "input_tokens",
        "ALTER TABLE run_subagents ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0)",
      ],
      [
        "cache_read_tokens",
        "ALTER TABLE run_subagents ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0 CHECK (cache_read_tokens >= 0)",
      ],
      [
        "cache_write_tokens",
        "ALTER TABLE run_subagents ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0 CHECK (cache_write_tokens >= 0)",
      ],
    ] as const
    for (const [name, sql] of subagentUsageMigrations) {
      if (!subagentColumns.has(name)) database.exec(sql)
    }

    const tldrColumns = new Set(
      (
        database.prepare("PRAGMA table_info(challenge_tldr)").all() as unknown as Array<{
          name: string
        }>
      ).map((column) => column.name),
    )
    const tldrUsageMigrations = [
      [
        "input_tokens",
        "ALTER TABLE challenge_tldr ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0)",
      ],
      [
        "cache_read_tokens",
        "ALTER TABLE challenge_tldr ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0 CHECK (cache_read_tokens >= 0)",
      ],
      [
        "cache_write_tokens",
        "ALTER TABLE challenge_tldr ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0 CHECK (cache_write_tokens >= 0)",
      ],
    ] as const
    for (const [name, sql] of tldrUsageMigrations) {
      if (!tldrColumns.has(name)) database.exec(sql)
    }

    const challengeAnnouncementColumns = new Set(
      (
        database.prepare("PRAGMA table_info(challenge_announcements)").all() as unknown as Array<{
          name: string
        }>
      ).map((column) => column.name),
    )
    const announcementApprovalMigrations = [
      [
        "matched_keywords_json",
        "ALTER TABLE challenge_announcements ADD COLUMN matched_keywords_json TEXT NOT NULL DEFAULT '[]'",
      ],
      [
        "approval_status",
        "ALTER TABLE challenge_announcements ADD COLUMN approval_status TEXT NOT NULL DEFAULT 'pending'",
      ],
      ["reviewed_at", "ALTER TABLE challenge_announcements ADD COLUMN reviewed_at TEXT"],
    ] as const
    for (const [name, sql] of announcementApprovalMigrations) {
      if (!challengeAnnouncementColumns.has(name)) database.exec(sql)
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
    const hadBlockScore = runtimeColumns.some((column) => column.name === "block_score")
    const hadBaseBlockThreshold = runtimeColumns.some(
      (column) => column.name === "base_block_threshold",
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
      ["blocked_at", "ALTER TABLE challenge_runtime_state ADD COLUMN blocked_at TEXT"],
      ["blocked_run_id", "ALTER TABLE challenge_runtime_state ADD COLUMN blocked_run_id TEXT"],
      [
        "lifecycle_generation",
        "ALTER TABLE challenge_runtime_state ADD COLUMN lifecycle_generation INTEGER NOT NULL DEFAULT 0 CHECK (lifecycle_generation >= 0)",
      ],
    ] as const
    const existingRuntimeColumns = new Set(runtimeColumns.map((column) => column.name))
    database.exec("BEGIN IMMEDIATE")
    try {
      for (const [name, sql] of runtimeMigrations) {
        if (!existingRuntimeColumns.has(name)) database.exec(sql)
      }

      // 已阻塞任务保留作出判定时的旧阈值，避免升级数据库后隐式复活；
      // 尚未阻塞的旧任务则采用提高后的默认阈值。
      if (!hadBaseBlockThreshold) {
        database.exec(`
          UPDATE challenge_runtime_state
          SET base_block_threshold = ${PREVIOUS_DEFAULT_BLOCK_THRESHOLD}
          WHERE blocked = 1
        `)
      }
      database.exec(`
        UPDATE challenge_runtime_state
        SET base_block_threshold = ${DEFAULT_BLOCK_THRESHOLD}
        WHERE blocked = 0
          AND base_block_threshold = ${PREVIOUS_DEFAULT_BLOCK_THRESHOLD}
      `)
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
        interruptDuplicate.run(message, migrationTimestamp, migrationTimestamp, row.id)
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
    const store = new RunStore(path, database)
    try {
      if (!hadModelTokenUsage) store.backfillModelTokenUsage()
    } catch (error) {
      if (!hadModelTokenUsage) database.exec("DROP TABLE IF EXISTS model_token_usage")
      store.close()
      throw error
    }
    return store
  }

  cachePlatformView<K extends PlatformViewCacheKey>(
    key: K,
    value: NonNullable<PlatformViewCache[K]>,
  ): void {
    this.assertOpen()
    this.database
      .prepare(`
        INSERT INTO platform_view_cache (cache_key, payload_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(cache_key) DO UPDATE SET
          payload_json = excluded.payload_json,
          updated_at = excluded.updated_at
      `)
      .run(key, JSON.stringify(value), new Date().toISOString())
  }

  platformViewCache(): PlatformViewCache {
    this.assertOpen()
    const rows = this.database
      .prepare("SELECT cache_key, payload_json FROM platform_view_cache")
      .all() as unknown as Array<{
      cache_key: PlatformViewCacheKey
      payload_json: string
    }>
    const cache: PlatformViewCache = {}
    for (const row of rows) {
      if (!["overview", "challenges", "announcements", "environments"].includes(row.cache_key)) {
        continue
      }
      try {
        Object.assign(cache, { [row.cache_key]: JSON.parse(row.payload_json) })
      } catch {
        // 损坏的缓存不能阻止本地 Run/session 进入只读模式。
      }
    }
    return cache
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
    const row = this.database.prepare("SELECT * FROM runs WHERE id = ?").get(id) as
      | RunRow
      | undefined
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
      patch.closeReason === undefined ? (current.closeReason ?? null) : patch.closeReason
    const error = patch.error === undefined ? (current.error ?? null) : patch.error
    const cleanupError =
      patch.cleanupError === undefined ? (current.cleanupError ?? null) : patch.cleanupError
    const startedAt = patch.startedAt === undefined ? (current.startedAt ?? null) : patch.startedAt
    const finishedAt =
      patch.finishedAt === undefined ? (current.finishedAt ?? null) : patch.finishedAt
    const status = patch.status ?? current.status

    const hasBlockLedger = this.database
      .prepare("SELECT 1 FROM challenge_block_events WHERE run_id = ? LIMIT 1")
      .get(id)
    const recordsSessionInterruption =
      !hasBlockLedger &&
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
        .run(status, closeReason, error, cleanupError, timestamp, startedAt, finishedAt, id)
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
            AND (
              run_events.type = 'run_creation_failed'
              OR (
                run_events.type = 'run_transient_failure'
                AND COALESCE(
                  json_extract(run_events.data_json, '$.sameAttempt'),
                  0
                ) = 0
              )
            )
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
    const existing = this.tldr(input.challengeId)
    this.database
      .prepare(`
        INSERT INTO challenge_tldr (
          challenge_id, content, model, session_path, updated_at, error,
          input_tokens, cache_read_tokens, cache_write_tokens
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(challenge_id) DO UPDATE SET
          content = excluded.content,
          model = excluded.model,
          session_path = excluded.session_path,
          updated_at = excluded.updated_at,
          error = excluded.error,
          input_tokens = excluded.input_tokens,
          cache_read_tokens = excluded.cache_read_tokens,
          cache_write_tokens = excluded.cache_write_tokens
      `)
      .run(
        input.challengeId,
        input.content ?? existing?.content ?? "",
        input.model,
        input.sessionPath,
        updatedAt,
        input.error ?? null,
        input.inputTokens ?? existing?.inputTokens ?? 0,
        input.cacheReadTokens ?? existing?.cacheReadTokens ?? 0,
        input.cacheWriteTokens ?? existing?.cacheWriteTokens ?? 0,
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

  enqueueAnnouncementDelivery(input: {
    challengeId: string
    announcementKey: string
    runId: string
    queuedAt?: string
  }): boolean {
    this.assertOpen()
    this.assertRunBelongsToChallenge(input.runId, input.challengeId)
    const result = this.database
      .prepare(`
        INSERT INTO announcement_deliveries (
          challenge_id, announcement_key, run_id, status, attempts, queued_at
        ) VALUES (?, ?, ?, 'queued', 0, ?)
        ON CONFLICT(challenge_id, announcement_key, run_id) DO UPDATE SET
          status = 'queued', queued_at = excluded.queued_at,
          last_error = NULL
        WHERE announcement_deliveries.status = 'failed'
      `)
      .run(
        input.challengeId,
        input.announcementKey,
        input.runId,
        input.queuedAt ?? new Date().toISOString(),
      )
    return Number(result.changes) === 1
  }

  observeAnnouncementDelivery(input: {
    challengeId: string
    announcementKey: string
    runId: string
    status: "delivered" | "failed"
    error?: string | null
    observedAt?: string
  }): AnnouncementDeliveryRecord {
    this.assertOpen()
    const observedAt = input.observedAt ?? new Date().toISOString()
    this.database
      .prepare(`
        UPDATE announcement_deliveries
        SET status = ?, attempts = attempts + 1, observed_at = ?, last_error = ?
        WHERE challenge_id = ? AND announcement_key = ? AND run_id = ?
      `)
      .run(
        input.status,
        observedAt,
        input.error ?? null,
        input.challengeId,
        input.announcementKey,
        input.runId,
      )
    const row = this.database
      .prepare(`
        SELECT * FROM announcement_deliveries
        WHERE challenge_id = ? AND announcement_key = ? AND run_id = ?
      `)
      .get(
        input.challengeId,
        input.announcementKey,
        input.runId,
      ) as unknown as AnnouncementDeliveryRow
    return announcementDeliveryFromRow(row)
  }

  announcementDeliveries(challengeId: string): AnnouncementDeliveryRecord[] {
    this.assertOpen()
    const rows = this.database
      .prepare(`
        SELECT * FROM announcement_deliveries
        WHERE challenge_id = ?
        ORDER BY queued_at ASC, announcement_key ASC, run_id ASC
      `)
      .all(challengeId) as unknown as AnnouncementDeliveryRow[]
    return rows.map(announcementDeliveryFromRow)
  }

  persistContestAnnouncement(input: PersistContestAnnouncement): ContestAnnouncementRecord {
    this.assertOpen()
    const seenAt = input.seenAt ?? new Date().toISOString()
    this.database.exec("BEGIN IMMEDIATE")
    try {
      const existing = this.database
        .prepare("SELECT * FROM contest_announcements WHERE announcement_key = ?")
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
        .prepare("SELECT * FROM contest_announcements WHERE announcement_key = ?")
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
    matchedKeywords?: readonly string[]
    createdAt?: string
  }): boolean {
    this.assertOpen()
    const result = this.database
      .prepare(`
        INSERT INTO challenge_announcements (
          challenge_id, announcement_key, match_type, matched_value,
          matched_keywords_json, approval_status, created_at
        ) VALUES (?, ?, ?, ?, ?, 'pending', ?)
        ON CONFLICT(challenge_id, announcement_key) DO NOTHING
      `)
      .run(
        input.challengeId,
        input.announcementKey,
        input.matchType,
        input.matchedValue,
        JSON.stringify([...new Set(input.matchedKeywords ?? [])]),
        input.createdAt ?? new Date().toISOString(),
      )
    return Number(result.changes) === 1
  }

  challengeAnnouncements(challengeId: string): ChallengeAnnouncementRecord[] {
    this.assertOpen()
    const rows = this.database
      .prepare(`
        SELECT a.*, ca.challenge_id, ca.match_type, ca.matched_value,
          ca.matched_keywords_json, ca.approval_status, ca.reviewed_at,
          ca.created_at AS linked_at
        FROM challenge_announcements ca
        JOIN contest_announcements a
          ON a.announcement_key = ca.announcement_key
        WHERE ca.challenge_id = ? AND a.ignored = 0
          AND ca.approval_status = 'approved'
        ORDER BY a.published_at ASC, a.announcement_key ASC
      `)
      .all(challengeId) as unknown as ChallengeAnnouncementRow[]
    return rows.map(challengeAnnouncementFromRow)
  }

  announcementCandidates(): ChallengeAnnouncementRecord[] {
    this.assertOpen()
    const rows = this.database
      .prepare(`
        SELECT a.*, ca.challenge_id, ca.match_type, ca.matched_value,
          ca.matched_keywords_json, ca.approval_status, ca.reviewed_at,
          ca.created_at AS linked_at
        FROM challenge_announcements ca
        JOIN contest_announcements a
          ON a.announcement_key = ca.announcement_key
        WHERE a.ignored = 0
        ORDER BY
          CASE ca.approval_status WHEN 'pending' THEN 0 ELSE 1 END,
          a.published_at DESC, a.announcement_key ASC
      `)
      .all() as unknown as ChallengeAnnouncementRow[]
    return rows.map(challengeAnnouncementFromRow)
  }

  reviewChallengeAnnouncement(input: {
    challengeId: string
    announcementKey: string
    status: Exclude<AnnouncementApprovalStatus, "pending">
    reviewedAt?: string
  }): ChallengeAnnouncementRecord {
    this.assertOpen()
    const result = this.database
      .prepare(`
        UPDATE challenge_announcements
        SET approval_status = ?, reviewed_at = ?
        WHERE challenge_id = ? AND announcement_key = ?
      `)
      .run(
        input.status,
        input.reviewedAt ?? new Date().toISOString(),
        input.challengeId,
        input.announcementKey,
      )
    if (Number(result.changes) !== 1) {
      throw new Error(
        `Announcement candidate not found: ${input.challengeId}/${input.announcementKey}`,
      )
    }
    const row = this.database
      .prepare(`
        SELECT a.*, ca.challenge_id, ca.match_type, ca.matched_value,
          ca.matched_keywords_json, ca.approval_status, ca.reviewed_at,
          ca.created_at AS linked_at
        FROM challenge_announcements ca
        JOIN contest_announcements a
          ON a.announcement_key = ca.announcement_key
        WHERE ca.challenge_id = ? AND ca.announcement_key = ?
      `)
      .get(input.challengeId, input.announcementKey) as unknown as ChallengeAnnouncementRow
    return challengeAnnouncementFromRow(row)
  }

  schedulerState(): SchedulerStateRecord {
    this.assertOpen()
    const row = this.database
      .prepare(`
        SELECT mode, idle_version, execution_version, updated_at
        FROM scheduler_control WHERE singleton = 1
      `)
      .get() as {
      mode: SchedulerMode
      idle_version: number
      execution_version: number
      updated_at: string
    }
    return {
      mode: row.mode,
      idleVersion: row.idle_version,
      executionVersion: row.execution_version,
      updatedAt: row.updated_at,
    }
  }

  setSchedulerMode(mode: SchedulerMode): SchedulerStateRecord {
    this.assertOpen()
    const updatedAt = new Date().toISOString()
    this.database
      .prepare("UPDATE scheduler_control SET mode = ?, updated_at = ? WHERE singleton = 1")
      .run(mode, updatedAt)
    return this.schedulerState()
  }

  /** 原子开启调度并将空闲队列按各 lane 原顺序追加到执行队列。 */
  startScheduler(mode: Exclude<SchedulerMode, "stopped">): SchedulerStateRecord {
    this.assertOpen()
    const updatedAt = new Date().toISOString()
    this.database.exec("BEGIN IMMEDIATE")
    try {
      let promoted = 0
      for (const lane of ["normal", "blocked"] as const) {
        const tail = this.database
          .prepare(`
            SELECT COALESCE(MAX(position), 0) AS position
            FROM scheduler_queue WHERE stage = 'execution' AND lane = ?
          `)
          .get(lane) as { position: number }
        const result = this.database
          .prepare(`
            UPDATE scheduler_queue
            SET stage = 'execution', position = position + ?, version = version + 1
            WHERE stage = 'idle' AND lane = ?
          `)
          .run(tail.position, lane)
        promoted += Number(result.changes)
      }
      this.database
        .prepare(`
          UPDATE scheduler_control
          SET mode = ?,
              idle_version = idle_version + ?,
              execution_version = execution_version + ?,
              updated_at = ?
          WHERE singleton = 1
        `)
        .run(mode, promoted > 0 ? 1 : 0, promoted > 0 ? 1 : 0, updatedAt)
      this.database.exec("COMMIT")
      return this.schedulerState()
    } catch (error) {
      this.database.exec("ROLLBACK")
      throw error
    }
  }

  enqueueSchedulerChallenge(input: EnqueueSchedulerChallenge): SchedulerQueueRecord {
    const [record] = this.enqueueSchedulerChallenges([input])
    if (!record) throw new Error("Scheduler queue insert returned no record")
    return record
  }

  enqueueSchedulerChallenges(inputs: readonly EnqueueSchedulerChallenge[]): SchedulerQueueRecord[] {
    this.assertOpen()
    if (inputs.length === 0) return []
    const records: SchedulerQueueRecord[] = []
    const changed = new Set<SchedulerQueueStage>()
    this.database.exec("BEGIN IMMEDIATE")
    try {
      for (const input of inputs) {
        const existing = this.database
          .prepare("SELECT * FROM scheduler_queue WHERE challenge_id = ?")
          .get(input.challengeId) as unknown as SchedulerQueueRow | undefined
        if (existing) {
          records.push(schedulerQueueFromRow(existing))
          continue
        }
        const stage = input.stage ?? "execution"
        const lane = input.lane ?? "normal"
        const next = this.database
          .prepare(`
            SELECT COALESCE(MAX(position), 0) + 1 AS position
            FROM scheduler_queue WHERE stage = ? AND lane = ?
          `)
          .get(stage, lane) as { position: number }
        this.database
          .prepare(`
            INSERT INTO scheduler_queue (
              challenge_id, source, stage, lane, position, manual_override,
              enqueued_at, version
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 1)
          `)
          .run(
            input.challengeId,
            input.source,
            stage,
            lane,
            next.position,
            input.manualOverride ? 1 : 0,
            input.enqueuedAt ?? new Date().toISOString(),
          )
        const row = this.database
          .prepare("SELECT * FROM scheduler_queue WHERE challenge_id = ?")
          .get(input.challengeId) as unknown as SchedulerQueueRow
        records.push(schedulerQueueFromRow(row))
        changed.add(stage)
      }
      if (changed.size > 0) {
        this.database
          .prepare(`
            UPDATE scheduler_control
            SET idle_version = idle_version + ?,
                execution_version = execution_version + ?,
                updated_at = ?
            WHERE singleton = 1
          `)
          .run(
            changed.has("idle") ? 1 : 0,
            changed.has("execution") ? 1 : 0,
            new Date().toISOString(),
          )
      }
      this.database.exec("COMMIT")
      return records
    } catch (error) {
      this.database.exec("ROLLBACK")
      throw error
    }
  }

  schedulerQueue(stage?: SchedulerQueueStage): SchedulerQueueRecord[] {
    this.assertOpen()
    const rows = (stage
      ? this.database
          .prepare(`
            SELECT * FROM scheduler_queue WHERE stage = ?
            ORDER BY manual_override DESC,
              CASE lane WHEN 'normal' THEN 0 ELSE 1 END,
              position ASC, enqueued_at ASC, challenge_id ASC
          `)
          .all(stage)
      : this.database
          .prepare(`
            SELECT * FROM scheduler_queue
            ORDER BY CASE stage WHEN 'idle' THEN 0 ELSE 1 END,
              manual_override DESC,
              CASE lane WHEN 'normal' THEN 0 ELSE 1 END,
              position ASC, enqueued_at ASC, challenge_id ASC
          `)
          .all()) as unknown as SchedulerQueueRow[]
    return rows.map(schedulerQueueFromRow)
  }

  reorderSchedulerStage(
    stage: SchedulerQueueStage,
    challengeIds: readonly string[],
    expectedVersion: number,
  ): SchedulerQueueRecord[] {
    this.assertOpen()
    if (new Set(challengeIds).size !== challengeIds.length) {
      throw new Error("Scheduler queue order contains duplicate challenge ids")
    }
    this.database.exec("BEGIN IMMEDIATE")
    try {
      const state = this.schedulerState()
      const actualVersion = stage === "idle" ? state.idleVersion : state.executionVersion
      if (actualVersion !== expectedVersion) {
        throw new Error(
          `Scheduler queue version conflict: expected ${expectedVersion}, actual ${actualVersion}`,
        )
      }
      const rows = this.database
        .prepare("SELECT challenge_id, lane FROM scheduler_queue WHERE stage = ?")
        .all(stage) as unknown as Array<{ challenge_id: string; lane: SchedulerQueueLane }>
      if (
        rows.length !== challengeIds.length ||
        rows.some((row) => !challengeIds.includes(row.challenge_id))
      ) {
        throw new Error("Scheduler queue version conflict: queue membership changed")
      }
      if (rows.some((row) => row.lane !== "normal")) {
        throw new Error("Blocked scheduler lane cannot be batch reordered")
      }
      const move = this.database.prepare(`
        UPDATE scheduler_queue
        SET position = ?, version = version + 1
        WHERE challenge_id = ? AND stage = ?
      `)
      challengeIds.forEach((challengeId, index) => move.run(index + 1, challengeId, stage))
      this.database
        .prepare(`
          UPDATE scheduler_control
          SET idle_version = idle_version + ?,
              execution_version = execution_version + ?,
              updated_at = ?
          WHERE singleton = 1
        `)
        .run(stage === "idle" ? 1 : 0, stage === "execution" ? 1 : 0, new Date().toISOString())
      this.database.exec("COMMIT")
      return this.schedulerQueue(stage)
    } catch (error) {
      this.database.exec("ROLLBACK")
      throw error
    }
  }

  challengeSchedulingDisposition(challengeId: string): ChallengeSchedulingDisposition | null {
    this.assertOpen()
    const row = this.database
      .prepare(`
        SELECT disposition FROM challenge_scheduling_overrides
        WHERE challenge_id = ?
      `)
      .get(challengeId) as { disposition: ChallengeSchedulingDisposition } | undefined
    return row?.disposition ?? null
  }

  challengeSchedulingOverrides(): ChallengeSchedulingOverride[] {
    this.assertOpen()
    return this.database
      .prepare(`
        SELECT challenge_id, disposition, updated_at
        FROM challenge_scheduling_overrides
        ORDER BY updated_at DESC, challenge_id ASC
      `)
      .all()
      .map((row) => {
        const value = row as {
          challenge_id: string
          disposition: ChallengeSchedulingDisposition
          updated_at: string
        }
        return {
          challengeId: value.challenge_id,
          disposition: value.disposition,
          updatedAt: value.updated_at,
        }
      })
  }

  setChallengeSchedulingDisposition(
    challengeId: string,
    disposition: ChallengeSchedulingDisposition | null,
  ): ChallengeSchedulingOverride | null {
    this.assertOpen()
    if (!challengeId.trim() || challengeId.length > 512)
      throw new Error("challengeId must contain 1 to 512 characters")
    if (disposition === null) {
      this.database
        .prepare("DELETE FROM challenge_scheduling_overrides WHERE challenge_id = ?")
        .run(challengeId)
      return null
    }
    if (disposition !== "excluded" && disposition !== "solved")
      throw new Error("Unsupported challenge scheduling disposition")
    const updatedAt = new Date().toISOString()
    this.database
      .prepare(`
        INSERT INTO challenge_scheduling_overrides (
          challenge_id, disposition, updated_at
        ) VALUES (?, ?, ?)
        ON CONFLICT(challenge_id) DO UPDATE SET
          disposition = excluded.disposition,
          updated_at = excluded.updated_at
      `)
      .run(challengeId, disposition, updatedAt)
    return { challengeId, disposition, updatedAt }
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
        .prepare("SELECT COUNT(*) AS count FROM scheduler_queue WHERE stage = ? AND lane = ?")
        .get(row.stage, row.lane) as { count: number }
      const position = Math.min(input.position, count.count)
      if (position < row.position) {
        this.database
          .prepare(`
            UPDATE scheduler_queue
            SET position = position + 1, version = version + 1
            WHERE stage = ? AND lane = ? AND position >= ? AND position < ?
          `)
          .run(row.stage, row.lane, position, row.position)
      } else if (position > row.position) {
        this.database
          .prepare(`
            UPDATE scheduler_queue
            SET position = position - 1, version = version + 1
            WHERE stage = ? AND lane = ? AND position > ? AND position <= ?
          `)
          .run(row.stage, row.lane, row.position, position)
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
      this.database
        .prepare(`
          UPDATE scheduler_control
          SET idle_version = idle_version + ?,
              execution_version = execution_version + ?,
              updated_at = ?
          WHERE singleton = 1
        `)
        .run(
          row.stage === "idle" ? 1 : 0,
          row.stage === "execution" ? 1 : 0,
          new Date().toISOString(),
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
    return this.removeSchedulerChallenges([challengeId]) > 0
  }

  removeSchedulerChallenges(challengeIds: readonly string[], stage?: SchedulerQueueStage): number {
    this.assertOpen()
    if (challengeIds.length === 0) return 0
    const changed = new Set<SchedulerQueueStage>()
    let removed = 0
    this.database.exec("BEGIN IMMEDIATE")
    try {
      for (const challengeId of new Set(challengeIds)) {
        const row = this.database
          .prepare("SELECT stage, lane, position FROM scheduler_queue WHERE challenge_id = ?")
          .get(challengeId) as
          | { stage: SchedulerQueueStage; lane: SchedulerQueueLane; position: number }
          | undefined
        if (!row || (stage !== undefined && row.stage !== stage)) continue
        this.database.prepare("DELETE FROM scheduler_queue WHERE challenge_id = ?").run(challengeId)
        this.database
          .prepare(`
            UPDATE scheduler_queue
            SET position = position - 1, version = version + 1
            WHERE stage = ? AND lane = ? AND position > ?
          `)
          .run(row.stage, row.lane, row.position)
        changed.add(row.stage)
        removed++
      }
      if (changed.size > 0) {
        this.database
          .prepare(`
            UPDATE scheduler_control
            SET idle_version = idle_version + ?,
                execution_version = execution_version + ?,
                updated_at = ?
            WHERE singleton = 1
          `)
          .run(
            changed.has("idle") ? 1 : 0,
            changed.has("execution") ? 1 : 0,
            new Date().toISOString(),
          )
      }
      this.database.exec("COMMIT")
      return removed
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

  recordChallengeBlockEvent(input: RecordChallengeBlockEvent): ChallengeBlockEvent {
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
        if (existing.challenge_id !== input.challengeId || existing.run_id !== input.runId) {
          throw new Error(`Block event key already belongs to another Run: ${eventKey}`)
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
        state.base_block_threshold + state.revival_count * BLOCK_THRESHOLD_REVIVAL_INCREMENT
      const scoreBefore = state.block_score
      const scoreAfter = scoreBefore + input.delta
      const blocked = state.blocked === 1 || scoreAfter > threshold
      const blockedAt = blocked ? (state.blocked_at ?? timestamp) : state.blocked_at
      const blockedRunId = blocked ? (state.blocked_run_id ?? input.runId) : null

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
          input.compactPerformed === undefined ? null : input.compactPerformed ? 1 : 0,
          timestamp,
        )
      this.database
        .prepare(`
          UPDATE challenge_runtime_state
          SET block_score = ?, blocked = ?, blocked_at = ?, blocked_run_id = ?,
              updated_at = ?
          WHERE challenge_id = ?
        `)
        .run(scoreAfter, blocked ? 1 : 0, blockedAt, blockedRunId, timestamp, input.challengeId)
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

  forceChallengeBlocked(input: { challengeId: string; runId: string; blockedAt?: string }): void {
    this.assertOpen()
    const timestamp = input.blockedAt ?? new Date().toISOString()
    this.database.exec("BEGIN IMMEDIATE")
    try {
      this.assertRunBelongsToChallenge(input.runId, input.challengeId)
      this.database
        .prepare(`
          INSERT INTO challenge_runtime_state (
            challenge_id, session_interruptions, blocked, block_score,
            blocked_at, blocked_run_id, updated_at
          ) VALUES (?, 0, 1, 0, ?, ?, ?)
          ON CONFLICT(challenge_id) DO UPDATE SET
            blocked = 1,
            blocked_at = COALESCE(blocked_at, excluded.blocked_at),
            blocked_run_id = COALESCE(blocked_run_id, excluded.blocked_run_id),
            updated_at = excluded.updated_at
        `)
        .run(input.challengeId, timestamp, input.runId, timestamp)
      this.database.exec("COMMIT")
    } catch (error) {
      this.database.exec("ROLLBACK")
      throw error
    }
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
        this.insertEvent(latest.id, "session_interruptions_reset", { challengeId }, timestamp)
      }
      this.database.exec("COMMIT")
    } catch (error) {
      this.database.exec("ROLLBACK")
      throw error
    }
  }

  /** 删除该题全部 Run（级联事件/SubAgent/黑板/block 事件/环境租约/公告投递）与题目级持久状态，
   *  返回被删除的 Run 记录供调用方清理 session 目录。 */
  resetChallenge(challengeId: string): RunRecord[] {
    this.assertOpen()
    const runs = this.listRuns({ challengeId })
    this.database.exec("BEGIN IMMEDIATE")
    try {
      // scheduler_queue：与 removeSchedulerChallenge 相同地重排同 stage/lane 剩余 position
      const queued = this.database
        .prepare("SELECT stage, lane, position FROM scheduler_queue WHERE challenge_id = ?")
        .get(challengeId) as
        | { stage: SchedulerQueueStage; lane: SchedulerQueueLane; position: number }
        | undefined
      if (queued) {
        this.database.prepare("DELETE FROM scheduler_queue WHERE challenge_id = ?").run(challengeId)
        this.database
          .prepare(`
            UPDATE scheduler_queue
            SET position = position - 1, version = version + 1
            WHERE stage = ? AND lane = ? AND position > ?
          `)
          .run(queued.stage, queued.lane, queued.position)
        this.database
          .prepare(`
            UPDATE scheduler_control
            SET idle_version = idle_version + ?,
                execution_version = execution_version + ?,
                updated_at = ?
            WHERE singleton = 1
          `)
          .run(
            queued.stage === "idle" ? 1 : 0,
            queued.stage === "execution" ? 1 : 0,
            new Date().toISOString(),
          )
      }
      // 级联删除该题全部 Run 的 run_events / run_subagents / challenge_evidence /
      // challenge_opportunities(+sources) / challenge_block_events /
      // remote_environment_leases / announcement_deliveries
      this.database.prepare("DELETE FROM runs WHERE challenge_id = ?").run(challengeId)
      // 题目级状态不随 Run 级联，必须显式清理
      this.database.prepare("DELETE FROM challenge_tldr WHERE challenge_id = ?").run(challengeId)
      this.database
        .prepare("DELETE FROM challenge_runtime_state WHERE challenge_id = ?")
        .run(challengeId)
      this.database
        .prepare("DELETE FROM challenge_scheduling_overrides WHERE challenge_id = ?")
        .run(challengeId)
      this.database.exec("COMMIT")
    } catch (error) {
      this.database.exec("ROLLBACK")
      throw error
    }
    return runs
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

  recentEvents(limit = 80): RunEvent[] {
    this.assertOpen()
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error("recent event limit 必须是 1–500 的整数")
    }
    const rows = this.database
      .prepare(`
      SELECT * FROM run_events
      WHERE type NOT IN ('agent_thinking', 'agent_usage')
      ORDER BY id DESC
      LIMIT ?
    `)
      .all(limit) as unknown as EventRow[]
    return rows.map((row) => ({
      id: row.id,
      runId: row.run_id,
      type: row.type,
      ...(row.data_json ? { data: JSON.parse(row.data_json) as unknown } : {}),
      createdAt: row.created_at,
    }))
  }

  appendEvent(
    runId: string,
    type: string,
    data?: unknown,
    options: { recordModelTokenUsage?: boolean } = {},
  ): RunEvent {
    this.assertOpen()
    const timestamp = new Date().toISOString()
    this.database.exec("BEGIN IMMEDIATE")
    try {
      const id = this.insertEvent(runId, type, data, timestamp)
      if (type === "agent_usage" && options.recordModelTokenUsage !== false) {
        const usage = modelTokenUsageFromEvent({
          id,
          run_id: runId,
          type,
          data_json: data === undefined ? null : JSON.stringify(data),
          created_at: timestamp,
        })
        if (usage) this.insertModelTokenUsage(usage)
      }
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

  recordModelTokenUsage(input: RecordModelTokenUsage): void {
    this.assertOpen()
    this.insertModelTokenUsage(input)
  }

  modelTokenUsage(): ProjectTokenUsageSnapshot {
    this.assertOpen()
    const rows = this.database
      .prepare(`
        SELECT
          provider,
          model,
          SUM(input_tokens) AS input_tokens,
          SUM(output_tokens) AS output_tokens,
          SUM(cache_read_tokens) AS cache_read_tokens,
          SUM(cache_write_tokens) AS cache_write_tokens
        FROM model_token_usage
        GROUP BY provider, model
        ORDER BY
          SUM(input_tokens + output_tokens + cache_read_tokens) DESC,
          provider ASC,
          model ASC
      `)
      .all() as unknown as Array<{
      provider: string
      model: string
      input_tokens: number
      output_tokens: number
      cache_read_tokens: number
      cache_write_tokens: number
    }>
    const models = rows.map((row) => modelTokenUsageFromValues(row))
    const totalValues = models.reduce(
      (totals, usage) => ({
        inputTokens: totals.inputTokens + usage.inputTokens,
        outputTokens: totals.outputTokens + usage.outputTokens,
        cacheReadTokens: totals.cacheReadTokens + usage.cacheReadTokens,
        cacheWriteTokens: totals.cacheWriteTokens + usage.cacheWriteTokens,
      }),
      { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    )
    const totals = modelTokenUsageFromValues({
      provider: "",
      model: "",
      input_tokens: totalValues.inputTokens,
      output_tokens: totalValues.outputTokens,
      cache_read_tokens: totalValues.cacheReadTokens,
      cache_write_tokens: totalValues.cacheWriteTokens,
    })
    return {
      generatedAt: new Date().toISOString(),
      models,
      totals: {
        inputTokens: totals.inputTokens,
        outputTokens: totals.outputTokens,
        cacheReadTokens: totals.cacheReadTokens,
        cacheWriteTokens: totals.cacheWriteTokens,
        totalTokens: totals.totalTokens,
        cacheHitRate: totals.cacheHitRate,
      },
      unattributedTokens: models
        .filter((usage) => !usage.attributed)
        .reduce((total, usage) => total + usage.totalTokens, 0),
    }
  }

  listEnvironmentLeases(): RemoteEnvironmentLeaseRecord[] {
    this.assertOpen()
    const rows = this.database
      .prepare(`
        SELECT * FROM remote_environment_leases
        ORDER BY acquired_at ASC
      `)
      .all() as unknown as RemoteEnvironmentLeaseRow[]
    return rows.map((row) => ({
      runId: row.run_id,
      challengeId: row.challenge_id,
      environmentId: row.environment_id,
      priority: row.priority,
      acquiredAt: row.acquired_at,
    }))
  }

  saveEnvironmentLease(record: RemoteEnvironmentLeaseRecord): void {
    this.assertOpen()
    this.assertRunBelongsToChallenge(record.runId, record.challengeId)
    this.database
      .prepare(`
        INSERT INTO remote_environment_leases (
          run_id, challenge_id, environment_id, priority, acquired_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET
          challenge_id = excluded.challenge_id,
          environment_id = excluded.environment_id,
          priority = excluded.priority,
          acquired_at = excluded.acquired_at
      `)
      .run(
        record.runId,
        record.challengeId,
        record.environmentId,
        record.priority,
        record.acquiredAt,
      )
  }

  deleteEnvironmentLease(runId: string): void {
    this.assertOpen()
    this.database.prepare("DELETE FROM remote_environment_leases WHERE run_id = ?").run(runId)
  }

  /** Persist one worker snapshot; lifecycle events remain in run_events for replay. */
  upsertSubagent(record: SubagentRecord): SubagentRecord {
    this.assertOpen()
    this.getRunOrThrow(record.runId)
    this.database
      .prepare(`
        INSERT INTO run_subagents (
          id, run_id, role, display_name, description, status, background,
          prompt, session_path, container_cwd, execution_id, result, result_kind, error, active_tool,
          turns, tool_uses, total_tokens, input_tokens, cache_read_tokens,
          cache_write_tokens, created_at, updated_at, started_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          role = excluded.role,
          display_name = excluded.display_name,
          description = excluded.description,
          status = excluded.status,
          background = excluded.background,
          prompt = excluded.prompt,
          session_path = excluded.session_path,
          container_cwd = excluded.container_cwd,
          execution_id = excluded.execution_id,
          result = excluded.result,
          result_kind = excluded.result_kind,
          error = excluded.error,
          active_tool = excluded.active_tool,
          turns = excluded.turns,
          tool_uses = excluded.tool_uses,
          total_tokens = excluded.total_tokens,
          input_tokens = excluded.input_tokens,
          cache_read_tokens = excluded.cache_read_tokens,
          cache_write_tokens = excluded.cache_write_tokens,
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
        record.executionId ?? null,
        record.result ?? null,
        record.resultKind ?? null,
        record.error ?? null,
        record.activeTool ?? null,
        record.turns,
        record.toolUses,
        record.totalTokens,
        record.inputTokens ?? 0,
        record.cacheReadTokens ?? 0,
        record.cacheWriteTokens ?? 0,
        record.createdAt,
        record.updatedAt,
        record.startedAt ?? null,
        record.completedAt ?? null,
      )
    return { ...record }
  }

  /** Commit execution transitions atomically and reject late updates from older executions. */
  saveSubagentExecution(
    record: SubagentRecord,
    operation:
      | { kind: "begin"; previousExecutionId: string | null | undefined }
      | { kind: "update" },
  ): void {
    this.assertOpen()
    this.database.exec("BEGIN IMMEDIATE")
    try {
      const current = this.database
        .prepare("SELECT run_id, execution_id, status FROM run_subagents WHERE id = ?")
        .get(record.id) as
        | { run_id: string; execution_id: string | null; status: string }
        | undefined
      if (operation.kind === "begin") {
        if (operation.previousExecutionId === undefined) {
          if (current) throw new Error("subagent_execution_changed")
        } else if (
          !current ||
          current.run_id !== record.runId ||
          current.execution_id !== operation.previousExecutionId ||
          current.status === "queued" ||
          current.status === "running"
        ) {
          throw new Error("subagent_execution_changed")
        }
      } else if (
        !current ||
        current.run_id !== record.runId ||
        current.execution_id !== (record.executionId ?? null) ||
        current.status === "completed" ||
        current.status === "failed" ||
        current.status === "cancelled" ||
        current.status === "aborted" ||
        current.status === "interrupted"
      ) {
        throw new Error("subagent_execution_changed")
      }
      this.upsertSubagent(record)
      this.database.exec("COMMIT")
    } catch (error) {
      this.database.exec("ROLLBACK")
      throw error
    }
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

  markInterruptedSubagents(message = "进程退出时 SubAgent 未进入终态"): SubagentRecord[] {
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

  recordEvidence(challengeId: string, runId: string, description: string): EvidenceRecord {
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

  updateEvidence(challengeId: string, evidenceId: number, description: string): EvidenceRecord {
    this.assertOpen()
    const normalized = normalizedDescription(description, "description")
    const row = this.database
      .prepare(`
        SELECT * FROM challenge_evidence
        WHERE id = ? AND challenge_id = ?
      `)
      .get(evidenceId, challengeId) as unknown as EvidenceRow | undefined
    if (!row) {
      throw new Error(`Evidence ${evidenceId} not found for challenge ${challengeId}`)
    }
    this.database
      .prepare(`
        UPDATE challenge_evidence SET description = ?
        WHERE id = ? AND challenge_id = ?
      `)
      .run(normalized, evidenceId, challengeId)
    return evidenceRecordFromRow({ ...row, description: normalized })
  }

  deleteEvidence(challengeId: string, evidenceId: number): EvidenceRecord {
    this.assertOpen()
    this.database.exec("BEGIN IMMEDIATE")
    try {
      const row = this.database
        .prepare(`
          SELECT * FROM challenge_evidence
          WHERE id = ? AND challenge_id = ?
        `)
        .get(evidenceId, challengeId) as unknown as EvidenceRow | undefined
      if (!row) {
        throw new Error(`Evidence ${evidenceId} not found for challenge ${challengeId}`)
      }
      const reference = this.database
        .prepare(`
          SELECT o.id
          FROM challenge_opportunities o
          LEFT JOIN challenge_opportunity_sources os ON os.opportunity_id = o.id
          WHERE o.challenge_id = ?
            AND (os.evidence_id = ? OR o.target_evidence_id = ?)
          LIMIT 1
        `)
        .get(challengeId, evidenceId, evidenceId) as { id: number } | undefined
      if (reference) {
        throw new Error(
          `Evidence ${evidenceId} is referenced by Opportunity ${reference.id}; update or delete that opportunity first`,
        )
      }
      this.database
        .prepare("DELETE FROM challenge_evidence WHERE id = ? AND challenge_id = ?")
        .run(evidenceId, challengeId)
      this.database.exec("COMMIT")
      return evidenceRecordFromRow(row)
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
    const deduped = normalizedSourceEvidenceIds(sourceEvidenceIds)
    const timestamp = new Date().toISOString()
    this.database.exec("BEGIN IMMEDIATE")
    try {
      this.assertRunBelongsToChallenge(runId, challengeId)
      this.assertChallengeEntryCapacity(
        "challenge_opportunities",
        challengeId,
        BLACKBOARD_MAX_OPPORTUNITIES_PER_CHALLENGE,
      )
      // 校验所有 source evidence 属于同一个 challenge，防止跨题知识串联。
      this.assertEvidenceBelongsToChallenge(challengeId, deduped)

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

  updateOpportunity(
    challengeId: string,
    opportunityId: number,
    input: { description?: string; sourceEvidenceIds?: number[] },
  ): OpportunityRecord {
    this.assertOpen()
    if (input.description === undefined && input.sourceEvidenceIds === undefined) {
      throw new Error("description or sourceEvidenceIds is required")
    }
    const normalized =
      input.description === undefined
        ? undefined
        : normalizedDescription(input.description, "description")
    const sources =
      input.sourceEvidenceIds === undefined
        ? undefined
        : normalizedSourceEvidenceIds(input.sourceEvidenceIds)
    this.database.exec("BEGIN IMMEDIATE")
    try {
      const row = this.database
        .prepare(`
          SELECT * FROM challenge_opportunities
          WHERE id = ? AND challenge_id = ?
        `)
        .get(opportunityId, challengeId) as unknown as OpportunityRow | undefined
      if (!row) {
        throw new Error(`Opportunity ${opportunityId} not found for challenge ${challengeId}`)
      }
      if (sources) this.assertEvidenceBelongsToChallenge(challengeId, sources)
      this.database
        .prepare(`
          UPDATE challenge_opportunities SET description = ?
          WHERE id = ? AND challenge_id = ?
        `)
        .run(normalized ?? row.description, opportunityId, challengeId)
      if (sources) {
        this.database
          .prepare("DELETE FROM challenge_opportunity_sources WHERE opportunity_id = ?")
          .run(opportunityId)
        const insertSource = this.database.prepare(`
          INSERT INTO challenge_opportunity_sources (opportunity_id, evidence_id)
          VALUES (?, ?)
        `)
        for (const evidenceId of sources) {
          insertSource.run(opportunityId, evidenceId)
        }
      }
      const updated = this.database
        .prepare("SELECT * FROM challenge_opportunities WHERE id = ?")
        .get(opportunityId) as unknown as OpportunityRow
      const sourceRows = this.database
        .prepare(`
          SELECT evidence_id FROM challenge_opportunity_sources
          WHERE opportunity_id = ? ORDER BY evidence_id
        `)
        .all(opportunityId) as unknown as OpportunitySourceRow[]
      this.database.exec("COMMIT")
      return opportunityFromRow(
        updated,
        sourceRows.map((source) => source.evidence_id),
      )
    } catch (error) {
      this.database.exec("ROLLBACK")
      throw error
    }
  }

  deleteOpportunity(challengeId: string, opportunityId: number): OpportunityRecord {
    this.assertOpen()
    this.database.exec("BEGIN IMMEDIATE")
    try {
      const row = this.database
        .prepare(`
          SELECT * FROM challenge_opportunities
          WHERE id = ? AND challenge_id = ?
        `)
        .get(opportunityId, challengeId) as unknown as OpportunityRow | undefined
      if (!row) {
        throw new Error(`Opportunity ${opportunityId} not found for challenge ${challengeId}`)
      }
      const sourceRows = this.database
        .prepare(`
          SELECT evidence_id FROM challenge_opportunity_sources
          WHERE opportunity_id = ? ORDER BY evidence_id
        `)
        .all(opportunityId) as unknown as OpportunitySourceRow[]
      this.database
        .prepare("DELETE FROM challenge_opportunities WHERE id = ? AND challenge_id = ?")
        .run(opportunityId, challengeId)
      this.database.exec("COMMIT")
      return opportunityFromRow(
        row,
        sourceRows.map((source) => source.evidence_id),
      )
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
      throw new Error("Unsupported opportunity resolution")
    }
    const normalized = normalizedDescription(resultDescription, "resultDescription")
    const timestamp = new Date().toISOString()
    this.database.exec("BEGIN IMMEDIATE")
    try {
      this.assertRunBelongsToChallenge(runId, challengeId)
      const row = this.database
        .prepare(`
        SELECT * FROM challenge_opportunities
        WHERE id = ? AND challenge_id = ?
      `)
        .get(opportunityId, challengeId) as unknown as OpportunityRow | undefined
      if (!row)
        throw new Error(`Opportunity ${opportunityId} not found for challenge ${challengeId}`)
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

  getBlackboardRecords(challengeId: string): {
    evidence: EvidenceRecord[]
    opportunities: OpportunityRecord[]
  } {
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
      evidence: evidenceRows.map(evidenceRecordFromRow),
      opportunities: opportunityRows.map((row) =>
        opportunityFromRow(row, sourcesByOpp.get(row.id) ?? []),
      ),
    }
  }

  getBlackboardSummary(challengeId: string): BlackboardSummary {
    const records = this.getBlackboardRecords(challengeId)
    return {
      evidence: records.evidence.map(({ id, description, runId }) => ({ id, description, runId })),
      opportunities: records.opportunities,
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

  /** 首次建立统一账本时，将旧版分散的用量字段导入一次。 */
  private backfillModelTokenUsage(): void {
    this.database.exec("BEGIN IMMEDIATE")
    try {
      const events = this.database
        .prepare("SELECT * FROM run_events WHERE type = 'agent_usage' ORDER BY id ASC")
        .all() as unknown as EventRow[]
      for (const event of events) {
        const usage = modelTokenUsageFromEvent(event)
        if (usage) this.insertModelTokenUsage(usage)
      }

      const subagents = this.database
        .prepare("SELECT * FROM run_subagents ORDER BY created_at ASC, id ASC")
        .all() as unknown as SubagentRow[]
      for (const subagent of subagents) {
        const outputTokens = Math.max(
          0,
          subagent.total_tokens -
            subagent.input_tokens -
            subagent.cache_read_tokens -
            subagent.cache_write_tokens,
        )
        if (
          subagent.input_tokens +
            outputTokens +
            subagent.cache_read_tokens +
            subagent.cache_write_tokens ===
          0
        ) {
          continue
        }
        this.insertModelTokenUsage({
          source: "legacy-subagent",
          sourceId: subagent.id,
          provider: "legacy",
          model: "历史 SubAgent（模型未知）",
          inputTokens: subagent.input_tokens,
          outputTokens,
          cacheReadTokens: subagent.cache_read_tokens,
          cacheWriteTokens: subagent.cache_write_tokens,
          createdAt: subagent.updated_at,
        })
      }

      const tldrs = this.database
        .prepare("SELECT * FROM challenge_tldr ORDER BY updated_at ASC, challenge_id ASC")
        .all() as unknown as TldrRow[]
      for (const tldr of tldrs) {
        if (tldr.input_tokens + tldr.cache_read_tokens + tldr.cache_write_tokens === 0) continue
        const identity = legacyModelIdentity(tldr.model)
        this.insertModelTokenUsage({
          source: "legacy-tldr",
          sourceId: tldr.challenge_id,
          provider: identity.provider,
          model: identity.model,
          inputTokens: tldr.input_tokens,
          outputTokens: 0,
          cacheReadTokens: tldr.cache_read_tokens,
          cacheWriteTokens: tldr.cache_write_tokens,
          createdAt: tldr.updated_at,
        })
      }
      this.database.exec("COMMIT")
    } catch (error) {
      this.database.exec("ROLLBACK")
      throw error
    }
  }

  private insertModelTokenUsage(input: RecordModelTokenUsage): void {
    const provider = normalizedUsageIdentity(input.provider, "provider")
    const model = normalizedUsageIdentity(input.model, "model")
    const inputTokens = normalizedTokenCount(input.inputTokens)
    const outputTokens = normalizedTokenCount(input.outputTokens)
    const cacheReadTokens = normalizedTokenCount(input.cacheReadTokens)
    const cacheWriteTokens = normalizedTokenCount(input.cacheWriteTokens ?? 0)
    this.database
      .prepare(`
        INSERT INTO model_token_usage (
          source, source_id, provider, model, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        normalizedUsageIdentity(input.source, "source"),
        input.sourceId ?? null,
        provider,
        model,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        input.createdAt ?? new Date().toISOString(),
      )
  }

  private getRunOrThrow(id: string): RunRecord {
    const run = this.getRun(id)
    if (!run) throw new Error(`RunStore 中不存在 Run: ${id}`)
    return run
  }

  private insertEvent(runId: string, type: string, data: unknown, timestamp: string): number {
    const result = this.database
      .prepare(`
      INSERT INTO run_events (run_id, type, data_json, created_at)
      VALUES (?, ?, ?, ?)
    `)
      .run(runId, type, data === undefined ? null : JSON.stringify(data), timestamp)
    return Number(result.lastInsertRowid)
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("RunStore 已关闭")
  }

  private assertRunBelongsToChallenge(runId: string, challengeId: string): void {
    const row = this.database
      .prepare(`
      SELECT challenge_id FROM runs WHERE id = ?
    `)
      .get(runId) as { challenge_id: string } | undefined
    if (!row) throw new Error(`RunStore 中不存在 Run: ${runId}`)
    if (row.challenge_id !== challengeId) {
      throw new Error(`Run ${runId} does not belong to challenge ${challengeId}`)
    }
  }

  private assertEvidenceBelongsToChallenge(challengeId: string, evidenceIds: number[]): void {
    const placeholders = evidenceIds.map(() => "?").join(", ")
    const rows = this.database
      .prepare(`
        SELECT id FROM challenge_evidence
        WHERE id IN (${placeholders}) AND challenge_id = ?
      `)
      .all(...evidenceIds, challengeId) as unknown as { id: number }[]
    if (rows.length !== evidenceIds.length) {
      throw new Error("One or more source evidence IDs do not belong to this challenge")
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
      throw new Error(`${table} has reached the per-challenge limit of ${maximum}`)
    }
  }
}
