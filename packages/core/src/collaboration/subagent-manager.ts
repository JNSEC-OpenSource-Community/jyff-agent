import { randomUUID } from "node:crypto"
import { join } from "node:path"
import {
  type AgentSkill,
  availableSubagentRoles,
  type ChallengeInfo,
  type CtfSolverAgent,
  CtfSubagent,
  resolveSubagentRole,
  type Sandbox,
  type SubagentRole,
} from "@ctf-agent/agents"
import { subagentCompletionNotificationPrompt } from "@ctf-agent/prompts"
import { DockerExecutionEnv } from "@ctf-agent/sandbox"
import type {
  AgentHarnessEvent,
  AgentOptions,
  AgentTool,
  AgentToolResult,
} from "@earendil-works/pi-agent-core"
import { Type } from "typebox"
import { extractAssistantText } from "../agent/thinking.ts"

export type SubagentStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "aborted"
  | "interrupted"

export interface SubagentRecord {
  id: string
  runId: string
  role: string
  displayName: string
  description: string
  status: SubagentStatus
  background: boolean
  prompt: string
  sessionPath: string
  containerCwd: string
  result?: string
  error?: string
  activeTool?: string
  turns: number
  toolUses: number
  totalTokens: number
  inputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  createdAt: string
  updatedAt: string
  startedAt?: string
  completedAt?: string
}

export type SubagentLifecycleEvent =
  | "created"
  | "started"
  | "progress"
  | "completed"
  | "failed"
  | "cancelled"
  | "aborted"
  | "steered"

export interface SubagentManagerOptions {
  projectId: string
  runId: string
  runDirectory: string
  challenge: ChallengeInfo
  sandbox: Sandbox
  agent: AgentOptions
  roles: ReadonlyMap<string, SubagentRole>
  skills?: readonly AgentSkill[]
  maxConcurrent?: number
  onRecord?: (
    record: SubagentRecord,
    event: SubagentLifecycleEvent,
  ) => Promise<void> | void
  /** 将 Pi 的细粒度运行事件转发给控制面，不参与 Agent 生命周期结算。 */
  onAgentEvent?: (record: SubagentRecord, event: AgentHarnessEvent) => void
}

interface ManagedSubagent {
  record: SubagentRecord
  role: SubagentRole
  agent?: CtfSubagent
  promise: Promise<SubagentRecord>
  resolve: (record: SubagentRecord) => void
  resultConsumed: boolean
  hardAborted: boolean
}

interface QueuedRun {
  managed: ManagedSubagent
  prompt: string
}

const TERMINAL = new Set<SubagentStatus>([
  "completed",
  "failed",
  "cancelled",
  "aborted",
  "interrupted",
])

/** Per-run worker fleet adapted from pi-subagents' manager/runner split. */
export class CtfSubagentManager {
  private readonly records = new Map<string, ManagedSubagent>()
  private readonly queue: QueuedRun[] = []
  private readonly maxConcurrent: number
  private runningBackground = 0
  private parent?: CtfSolverAgent
  private finalizing = false
  private closing = false

