export const CODEX_SECURITY_ADAPTER_ID = "codex-security" as const
export type CodeAuditAdapterId = typeof CODEX_SECURITY_ADAPTER_ID

export type AuditProjectStatus =
  | "draft"
  | "ready"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
export type AuditRunStatus =
  | "queued"
  | "blocked"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled"

/** 独立于 CTF 的长期代码审计项目。 */
export interface CodeAuditProject {
  id: string
  name: string
  archiveName: string
  archiveSize: number
  archivePath: string
  status: AuditProjectStatus
  includePaths: string[]
  excludePaths: string[]
  /** 模型池中用于此项目白盒审计的模型 ID。 */
  auditModelId: string
  createdAt: string
  updatedAt: string
}

export interface CreateCodeAuditProject {
  name: string
  archiveName: string
  archiveSize: number
  archivePath: string
}

export interface UpdateCodeAuditProject {
  includePaths: string[]
  excludePaths: string[]
  auditModelId: string
}

export type CodeAuditJsonObject = Record<string, unknown>

export interface CodeAuditFindingLocation {
  path: string
  startLine: number
  endLine?: number
  role?: string
  [key: string]: unknown
}

export interface CodeAuditCodeEvidence {
  id: string
  label: string
  path: string
  startLine: number
  endLine?: number
  language?: string
  role?: string
  code: string
  explanation: string
  [key: string]: unknown
}

export interface CodeAuditFindingRecord {
  findingId: string
  occurrenceId: string
  ruleId: string
  identity: CodeAuditJsonObject
  fingerprints: CodeAuditJsonObject
  title: string
  summary: string
  severity: {
    level: "critical" | "high" | "medium" | "low" | "informational"
    score?: number
    scoringSystem?: string
    vector?: string
    rationale?: string
    changeConditions?: string
    [key: string]: unknown
  }
  confidence: {
    level: "high" | "medium" | "low"
    rationale: string
    [key: string]: unknown
  }
  taxonomy: {
    category: string
    cwe: string[]
    [key: string]: unknown
  }
  locations: CodeAuditFindingLocation[]
  writeup?: CodeAuditJsonObject
  codeEvidence?: CodeAuditCodeEvidence[]
  rootCause?: CodeAuditJsonObject | string
  remediation: string
  validation?: CodeAuditJsonObject | null
  attackPath?: CodeAuditJsonObject | null
  remediationTests?: string[]
  preventiveControls?: string[]
  provenance: CodeAuditJsonObject
  extensions?: CodeAuditJsonObject
  [key: string]: unknown
}

export interface CodeAuditFindingsDocument {
  documentType: string
  schemaVersion: string
  scanId: string
  findings: CodeAuditFindingRecord[]
  [key: string]: unknown
}

export interface CodeAuditCoverageSurface {
  id: string
  label: string
  disposition: "reported" | "no_issue_found" | "rejected" | "not_applicable" | "needs_follow_up"
  receiptRefs: string[]
  riskArea?: string
  notes?: string
  [key: string]: unknown
}

export interface CodeAuditCoverageOpenQuestion {
  question: string
  followUpPrompt?: string
  [key: string]: unknown
}

export interface CodeAuditCoverageDocument {
  documentType: string
  schemaVersion: string
  scanId: string
  mode: string
  completeness: "complete" | "partial" | "unknown"
  inventoryStrategy: string
  includePaths: string[]
  excludePaths: string[]
  surfaces: CodeAuditCoverageSurface[]
  explicitExclusions: Array<{
    pattern: string
    reason: string
    [key: string]: unknown
  }>
  deferred: Array<{
    id: string
    reason: string
    paths?: string[]
    surfaceIds?: string[]
    [key: string]: unknown
  }>
  openQuestions?: Array<CodeAuditCoverageOpenQuestion | string>
  [key: string]: unknown
}

export interface CodeAuditManifestTarget {
  kind: string
  targetId: string
  displayName: string
  remote?: string
  revision?: string
  baseRevision?: string
  headRevision?: string
  snapshotDigest?: string
  [key: string]: unknown
}

export interface CodeAuditManifest {
  documentType: string
  schemaVersion: string
  scan: {
    id: string
    producer: CodeAuditJsonObject
    status: string
    startedAt: string
    completedAt: string
    sealedAt: string
    target: CodeAuditManifestTarget
    scope: CodeAuditJsonObject
    threatModel?: CodeAuditJsonObject
    hardening?: CodeAuditJsonObject
    coverageRef: string
    findingsRef: string
    artifacts: Array<{
      path: string
      sha256: string
      mediaType: string
      [key: string]: unknown
    }>
    [key: string]: unknown
  }
  [key: string]: unknown
}

export interface CodeAuditRunResult {
  runId: string
  findings: CodeAuditFindingsDocument | null
  coverage: CodeAuditCoverageDocument | null
  manifest: CodeAuditManifest | null
}

export interface CodeAuditFinding {
  id: string
  runId: string
  findingId: string
  title: string
  summary: string
  severity: "critical" | "high" | "medium" | "low" | "informational"
  confidence: "high" | "medium" | "low"
  path: string
  startLine: number
  remediation: string
}

export interface CodeAuditProgress {
  phase: string
  message: string
  filesCompleted?: number
  filesTotal?: number
  updatedAt: string
}

export interface CodeAuditRun {
  id: string
  auditProjectId: string
  status: AuditRunStatus
  mode: "standard" | "deep"
  purpose: "scan" | "follow_up"
  parentRunId?: string
  followUpPrompt?: string
  createdAt: string
  updatedAt: string
  error?: string
  progress?: CodeAuditProgress
}

export interface CreateCodeAuditRunOptions {
  mode: "standard" | "deep"
  purpose?: "scan" | "follow_up"
  parentRunId?: string
  followUpPrompt?: string
}

export interface CodeAuditAdapterStatus {
  id: CodeAuditAdapterId
  available: boolean
  reason: string
}

export interface CodeAuditCatalog {
  audits: CodeAuditProject[]
  adapter: CodeAuditAdapterStatus
}

/** Worker 唯一接收的执行边界，控制面和浏览器不得读取 archivePath 内的源码。 */
export interface CodeAuditWorkerRequest {
  auditProjectId: string
  runId: string
  archivePath: string
  outputPath: string
  adapterId: CodeAuditAdapterId
}

export interface CodeAuditWorkerResult {
  runId: string
  status: "completed" | "failed" | "cancelled"
  bundlePath?: string
  error?: string
}
