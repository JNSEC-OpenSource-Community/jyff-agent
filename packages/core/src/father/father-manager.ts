import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { CtfFatherAgent } from "@ctf-agent/agents"
import { DockerSandbox, type DockerWorkspaceMount } from "@ctf-agent/sandbox"
import type {
  AgentHarnessEvent,
  AgentOptions,
  Skill,
} from "@earendil-works/pi-agent-core"
import type {
  AgentStreamEvent,
  AgentStreamListener,
  AgentStreamPayload,
} from "../project/agent-stream.ts"

export type FatherSessionStatus =
  | "draft"
  | "running"
  | "stopped"
  | "completed"
  | "failed"
  | "archived"

export interface FatherSessionRecord {
  id: string
  title: string
  pluginId: string
  status: FatherSessionStatus
  parentSessionId?: string
  modelId: string
  skillRevision: string
  createdBy: string
  createdAt: string
  updatedAt: string
  completedAt?: string
  error?: string
}

export interface CreateFatherSessionInput {
  title: string
  pluginId: string
  createdBy: string
  parentSessionId?: string
}

export interface FatherSessionManagerOptions {
  root: string
  image: string
  createAgentOptions(): AgentOptions
  skills?: readonly Skill[]
  skillRevision?: string
  workspaceMount?: (sessionId: string) => DockerWorkspaceMount
  sandboxFactory?: typeof DockerSandbox.create
}

interface FatherSubscription {
  sessionId: string
  listener: AgentStreamListener
}

/** 持久化多 Session，并保证同一进程最多运行一个 Father sandbox。 */
export class FatherSessionManager {
  private readonly records = new Map<string, FatherSessionRecord>()
  private readonly subscriptions = new Set<FatherSubscription>()
  private readonly sequences = new Map<string, number>()
  private readonly activeMessageIds = new Map<string, string>()
  private active?: { record: FatherSessionRecord; agent: CtfFatherAgent }
  private transition: Promise<void> = Promise.resolve()

  private constructor(private readonly options: FatherSessionManagerOptions) {}