  constructor(private readonly options: SubagentManagerOptions) {
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? 4)
  }

  attachParent(parent: CtfSolverAgent): void {
    this.parent = parent
  }

  availableRoles(): SubagentRole[] {
    return availableSubagentRoles(this.options.roles)
  }

  /** Reattach persisted terminal workers so their JSONL sessions can be resumed. */
  restore(records: readonly SubagentRecord[]): void {
    for (const record of records) {
      if (record.runId !== this.options.runId || this.records.has(record.id))
        continue
      if (!TERMINAL.has(record.status)) continue
      const role = resolveSubagentRole(this.options.roles, record.role)
      if (!role) continue
      let resolve!: (value: SubagentRecord) => void
      const promise = new Promise<SubagentRecord>((done) => {
        resolve = done
      })
      this.records.set(record.id, {
        record: snapshot(record),
        role,
        promise,
        resolve,
        resultConsumed: false,
        hardAborted: false,
      })
    }
  }

  spawn(input: {
    role: string
    prompt: string
    description: string
    background: boolean
  }): SubagentRecord {
    if (this.closing || this.finalizing) {
      throw new Error("SubAgent manager 正在收尾或关闭")
    }
    const role = resolveSubagentRole(this.options.roles, input.role)
    if (!role) {
      throw new Error(
        `未知或已禁用的 SubAgent 类型: ${input.role}; 可用类型: ${this.availableRoles()
          .map((item) => item.name)
          .join(", ")}`,
      )
    }
    const prompt = boundedText(input.prompt, "prompt", 32_000)
    const description = boundedText(input.description, "description", 240)
    const id = randomUUID()
    const now = new Date().toISOString()
    const record: SubagentRecord = {
      id,
      runId: this.options.runId,
      role: role.name,
      displayName: role.displayName,
      description,
      status: input.background ? "queued" : "running",
      background: input.background,
      prompt,
      sessionPath: join(
        this.options.runDirectory,
        "subagents",
        id,
        "session.jsonl",
      ),
      containerCwd: `/workspace/subagents/${id}`,
      turns: 0,
      toolUses: 0,
      totalTokens: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      createdAt: now,
      updatedAt: now,
    }
    let resolve!: (value: SubagentRecord) => void
    const promise = new Promise<SubagentRecord>((done) => {
      resolve = done
    })
    const managed: ManagedSubagent = {
      record,
      role,
      promise,
      resolve,
      resultConsumed: false,
      hardAborted: false,
    }
    this.records.set(id, managed)
    this.emit(managed, "created")
    if (input.background && this.runningBackground >= this.maxConcurrent) {
      this.queue.push({ managed, prompt })
    } else {
      this.launch(managed, prompt, true)
    }
    return snapshot(record)
  }

  async resume(
    id: string,
    prompt: string,
    background: boolean,
  ): Promise<SubagentRecord> {
    if (this.closing || this.finalizing) {
      throw new Error("SubAgent manager 正在收尾或关闭")
    }
    return this.restart(id, prompt, background)
  }

  private async restart(
    id: string,
    prompt: string,
    background: boolean,
    bypassQueue = false,
  ): Promise<SubagentRecord> {
    const managed = this.records.get(id)
    if (!managed || !TERMINAL.has(managed.record.status)) {
      throw new Error(`SubAgent ${id} 不存在、尚未完成或会话不可恢复`)
    }
    const nextPrompt = boundedText(prompt, "prompt", 32_000)
    managed.record.background = background
    managed.record.status = background ? "queued" : "running"
    managed.record.prompt = nextPrompt
    managed.record.result = undefined
    managed.record.error = undefined
    managed.record.completedAt = undefined
    managed.record.updatedAt = new Date().toISOString()
    managed.resultConsumed = false
    managed.hardAborted = false
    let resolve!: (value: SubagentRecord) => void
    managed.promise = new Promise<SubagentRecord>((done) => {
      resolve = done
    })
    managed.resolve = resolve
    this.emit(managed, "created")
    if (
      !bypassQueue &&
      background &&
      this.runningBackground >= this.maxConcurrent
    ) {
      this.queue.push({ managed, prompt: nextPrompt })
    } else {
      this.launch(managed, nextPrompt, !managed.agent)
    }
    return background ? snapshot(managed.record) : await managed.promise
  }

  get(id: string): SubagentRecord | undefined {
    const managed = this.records.get(id)
    return managed ? snapshot(managed.record) : undefined
  }

  list(): SubagentRecord[] {
    return [...this.records.values()]
      .map(({ record }) => snapshot(record))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  }

  async wait(id: string, signal?: AbortSignal): Promise<SubagentRecord> {
    const managed = this.records.get(id)
    if (!managed) throw new Error(`SubAgent 不存在: ${id}`)
    const result = TERMINAL.has(managed.record.status)
      ? managed.record
      : await abortable(managed.promise, signal)
    managed.resultConsumed = true
    return snapshot(result)
  }

  async waitForTool(
    id: string,
    signal?: AbortSignal,
    interruptOnSteer = true,
  ): Promise<{ record: SubagentRecord; waitInterrupted: boolean }> {
    const current = this.records.get(id)
    if (!current) throw new Error(`SubAgent 不存在: ${id}`)
    if (!interruptOnSteer || TERMINAL.has(current.record.status)) {
      return { record: await this.wait(id, signal), waitInterrupted: false }
    }
    const parent = this.parent
    if (!parent) {
      return { record: await this.wait(id, signal), waitInterrupted: false }
    }

    const completed = new AbortController()
    const combined = signal
      ? AbortSignal.any([signal, completed.signal])
      : completed.signal
    try {
      return await Promise.race([
        this.wait(id, combined).then((record) => ({
          record,
          waitInterrupted: false,
        })),
        waitForParentSteer(parent, combined).then(() => ({
          record: snapshot(current.record),
          waitInterrupted: true,
        })),
      ])
    } finally {
      completed.abort()
    }
  }

  async steer(id: string, message: string): Promise<SubagentRecord> {
    const managed = this.records.get(id)
    if (!managed) {
      throw new Error(`SubAgent ${id} 当前不可接收 steer`)
    }
    const nextMessage = boundedText(message, "message", 4_000)
    if (TERMINAL.has(managed.record.status)) {
      // finished worker 的内存 Agent 可能已释放；强制从原 JSONL session
      // 重新打开，保证 steer 延续同一 worker，而不是创建新会话。
      await managed.agent?.waitForIdle()
      managed.agent = undefined
      return this.resume(id, nextMessage, true)
    }
    if (!managed.agent || managed.record.status !== "running") {
      throw new Error(`SubAgent ${id} 当前不可接收 steer`)
    }
    await managed.agent.steer(nextMessage)
    managed.record.updatedAt = new Date().toISOString()
    this.emit(managed, "steered")
    return snapshot(managed.record)
  }

  async cancel(id: string): Promise<SubagentRecord> {
    const managed = this.records.get(id)
    if (!managed || TERMINAL.has(managed.record.status)) {
      throw new Error(`SubAgent ${id} 不存在或已经结束`)
    }
    if (managed.record.status === "queued") {
      const index = this.queue.findIndex((item) => item.managed === managed)
      if (index >= 0) this.queue.splice(index, 1)
    } else {
      await managed.agent?.abort()
    }
    this.finish(managed, "cancelled")
    return snapshot(managed.record)
  }

  /**
   * blocking 收尾屏障：先停止未启动任务，再中止当前 turn，并从同一 JSONL
   * session 启动一个明确的最终报告 turn。
   * 超时 worker 会先抓取最新回复再中止，返回时所有子任务都已进入终态。
   */
  async finalize(
    reportPrompt: string,
    graceMs: number,
  ): Promise<SubagentRecord[]> {
    if (!Number.isFinite(graceMs) || graceMs < 0) {
      throw new Error("SubAgent finalization graceMs must be non-negative")
    }
    this.finalizing = true
    const queued = this.list().filter((record) => record.status === "queued")
    await Promise.allSettled(queued.map((record) => this.cancel(record.id)))

    const running = this.list().filter((record) => record.status === "running")
    await Promise.allSettled(
      running.map(async (record) => {
        const managed = this.records.get(record.id)
        if (managed) await this.captureLatestResult(managed)
        await this.cancel(record.id)
        await managed?.agent?.waitForIdle()
      }),
    )
    await Promise.allSettled(
      running.map((record) =>
        this.restart(record.id, reportPrompt, true, true),
      ),
    )
    if (running.length > 0 && graceMs > 0) {
      await settleWithin(
        running.map((record) => this.wait(record.id)),
        graceMs,
      )
    }

    const unfinished = this.list().filter(
      (record) => record.status === "running" || record.status === "queued",
    )
    await Promise.allSettled(
      unfinished.map(async (record) => {
        const managed = this.records.get(record.id)
        if (managed) await this.captureLatestResult(managed)
        await this.cancel(record.id)
      }),
    )
    await Promise.allSettled(
      unfinished.map((record) =>
        this.records.get(record.id)?.agent?.waitForIdle(),
      ),
    )
    return this.list()
  }

  async close(): Promise<void> {
    if (this.closing) return
    this.closing = true
    const pending = this.list().filter((record) => !TERMINAL.has(record.status))
    await Promise.allSettled(pending.map((record) => this.cancel(record.id)))
    await Promise.allSettled(
      [...this.records.values()].map(({ agent }) => agent?.waitForIdle()),
    )
  }

  /** Reserve a background slot synchronously, before any async session setup. */
  private launch(
    managed: ManagedSubagent,
    prompt: string,
    initialize: boolean,
  ): void {
    const background = managed.record.background
    if (background) this.runningBackground++
    void this.executeLaunch(managed, prompt, initialize).finally(() => {
      if (background) {
        this.runningBackground = Math.max(0, this.runningBackground - 1)
      }
      this.drainQueue()
    })
  }

  private async executeLaunch(
    managed: ManagedSubagent,
    prompt: string,
    initialize: boolean,
  ): Promise<void> {
    try {
      if (initialize) {
        const env = new DockerExecutionEnv(this.options.sandbox)
        const created = await env.createDir(managed.record.containerCwd, {
          recursive: true,
        })
        if (!created.ok) throw created.error
        managed.agent = await CtfSubagent.create({
          projectId: this.options.projectId,
          runId: this.options.runId,
          runDirectory: this.options.runDirectory,
          subagentId: managed.record.id,
          containerCwd: managed.record.containerCwd,
          challenge: this.options.challenge,
          sandbox: this.options.sandbox,
          agent: this.options.agent,
          role: managed.role,
          skills: this.options.skills,
        })
        this.subscribe(managed, managed.agent)
      }
      if (TERMINAL.has(managed.record.status)) return
      await this.run(managed, prompt)
    } catch (error) {
      if (!isCancelled(managed)) {
        await this.captureLatestResult(managed).catch(() => undefined)
        managed.record.error = errorText(error)
        this.finish(managed, managed.hardAborted ? "aborted" : "failed")
      }
    }
  }

  private async run(managed: ManagedSubagent, prompt: string): Promise<void> {
    managed.record.status = "running"
    managed.record.startedAt = new Date().toISOString()
    managed.record.updatedAt = managed.record.startedAt
    this.emit(managed, "started")
    await managed.agent?.prompt(prompt)
    if (isCancelled(managed)) return
    await this.captureLatestResult(managed)
    this.finish(managed, managed.hardAborted ? "aborted" : "completed")
  }

  private async captureLatestResult(managed: ManagedSubagent): Promise<void> {
    const messages = (await managed.agent?.transcript()) ?? []
    for (let index = messages.length - 1; index >= 0; index--) {
      const text = extractAssistantText(messages[index])
      if (text) {
        managed.record.result = text
        return
      }
    }
  }

  private subscribe(managed: ManagedSubagent, agent: CtfSubagent): void {
    agent.subscribe((event) => {
      try {
        this.options.onAgentEvent?.(snapshot(managed.record), event)
      } catch {
        // 实时 UI 是旁路能力，不能因订阅者异常打断 SubAgent。
      }
      this.captureProgress(managed, event)
    })
  }

  private captureProgress(
    managed: ManagedSubagent,
    event: AgentHarnessEvent,
  ): void {
    let changed = false
    if (event.type === "turn_end") {
      managed.record.turns++
      changed = true
    }
    if (event.type === "tool_execution_start") {
      managed.record.activeTool = event.toolName
      changed = true
    }
    if (event.type === "tool_execution_end") {
      managed.record.toolUses++
      managed.record.activeTool = undefined
      changed = true
    }
    if (
      event.type === "message_end" &&
      event.message.role === "assistant" &&
      event.message.usage
    ) {
      managed.record.totalTokens += event.message.usage.totalTokens
      managed.record.inputTokens =
        (managed.record.inputTokens ?? 0) + event.message.usage.input
      managed.record.cacheReadTokens =
        (managed.record.cacheReadTokens ?? 0) + event.message.usage.cacheRead
      managed.record.cacheWriteTokens =
        (managed.record.cacheWriteTokens ?? 0) + event.message.usage.cacheWrite
      changed = true
    }
    if (!changed) return
    managed.record.updatedAt = new Date().toISOString()
    this.emit(managed, "progress")
  }

  private finish(managed: ManagedSubagent, status: SubagentStatus): void {
    if (TERMINAL.has(managed.record.status)) return
    managed.record.status = status
    managed.record.activeTool = undefined
    managed.record.completedAt = new Date().toISOString()
    managed.record.updatedAt = managed.record.completedAt
    const event: SubagentLifecycleEvent =
      status === "completed"
        ? "completed"
        : status === "cancelled"
          ? "cancelled"
          : status === "aborted"
            ? "aborted"
            : "failed"
    this.emit(managed, event)
    managed.resolve(snapshot(managed.record))
    if (managed.record.background && !managed.resultConsumed) {
      void this.notifyParent(managed.record).catch(() => undefined)
    }
  }

  private drainQueue(): void {
    while (
      !this.closing &&
      !this.finalizing &&
      this.queue.length > 0 &&
      this.runningBackground < this.maxConcurrent
    ) {
      const next = this.queue.shift()
      if (next?.managed.record.status !== "queued") continue
      this.launch(next.managed, next.prompt, true)
    }
  }

  private emit(managed: ManagedSubagent, event: SubagentLifecycleEvent): void {
    void Promise.resolve(
      this.options.onRecord?.(snapshot(managed.record), event),
    ).catch(() => undefined)
  }

  private async notifyParent(record: SubagentRecord): Promise<void> {
    const parent = this.parent
    if (!parent || parent.isClosed) return
    const notification = {
      id: record.id,
      role: record.role,
      status: record.status,
      output: (record.result ?? record.error ?? "No output").slice(0, 16_000),
    }
    await parent.steer(subagentCompletionNotificationPrompt(notification))
  }
}

