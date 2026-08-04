import { randomUUID } from "node:crypto"
import { Agent, type AgentOptions, type AgentTool, type AgentToolResult } from "@earendil-works/pi-agent-core"
import { Type } from "typebox"
import type { ChallengeCapability, ChallengeInfo } from "../platform/types.ts"
import type { Sandbox } from "../sandbox/docker-sandbox.ts"
import { createSolverTools } from "../sandbox/tools.ts"
import { buildSkillsCatalog, createLoadSkillTool, type AgentSkill } from "../skills/project-skills.ts"
import { extractAssistantText } from "./thinking.ts"

export type SubagentStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "timed_out"
export type SubagentReportStatus = "found" | "not_found" | "blocked"

export interface SubagentTaskInput {
  task: string
  role?: string
  context?: string
}

export interface SubagentReport {
  status: SubagentReportStatus
  summary: string
  findings: string[]
  artifacts: string[]
  commands: string[]
  nextSteps: string[]
  confidence: number
}

export interface SubagentSnapshot extends SubagentTaskInput {
  id: string
  runId: string
  status: SubagentStatus
  workdir: string
  createdAt: string
  startedAt?: string
  finishedAt?: string
  report?: SubagentReport
  error?: string
}

export interface CreateSubagentAgentContext extends SubagentTaskInput {
  id: string
  runId: string
  challenge: ChallengeInfo
  workdir: string
}

export interface SubagentFeatureOptions {
  maxConcurrent?: number
  maxTotal?: number
  timeoutMs?: number
  abortGraceMs?: number
  /** 缺省时复用主 Agent 的模型和 provider 配置，但始终清空 transcript 与工具。 */
  createAgentOptions?: (context: CreateSubagentAgentContext) => AgentOptions | Promise<AgentOptions>
}

export interface SubagentManagerEvent {
  type: "created" | "started" | "completed" | "failed" | "cancelled" | "timed_out"
  subagent: SubagentSnapshot
}

export interface SubagentManagerOptions {
  runId: string
  challenge: ChallengeInfo
  capability: ChallengeCapability
  sandbox: Sandbox
  parentAgent: AgentOptions
  skills?: readonly AgentSkill[]
  feature?: SubagentFeatureOptions
  onEvent?: (event: SubagentManagerEvent) => Promise<void> | void
}

interface RuntimeRecord extends SubagentSnapshot {
  controller: AbortController
  agent?: Agent
  completion: Promise<void>
  resolveCompletion(): void
  completionResolved: boolean
  cancelRequested: boolean
}

const DEFAULT_MAX_CONCURRENT = 3
const DEFAULT_MAX_TOTAL = 8
const DEFAULT_TIMEOUT_MS = 10 * 60_000
const DEFAULT_ABORT_GRACE_MS = 1_000
const WORKER_TOOL_NAMES = [
  "bash",
  "read",
  "write",
  "edit",
  "list",
  "ctf_challenge_info",
  "ctf_download_attachment",
  "ctf_instance_status",
] as const

/**
 * 单个 Solver 内的辅助 Agent 生命周期管理器。
 * Worker 共享题目 Sandbox，但只拥有独立工作目录和只读/分析型题目工具。
 */
export class SubagentManager {
  readonly maxConcurrent: number
  readonly maxTotal: number
  readonly timeoutMs: number
  readonly abortGraceMs: number
  private readonly records = new Map<string, RuntimeRecord>()
  private readonly queue: RuntimeRecord[] = []
  private active = 0
  private closed = false
  private closing?: Promise<void>

  constructor(private readonly options: SubagentManagerOptions) {
    this.maxConcurrent = positiveInteger(options.feature?.maxConcurrent ?? DEFAULT_MAX_CONCURRENT, "subagents.maxConcurrent")
    this.maxTotal = positiveInteger(options.feature?.maxTotal ?? DEFAULT_MAX_TOTAL, "subagents.maxTotal")
    this.timeoutMs = positiveInteger(options.feature?.timeoutMs ?? DEFAULT_TIMEOUT_MS, "subagents.timeoutMs")
    this.abortGraceMs = nonNegativeInteger(options.feature?.abortGraceMs ?? DEFAULT_ABORT_GRACE_MS, "subagents.abortGraceMs")
  }