  static async open(
    options: FatherSessionManagerOptions,
  ): Promise<FatherSessionManager> {
    const manager = new FatherSessionManager(options)
    await mkdir(manager.sessionsRoot(), { recursive: true })
    try {
      const parsed = JSON.parse(await readFile(manager.indexPath(), "utf8"))
      if (Array.isArray(parsed)) {
        for (const value of parsed) {
          const record = parseRecord(value)
          if (!record) continue
          manager.records.set(record.id, {
            ...record,
            status: record.status === "running" ? "stopped" : record.status,
          })
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    await manager.persist()
    return manager
  }

  list(): FatherSessionRecord[] {
    return [...this.records.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((record) => ({ ...record }))
  }

  get(id: string): FatherSessionRecord | undefined {
    const record = this.records.get(id)
    return record ? { ...record } : undefined
  }

  sessionPath(id: string): string {
    this.requireRecord(id)
    return join(this.sessionDirectory(id), "session.jsonl")
  }

  workspace(id: string): string {
    this.requireRecord(id)
    return join(this.sessionDirectory(id), "workspace")
  }

  async create(input: CreateFatherSessionInput): Promise<FatherSessionRecord> {
    const now = new Date().toISOString()
    const id = `father-${randomUUID()}`
    if (input.parentSessionId) this.requireRecord(input.parentSessionId)
    const agent = this.options.createAgentOptions()
    const model = agent.initialState?.model
    if (!model) throw new Error("Clanker Father 缺少可用模型")
    const record: FatherSessionRecord = {
      id,
      title: requiredText(input.title, "Session 名称", 160),
      pluginId: pluginId(input.pluginId),
      status: "draft",
      ...(input.parentSessionId
        ? { parentSessionId: input.parentSessionId }
        : {}),
      modelId: `${model.provider}/${model.id}`,
      skillRevision: this.options.skillRevision ?? "builtin",
      createdBy: requiredText(input.createdBy, "创建者", 160),
      createdAt: now,
      updatedAt: now,
    }
    const workspace = this.workspaceUnchecked(id)
    await Promise.all(
      ["sources", "research", "plugin", "fixtures", "output"].map((name) =>
        mkdir(join(workspace, name), { recursive: true }),
      ),
    )
    this.records.set(id, record)
    await this.persist()
    return { ...record }
  }

  async send(id: string, message: string): Promise<FatherSessionRecord> {
    const text = requiredText(message, "消息", 32_000)
    await this.exclusive(async () => {
      const active = await this.ensureActive(id)
      active.agent.queueUserMessage(text)
    })
    return this.get(id) as FatherSessionRecord
  }

  async stop(id: string): Promise<FatherSessionRecord> {
    await this.exclusive(async () => {
      const record = this.requireRecord(id)
      if (this.active?.record.id === id) {
        await this.active.agent.close()
        this.active = undefined
      }
      if (record.status === "running") {
        record.status = "stopped"
        record.updatedAt = new Date().toISOString()
        await this.persist()
      }
    })
    return this.get(id) as FatherSessionRecord
  }

  async complete(id: string): Promise<FatherSessionRecord> {
    await this.stop(id)
    const record = this.requireRecord(id)
    record.status = "completed"
    record.completedAt = new Date().toISOString()
    record.updatedAt = record.completedAt
    await this.persist()
    return { ...record }
  }

  subscribe(id: string, listener: AgentStreamListener): () => void {
    this.requireRecord(id)
    const subscription = { sessionId: id, listener }
    this.subscriptions.add(subscription)
    return () => this.subscriptions.delete(subscription)
  }

  async close(): Promise<void> {
    await this.exclusive(async () => {
      if (!this.active) return
      await this.active.agent.close()
      this.active.record.status = "stopped"
      this.active.record.updatedAt = new Date().toISOString()
      this.active = undefined
      await this.persist()
    })
  }

  private async ensureActive(id: string) {
    if (this.active?.record.id === id) return this.active
    if (this.active) {
      await this.active.agent.close()
      this.active.record.status = "stopped"
      this.active.record.updatedAt = new Date().toISOString()
      this.active = undefined
    }
    const record = this.requireRecord(id)
    if (["completed", "archived"].includes(record.status)) {
      throw new Error("已完成或归档的 Father Session 只读")
    }
    const workspace = this.workspace(id)
    const sandbox = await (this.options.sandboxFactory ?? DockerSandbox.create)(
      {
        projectId: "father",
        runId: id.slice("father-".length),
        image: this.options.image,
        workspace,
        ...(this.options.workspaceMount
          ? { workspaceMount: this.options.workspaceMount(id) }
          : {}),
        privileged: false,
        networkMode: "bridge",
        resources: {
          cpus: 2,
          memoryBytes: 4 * 1024 * 1024 * 1024,
          memorySwapBytes: 4 * 1024 * 1024 * 1024,
          pidsLimit: 512,
          storageBytes: 20 * 1024 * 1024 * 1024,
        },
      },
    )
    try {
      const agent = await CtfFatherAgent.create({
        sessionId: id,
        sessionDirectory: this.sessionDirectory(id),
        sandbox,
        agent: this.options.createAgentOptions(),
        skills: this.options.skills,
      })
      agent.subscribe((event) => this.publish(id, event))
      record.status = "running"
      record.error = undefined
      record.updatedAt = new Date().toISOString()
      this.active = { record, agent }
      await this.persist()
      return this.active
    } catch (error) {
      await sandbox.close().catch(() => undefined)
      record.status = "failed"
      record.error = errorText(error)
      record.updatedAt = new Date().toISOString()
      await this.persist()
      throw error
    }
  }

  private publish(sessionId: string, event: AgentHarnessEvent): void {
    const messageId = (): string => {
      const current = this.activeMessageIds.get(sessionId)
      if (current) return current
      const next = `${sessionId}:${(this.sequences.get(sessionId) ?? 0) + 1}`
      this.activeMessageIds.set(sessionId, next)
      return next
    }
    let payload: AgentStreamPayload | undefined
    if (event.type === "agent_start") payload = { type: "agent_started" }
    else if (event.type === "agent_end") payload = { type: "agent_finished" }
    else if (event.type === "message_start") {
      payload = {
        type: "message_started",
        messageId: messageId(),
        message: event.message,
      }
    } else if (event.type === "message_update") {
      const update = event.assistantMessageEvent
      if (update.type === "text_delta") {
        payload = {
          type: "text_delta",
          messageId: messageId(),
          contentIndex: update.contentIndex,
          delta: update.delta,
        }
      } else if (update.type === "thinking_delta") {
        payload = {
          type: "thinking_delta",
          messageId: messageId(),
          contentIndex: update.contentIndex,
          delta: update.delta,
        }
      } else if (update.type === "toolcall_end") {
        payload = {
          type: "message_updated",
          messageId: messageId(),
          message: event.message,
        }
      }
    } else if (event.type === "message_end") {
      payload = {
        type: "message_completed",
        messageId: messageId(),
        message: event.message,
      }
      this.activeMessageIds.delete(sessionId)
    } else if (event.type === "tool_execution_start") {
      payload = {
        type: "tool_started",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: bounded(event.args),
      }
    } else if (event.type === "tool_execution_update") {
      payload = {
        type: "tool_updated",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        partialResult: bounded(event.partialResult),
      }
    } else if (event.type === "tool_execution_end") {
      payload = {
        type: "tool_completed",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        result: bounded(event.result),
        isError: event.isError,
      }
    } else if (event.type === "queue_update") {
      payload = {
        type: "queue_updated",
        queued:
          event.steer.length + event.followUp.length + event.nextTurn.length,
      }
    } else if (event.type === "session_before_compact") {
      payload = { type: "status_changed", status: "compacting" }
    } else if (event.type === "session_compact") {
      payload = { type: "status_changed", status: "active" }
    }
    if (!payload) return
    const seq = (this.sequences.get(sessionId) ?? 0) + 1
    this.sequences.set(sessionId, seq)
    const envelope = {
      ...payload,
      runId: sessionId,
      seq,
      createdAt: new Date().toISOString(),
    } as AgentStreamEvent
    for (const subscription of this.subscriptions) {
      if (subscription.sessionId !== sessionId) continue
      try {
        subscription.listener(envelope)
      } catch {
        // WebUI 投影不能影响 Father 生命周期。
      }
    }
  }

  private requireRecord(id: string): FatherSessionRecord {
    const record = this.records.get(id)
    if (!record) throw new Error(`Father Session 不存在: ${id}`)
    return record
  }

  private sessionsRoot(): string {
    return join(this.options.root, ".ctf-agent", "father", "sessions")
  }

  private sessionDirectory(id: string): string {
    return join(this.sessionsRoot(), id)
  }

  private workspaceUnchecked(id: string): string {
    return join(this.sessionDirectory(id), "workspace")
  }

  private indexPath(): string {
    return join(this.options.root, ".ctf-agent", "father", "sessions.json")
  }

  private async persist(): Promise<void> {
    const target = this.indexPath()
    const temporary = `${target}.tmp-${process.pid}`
    await mkdir(join(this.options.root, ".ctf-agent", "father"), {
      recursive: true,
    })
    await writeFile(temporary, JSON.stringify(this.list(), null, 2))
    await rename(temporary, target)
  }

  private async exclusive(operation: () => Promise<void>): Promise<void> {
    const next = this.transition.then(operation, operation)
    this.transition = next.catch(() => undefined)
    return next
  }
}

function parseRecord(value: unknown): FatherSessionRecord | undefined {
  if (!value || typeof value !== "object") return undefined
  const record = value as Partial<FatherSessionRecord>
  if (
    typeof record.id !== "string" ||
    typeof record.title !== "string" ||
    typeof record.pluginId !== "string" ||
    typeof record.status !== "string" ||
    typeof record.modelId !== "string" ||
    typeof record.skillRevision !== "string" ||
    typeof record.createdBy !== "string" ||
    typeof record.createdAt !== "string" ||
    typeof record.updatedAt !== "string"
  ) {
    return undefined
  }
  return record as FatherSessionRecord
}

function requiredText(value: string, label: string, maximum: number): string {
  const normalized = value.trim()
  if (!normalized) throw new Error(`${label}不能为空`)
  if (normalized.length > maximum) throw new Error(`${label}过长`)
  return normalized
}

function pluginId(value: string): string {
  const normalized = value.trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(normalized)) {
    throw new Error("插件 ID 必须为 3-64 位小写字母、数字或连字符")
  }
  return normalized
}

function bounded(value: unknown): unknown {
  try {
    const text = JSON.stringify(value)
    return text.length <= 8_000 ? value : `${text.slice(0, 8_000)}…`
  } catch {
    return String(value).slice(0, 8_000)
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