function settleWithin(promises: Promise<unknown>[], milliseconds: number) {
  return new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, milliseconds)
    void Promise.allSettled(promises).then(() => {
      clearTimeout(timeout)
      resolve()
    })
  })
}

/** Main-Agent tools use pi-subagents-compatible names and argument conventions. */
export function createSubagentManagerTools(
  manager: CtfSubagentManager,
): AgentTool[] {
  const types = manager
    .availableRoles()
    .map((role) => role.name)
    .join(", ")
  return [
    {
      name: "Agent",
      label: "Launch SubAgent",
      description: `Launch a specialized CTF SubAgent. Available types: ${types}.`,
      parameters: Type.Object({
        subagent_type: Type.String(),
        prompt: Type.String({ minLength: 1, maxLength: 32_000 }),
        description: Type.String({ minLength: 1, maxLength: 240 }),
        run_in_background: Type.Optional(Type.Boolean()),
        resume: Type.Optional(Type.String()),
      }),
      async execute(_id, raw, signal) {
        const params = raw as {
          subagent_type: string
          prompt: string
          description: string
          run_in_background?: boolean
          resume?: string
        }
        const background = params.run_in_background === true
        if (params.resume) {
          const record = await manager.resume(
            params.resume,
            params.prompt,
            background,
          )
          return toolResult(record)
        }
        const record = manager.spawn({
          role: params.subagent_type,
          prompt: params.prompt,
          description: params.description,
          background,
        })
        return toolResult(
          background ? record : await manager.wait(record.id, signal),
        )
      },
    },
    {
      name: "get_subagent_result",
      label: "Get SubAgent Result",
      description:
        "Read or wait for a background SubAgent result. Waiting stops when the parent receives a steer unless interrupt_on_steer is false; the worker keeps running.",
      parameters: Type.Object({
        agent_id: Type.String(),
        wait: Type.Optional(Type.Boolean()),
        interrupt_on_steer: Type.Optional(Type.Boolean()),
      }),
      async execute(_id, raw, signal) {
        const params = raw as {
          agent_id: string
          wait?: boolean
          interrupt_on_steer?: boolean
        }
        if (params.wait) {
          const waited = await manager.waitForTool(
            params.agent_id,
            signal,
            params.interrupt_on_steer !== false,
          )
          return toolResult({
            ...waited.record,
            waitInterrupted: waited.waitInterrupted,
            ...(waited.waitInterrupted
              ? { waitInterruptedReason: "parent_steer_queued" }
              : {}),
          })
        }
        const record = manager.get(params.agent_id)
        if (!record) throw new Error(`SubAgent 不存在: ${params.agent_id}`)
        return toolResult(record)
      },
    },
    {
      name: "steer_subagent",
      label: "Steer SubAgent",
      description:
        "Send new guidance to a running SubAgent, or resume a finished SubAgent from its persisted session.",
      parameters: Type.Object({
        agent_id: Type.String(),
        message: Type.String({ minLength: 1, maxLength: 4_000 }),
      }),
      async execute(_id, raw) {
        const params = raw as { agent_id: string; message: string }
        return toolResult(await manager.steer(params.agent_id, params.message))
      },
    },
    {
      name: "cancel_subagent",
      label: "Cancel SubAgent",
      description: "Cancel a queued or running SubAgent.",
      parameters: Type.Object({ agent_id: Type.String() }),
      async execute(_id, raw) {
        return toolResult(
          await manager.cancel((raw as { agent_id: string }).agent_id),
        )
      },
    },
    {
      name: "list_subagents",
      label: "List SubAgents",
      description: "List this run's queued, running and completed SubAgents.",
      parameters: Type.Object({}),
      async execute() {
        return toolResult({ agents: manager.list() })
      },
    },
  ]
}