  spawn(tasks: readonly SubagentTaskInput[]): SubagentSnapshot[] {
    if (this.closed) throw new Error("SubAgent 管理器已关闭")
    if (tasks.length === 0) throw new Error("至少需要一个 SubAgent 任务")
    if (this.records.size + tasks.length > this.maxTotal) {
      throw new Error(`SubAgent 总数超过上限 ${this.maxTotal}`)
    }
    const normalized = tasks.map((input) => {
      const task = input.task.trim()
      if (!task) throw new Error("SubAgent task 不能为空")
      return {
        task,
        ...(input.role?.trim() ? { role: input.role.trim() } : {}),
        ...(input.context?.trim() ? { context: input.context.trim() } : {}),
      }
    })

    const created = normalized.map((input) => {
      const id = randomUUID()
      const workdir = `/workspace/subagents/${id}`
      let resolveCompletion!: () => void
      const completion = new Promise<void>((resolve) => { resolveCompletion = resolve })
      const record: RuntimeRecord = {
        id,
        runId: this.options.runId,
        task: input.task,
        ...(input.role ? { role: input.role } : {}),
        ...(input.context ? { context: input.context } : {}),
        status: "queued",
        workdir,
        createdAt: new Date().toISOString(),
        controller: new AbortController(),
        completion,
        resolveCompletion,
        completionResolved: false,
        cancelRequested: false,
      }
      this.records.set(id, record)
      this.queue.push(record)
      this.emit("created", record)
      return this.snapshot(record)
    })
    this.pump()
    return created
  }

  list(ids?: readonly string[]): SubagentSnapshot[] {
    const records = ids ? ids.map((id) => this.requireRecord(id)) : [...this.records.values()]
    return records.map((record) => this.snapshot(record))
  }

  async wait(
    ids?: readonly string[],
    mode: "any" | "all" = "all",
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<{ timedOut: boolean; aborted: boolean; subagents: SubagentSnapshot[] }> {
    const records = ids ? ids.map((id) => this.requireRecord(id)) : [...this.records.values()]
    if (records.length === 0) return { timedOut: false, aborted: false, subagents: [] }
    if (mode === "any" && records.some((record) => terminal(record.status))) {
      return { timedOut: false, aborted: false, subagents: records.map((record) => this.snapshot(record)) }
    }
    const pending = records.filter((record) => !terminal(record.status))
    if (pending.length === 0) return { timedOut: false, aborted: false, subagents: records.map((record) => this.snapshot(record)) }
    const operation = mode === "any"
      ? Promise.race(pending.map((record) => record.completion))
      : Promise.all(pending.map((record) => record.completion)).then(() => undefined)
    const outcome = await waitOutcome(
      operation,
      timeoutMs === undefined ? undefined : nonNegativeInteger(timeoutMs, "timeoutMs"),
      signal,
    )
    return {
      timedOut: outcome === "timed_out",
      aborted: outcome === "aborted",
      subagents: records.map((record) => this.snapshot(record)),
    }
  }

  cancel(ids: readonly string[]): SubagentSnapshot[] {
    const records = ids.map((id) => this.requireRecord(id))
    for (const record of records) {
      if (terminal(record.status)) continue
      record.cancelRequested = true
      record.controller.abort()
      record.agent?.abort()
      if (record.status === "queued") {
        record.status = "cancelled"
        record.finishedAt = new Date().toISOString()
        this.resolve(record)
        this.emit("cancelled", record)
      }
    }
    this.pump()
    return records.map((record) => this.snapshot(record))
  }

  async close(): Promise<void> {
    if (this.closing) return this.closing
    if (this.closed) return
    this.closed = true
    const operation = (async () => {
      const active = [...this.records.values()].filter((record) => !terminal(record.status))
      this.cancel(active.map((record) => record.id))
      await Promise.all(active.map((record) => record.completion))
    })()
    this.closing = operation
    await operation
  }

  private pump(): void {
    while (!this.closed && this.active < this.maxConcurrent && this.queue.length > 0) {
      const record = this.queue.shift()!
      if (record.status !== "queued") continue
      this.active++
      void this.run(record).finally(() => {
        this.active--
        this.resolve(record)
        this.pump()
      })
    }
  }

  private async run(record: RuntimeRecord): Promise<void> {
    record.status = "running"
    record.startedAt = new Date().toISOString()
    this.emit("started", record)
    let report: SubagentReport | undefined
    try {
      const context = this.agentContext(record)
      const deadline = Date.now() + this.timeoutMs
      const preparation = (async () => {
        await this.options.sandbox.exec(["mkdir", "-p", record.workdir], { signal: record.controller.signal })
        return this.options.feature?.createAgentOptions
          ? await this.options.feature.createAgentOptions(context)
          : this.options.parentAgent
      })()
      const prepared = preparation.then(
        (value) => ({ kind: "completed" as const, value }),
        (error: unknown) => ({ kind: "failed" as const, error }),
      )
      const preparationOutcome = await raceWorker(prepared, record.controller.signal, remaining(deadline))
      if (preparationOutcome.kind === "cancelled" || preparationOutcome.kind === "timed_out") {
        record.controller.abort()
        await settleBefore(prepared.then(() => undefined), this.abortGraceMs)
        if (record.cancelRequested || preparationOutcome.kind === "cancelled") {
          record.status = "cancelled"
        } else {
          record.status = "timed_out"
          record.error = `SubAgent 超过时限 ${this.timeoutMs}ms`
        }
        return
      }
      if (preparationOutcome.kind === "failed") throw preparationOutcome.error
      const configured = preparationOutcome.value
      const reportTool = createReportTool((value) => {
        if (report) throw new Error("SubAgent 已经提交过最终报告")
        report = value
      })
      const tools = createSolverTools({
        capability: this.options.capability,
        sandbox: this.options.sandbox,
        workspaceRoot: record.workdir,
        allowedTools: WORKER_TOOL_NAMES,
        onTerminalSubmission: () => undefined,
      })
      const loadSkill = createLoadSkillTool(this.options.skills ?? [])
      const { initialState, sessionId: _sessionId, ...agentOptions } = configured
      const catalog = buildSkillsCatalog(this.options.skills ?? [])
      const agent = new Agent({
        ...agentOptions,
        sessionId: `${this.options.runId}:subagent:${record.id}`,
        initialState: {
          ...initialState,
          systemPrompt: [
            initialState?.systemPrompt,
            workerSystemPrompt(context),
            catalog,
          ].filter(Boolean).join("\n\n"),
          messages: [],
          tools: [...tools, ...(loadSkill ? [loadSkill] : []), reportTool],
        },
      })
      record.agent = agent
      const settled = agent.prompt(workerPrompt(context)).then(
        () => ({ kind: "completed" as const, value: undefined }),
        (error: unknown) => ({ kind: "failed" as const, error }),
      )
      const outcome = await raceWorker(settled, record.controller.signal, remaining(deadline))
      if (outcome.kind === "cancelled" || outcome.kind === "timed_out") {
        agent.abort()
        if (outcome.kind === "timed_out") record.controller.abort()
        await settleBefore(settled.then(() => undefined), this.abortGraceMs)
      }
      if (record.cancelRequested || outcome.kind === "cancelled") {
        record.status = "cancelled"
      } else if (outcome.kind === "timed_out") {
        record.status = "timed_out"
        record.error = `SubAgent 超过时限 ${this.timeoutMs}ms`
      } else if (outcome.kind === "failed") {
        throw outcome.error
      } else {
        record.status = "completed"
        record.report = report ?? fallbackReport(agent)
      }
    } catch (error) {
      if (record.cancelRequested || record.controller.signal.aborted) {
        record.status = "cancelled"
      } else {
        record.status = "failed"
        record.error = errorText(error)
      }
    } finally {
      record.agent = undefined
      record.finishedAt = new Date().toISOString()
      this.emit(eventType(record.status), record)
    }
  }

  private agentContext(record: RuntimeRecord): CreateSubagentAgentContext {
    return {
      id: record.id,
      runId: record.runId,
      challenge: this.options.challenge,
      task: record.task,
      ...(record.role ? { role: record.role } : {}),
      ...(record.context ? { context: record.context } : {}),
      workdir: record.workdir,
    }
  }

  private requireRecord(id: string): RuntimeRecord {
    const record = this.records.get(id)
    if (!record) throw new Error(`未找到 SubAgent: ${id}`)
    return record
  }

  private resolve(record: RuntimeRecord): void {
    if (record.completionResolved) return
    record.completionResolved = true
    record.resolveCompletion()
  }

  private snapshot(record: RuntimeRecord): SubagentSnapshot {
    return {
      id: record.id,
      runId: record.runId,
      task: record.task,
      ...(record.role ? { role: record.role } : {}),
      ...(record.context ? { context: record.context } : {}),
      status: record.status,
      workdir: record.workdir,
      createdAt: record.createdAt,
      ...(record.startedAt ? { startedAt: record.startedAt } : {}),
      ...(record.finishedAt ? { finishedAt: record.finishedAt } : {}),
      ...(record.report ? { report: cloneReport(record.report) } : {}),
      ...(record.error ? { error: record.error } : {}),
    }
  }

  private emit(type: SubagentManagerEvent["type"], record: RuntimeRecord): void {
    try {
      const operation = this.options.onEvent?.({ type, subagent: this.snapshot(record) })
      if (operation) void Promise.resolve(operation).catch(() => undefined)
    } catch {
      // 遥测回调不能改变 Worker 生命周期。
    }
  }
}

export function createSubagentManagerTools(manager: SubagentManager): AgentTool[] {
  const task = Type.Object({
    task: Type.String({ minLength: 1, maxLength: 20_000 }),
    role: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
    context: Type.Optional(Type.String({ maxLength: 40_000 })),
  })
  const ids = Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 64 })
  return [
    {
      name: "ctf_subagent_spawn",
      label: "Spawn CTF SubAgents",
      description: `批量启动独立探索任务；立即返回 ID。最多并行 ${manager.maxConcurrent} 个、每个 Run 最多 ${manager.maxTotal} 个。`,
      parameters: Type.Object({ tasks: Type.Array(task, { minItems: 1, maxItems: manager.maxTotal }) }),
      executionMode: "sequential",
      async execute(_id, params) {
        const input = params as { tasks: SubagentTaskInput[] }
        return toolResult({ subagents: manager.spawn(input.tasks) })
      },
    },
    {
      name: "ctf_subagent_list",
      label: "List CTF SubAgents",
      description: "列出当前 Run 的 SubAgent 状态与已完成报告。",
      parameters: Type.Object({ ids: Type.Optional(ids) }),
      executionMode: "sequential",
      async execute(_id, params) {
        const input = params as { ids?: string[] }
        return toolResult({ subagents: manager.list(input.ids) })
      },
    },
    {
      name: "ctf_subagent_wait",
      label: "Wait for CTF SubAgents",
      description: "等待指定 SubAgent 中任意一个或全部结束；等待超时不会取消任务。",
      parameters: Type.Object({
        ids: Type.Optional(ids),
        mode: Type.Optional(Type.Union([Type.Literal("any"), Type.Literal("all")])),
        timeoutMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 60_000 })),
      }),
      executionMode: "sequential",
      async execute(_id, params, signal) {
        const input = params as { ids?: string[]; mode?: "any" | "all"; timeoutMs?: number }
        return toolResult(await manager.wait(input.ids, input.mode, input.timeoutMs, signal))
      },
    },
    {
      name: "ctf_subagent_cancel",
      label: "Cancel CTF SubAgents",
      description: "取消排队中或运行中的 SubAgent。",
      parameters: Type.Object({ ids }),
      executionMode: "sequential",
      async execute(_id, params) {
        const input = params as { ids: string[] }
        return toolResult({ subagents: manager.cancel(input.ids) })
      },
    },
  ]
}