function toolResult(details: object): AgentToolResult<Record<string, unknown>> {
  const value = details as Record<string, unknown>
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    details: value,
  }
}

function snapshot(record: SubagentRecord): SubagentRecord {
  return { ...record }
}

function boundedText(value: string, field: string, max: number): string {
  const text = value.trim()
  if (!text) throw new Error(`${field} 不能为空`)
  if (text.length > max) throw new Error(`${field} 长度不能超过 ${max}`)
  return text
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isCancelled(managed: ManagedSubagent): boolean {
  return managed.record.status === "cancelled"
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const cleanup = () => signal.removeEventListener("abort", onAbort)
    const onAbort = () => {
      if (settled) return
      settled = true
      cleanup()
      reject(signal.reason)
    }
    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(
      (value) => {
        if (settled) return
        settled = true
        cleanup()
        resolve(value)
      },
      (error: unknown) => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      },
    )
  })
}

function waitForParentSteer(
  parent: CtfSolverAgent,
  signal: AbortSignal,
): Promise<void> {
  if (parent.hasQueuedSteerMessages()) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    let settled = false
    let unsubscribe = () => {}
    const finish = (operation: () => void) => {
      if (settled) return
      settled = true
      signal.removeEventListener("abort", onAbort)
      unsubscribe()
      operation()
    }
    const onAbort = () => finish(() => reject(signal.reason))
    unsubscribe = parent.subscribe((event) => {
      if (event.type === "queue_update" && event.steer.length > 0) {
        finish(resolve)
      }
    })
    signal.addEventListener("abort", onAbort, { once: true })
    // 避免检查和订阅之间到达的 steer 被漏掉。
    if (parent.hasQueuedSteerMessages()) finish(resolve)
  })
}