function createReportTool(onReport: (report: SubagentReport) => void): AgentTool {
  const stringList = Type.Optional(Type.Array(Type.String({ maxLength: 20_000 }), { maxItems: 128 }))
  return {
    name: "ctf_subagent_report",
    label: "Submit SubAgent Report",
    description: "提交结构化最终报告并结束当前 SubAgent。每个 SubAgent 必须调用一次。",
    parameters: Type.Object({
      status: Type.Union([Type.Literal("found"), Type.Literal("not_found"), Type.Literal("blocked")]),
      summary: Type.String({ minLength: 1, maxLength: 40_000 }),
      findings: stringList,
      artifacts: stringList,
      commands: stringList,
      nextSteps: stringList,
      confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    }),
    executionMode: "sequential",
    async execute(_id, params) {
      const input = params as Partial<SubagentReport> & Pick<SubagentReport, "status" | "summary">
      const report: SubagentReport = {
        status: input.status,
        summary: input.summary,
        findings: input.findings ?? [],
        artifacts: input.artifacts ?? [],
        commands: input.commands ?? [],
        nextSteps: input.nextSteps ?? [],
        confidence: input.confidence ?? 0.5,
      }
      onReport(report)
      return { ...toolResult(report), terminate: true }
    },
  }
}

function workerSystemPrompt(context: CreateSubagentAgentContext): string {
  return [
    "You are a bounded CTF exploration SubAgent working for a main solver.",
    `Your only assigned task is: ${context.task}`,
    context.role ? `Your role is: ${context.role}` : "",
    `Use ${context.workdir} as your default writable working directory.`,
    "Shared challenge attachments are under /workspace/attachments.",
    "Do not attempt to submit a flag, start/destroy challenge instances, modify the blackboard, or create more agents.",
    "Finish by calling ctf_subagent_report exactly once. State uncertainty and useful failed approaches explicitly.",
  ].filter(Boolean).join("\n")
}

function workerPrompt(context: CreateSubagentAgentContext): string {
  return [
    `Challenge: ${context.challenge.title} (${context.challenge.category}, ${context.challenge.score} points)`,
    `Description: ${context.challenge.description}`,
    `Assigned task: ${context.task}`,
    context.context ? `Additional context from the main solver:\n${context.context}` : "",
    "Investigate only this task and return a structured report.",
  ].filter(Boolean).join("\n\n")
}

function fallbackReport(agent: Agent): SubagentReport {
  let summary = "SubAgent 结束时未调用 ctf_subagent_report。"
  for (let index = agent.state.messages.length - 1; index >= 0; index--) {
    const message = agent.state.messages[index]
    if (!message) continue
    const text = extractAssistantText(message)
    if (text) {
      summary = text
      break
    }
  }
  return {
    status: "blocked",
    summary,
    findings: [],
    artifacts: [],
    commands: [],
    nextSteps: ["主 Agent 应检查该任务 transcript 或重新派发。"],
    confidence: 0,
  }
}

async function raceWorker<T>(
  settled: Promise<{ kind: "completed"; value: T } | { kind: "failed"; error: unknown }>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<{ kind: "completed"; value: T } | { kind: "failed"; error: unknown } | { kind: "cancelled" } | { kind: "timed_out" }> {
  let timeout: NodeJS.Timeout | undefined
  let onAbort: (() => void) | undefined
  const timedOut = new Promise<{ kind: "timed_out" }>((resolve) => {
    timeout = setTimeout(() => resolve({ kind: "timed_out" }), timeoutMs)
  })
  const cancelled = new Promise<{ kind: "cancelled" }>((resolve) => {
    if (signal.aborted) return resolve({ kind: "cancelled" })
    onAbort = () => resolve({ kind: "cancelled" })
    signal.addEventListener("abort", onAbort, { once: true })
  })
  try {
    return await Promise.race([settled, timedOut, cancelled])
  } finally {
    if (timeout) clearTimeout(timeout)
    if (onAbort) signal.removeEventListener("abort", onAbort)
  }
}

function remaining(deadline: number): number {
  return Math.max(1, deadline - Date.now())
}

async function settleBefore(operation: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  if (timeoutMs === 0) return false
  let timeout: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      operation.then(() => true),
      new Promise<false>((resolve) => { timeout = setTimeout(() => resolve(false), timeoutMs) }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

async function waitOutcome(
  operation: Promise<unknown>,
  timeoutMs?: number,
  signal?: AbortSignal,
): Promise<"completed" | "timed_out" | "aborted"> {
  if (signal?.aborted) return "aborted"
  let timeout: NodeJS.Timeout | undefined
  let onAbort: (() => void) | undefined
  const candidates: Array<Promise<"completed" | "timed_out" | "aborted">> = [
    operation.then(() => "completed" as const),
  ]
  if (timeoutMs !== undefined) {
    candidates.push(new Promise((resolve) => { timeout = setTimeout(() => resolve("timed_out"), timeoutMs) }))
  }
  if (signal) {
    candidates.push(new Promise((resolve) => {
      onAbort = () => resolve("aborted")
      signal.addEventListener("abort", onAbort, { once: true })
    }))
  }
  try {
    return await Promise.race(candidates)
  } finally {
    if (timeout) clearTimeout(timeout)
    if (onAbort) signal?.removeEventListener("abort", onAbort)
  }
}

function terminal(status: SubagentStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "timed_out"
}

function eventType(status: SubagentStatus): SubagentManagerEvent["type"] {
  if (status === "queued" || status === "running") throw new Error(`SubAgent 尚未结束: ${status}`)
  return status
}

function cloneReport(report: SubagentReport): SubagentReport {
  return {
    ...report,
    findings: [...report.findings],
    artifacts: [...report.artifacts],
    commands: [...report.commands],
    nextSteps: [...report.nextSteps],
  }
}

function toolResult(details: object): AgentToolResult<Record<string, unknown>> {
  const value = details as Record<string, unknown>
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], details: value }
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} 必须是正整数`)
  return value
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} 必须是非负整数`)
  return value
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
