import { mkdir, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { AgentOptions } from "@earendil-works/pi-agent-core"
import { findProjectRoot, loadProjectConfig, type ProjectConfig } from "./config.ts"
import { DockerSandbox, newRunId, type DockerSandboxOptions, type Sandbox } from "../sandbox/docker-sandbox.ts"
import { CtfSolverAgent, type SolverCloseDetails } from "../agent/solver-agent.ts"
import { discoverProjectSkills, materializeSkills, type AgentSkill } from "../skills/project-skills.ts"
import type { CompactionOptions } from "../agent/compaction.ts"
import type { Announcement, ChallengeSummary, ContestOverview, PlatformPlugin, PlatformProject, RemoteEnvironment } from "../platform/types.ts"
import { RunStore, type RunEvent, type RunFilter, type RunRecord, type RunStatus } from "./run-store.ts"

export interface OpenProjectOptions {
  root?: string
  platforms: readonly PlatformPlugin[]
  sandboxFactory?: (options: DockerSandboxOptions) => Promise<Sandbox>
  /** 在 .pi/skills 与 .agents/skills 外额外发现的 skill 目录。 */
  skillPaths?: readonly string[]
}

export interface CreateSolverOptions {
  agent: AgentOptions
  compaction?: false | CompactionOptions
  /** Runner 的第几次尝试；直接调用时由 RunStore 自动递增。 */
  attempt?: number
}

/**
 * Project 是比赛的基本单元：它拥有完整平台 API 与持久化；Solver 永远只获得单题 capability。
 */
export class Project {
  readonly root: string
  readonly config: ProjectConfig
  private readonly solvers = new Set<CtfSolverAgent>()
  private closed = false
  private constructor(
    root: string,
    config: ProjectConfig,
    private readonly platform: PlatformProject,
    private readonly sandboxFactory: (options: DockerSandboxOptions) => Promise<Sandbox>,
    private readonly skills: readonly AgentSkill[],
    private readonly runStore: RunStore,
  ) {
    this.root = root
    this.config = config
  }

  static async open(options: OpenProjectOptions): Promise<Project> {
    const root = await findProjectRoot(options.root)
    const config = await loadProjectConfig(root)
    const plugin = options.platforms.find((candidate) => candidate.id === config.contest.platform)
    if (!plugin) throw new Error(`未注册平台插件: ${config.contest.platform}`)
    const platform = await plugin.connect({ eventId: config.contest.eventId, config: config.platform.config })
    let runStore: RunStore | undefined
    try {
      const skills = await discoverProjectSkills(root, options.skillPaths)
      const agentDirectory = join(root, ".ctf-agent")
      await mkdir(agentDirectory, { recursive: true })
      runStore = await RunStore.open(join(agentDirectory, "runs.sqlite"))
      // Project.open 只可能发生在新进程/新控制面中；遗留活跃记录不可继续信任。
      runStore.markInterruptedRuns()
      return new Project(root, config, platform, options.sandboxFactory ?? DockerSandbox.create, skills, runStore)
    } catch (error) {
      runStore?.close()
      await platform.close().catch(() => undefined)
      throw error
    }
  }

  get agentDirectory(): string {
    return join(this.root, ".ctf-agent")
  }

  async refresh(): Promise<ContestOverview> { return this.platform.refresh() }
  async overview(): Promise<ContestOverview> { return this.platform.getOverview() }
  async challenges(): Promise<ChallengeSummary[]> { return this.platform.listChallenges() }
  async announcements(): Promise<Announcement[]> { return this.platform.listAnnouncements() }
  availableSkills(): readonly AgentSkill[] { return this.skills }
  async environments(): Promise<RemoteEnvironment[]> { return this.platform.listRemoteEnvironments() }
  async destroyEnvironment(id: string): Promise<void> { await this.platform.destroyRemoteEnvironment(id) }
  runs(filter: RunFilter = {}): RunRecord[] { return this.runStore.listRuns(filter) }
  runEvents(runId: string): RunEvent[] { return this.runStore.events(runId) }
  isChallengeSolved(challengeId: string): boolean { return this.runStore.isSolved(challengeId) }
  nextAttempt(challengeId: string): number { return this.runStore.nextAttempt(challengeId) }

  async createSolver(challengeId: string, options: CreateSolverOptions): Promise<CtfSolverAgent> {
    if (this.closed) throw new Error("Project 已关闭")
    const runId = newRunId()
    const runDirectory = join(this.agentDirectory, "runs", runId)
    const workspace = join(runDirectory, "workspace")
    // 仅此处在宿主机创建持久化 bind mount；Solver 的文件与系统操作都进入容器。
    await mkdir(workspace, { recursive: true })
    const record = this.runStore.createRun({
      id: runId,
      challengeId,
      workspace,
      attempt: options.attempt ?? this.runStore.nextAttempt(challengeId),
    })
    await this.persistRecord(record, runDirectory)

    let capability: Awaited<ReturnType<PlatformProject["bindChallenge"]>> | undefined
    let sandbox: Sandbox | undefined
    try {
      capability = await this.platform.bindChallenge(challengeId)
      const challenge = await capability.getInfo()
      // skills 的脚本/参考资料必须在容器内可见，不能把宿主机路径注入给 Agent。
      const skills = await materializeSkills(this.skills, workspace)
      sandbox = await this.sandboxFactory({
        projectId: this.config.project.id,
        runId,
        image: this.config.sandbox.image,
        workspace,
        privileged: this.config.sandbox.privileged,
        networkMode: this.config.sandbox.networkMode,
      })

      let solver!: CtfSolverAgent
      solver = await CtfSolverAgent.create({
        identity: { projectId: this.config.project.id, runId, workspace, challenge },
        capability,
        sandbox,
        agent: options.agent,
        features: { skills, compaction: options.compaction },
        onClosed: async (details) => {
          this.solvers.delete(solver)
          const updated = this.runStore.updateRun(runId, {
            status: runStatus(details),
            closeReason: details.reason,
            error: details.error ?? null,
            cleanupError: details.cleanupErrors.length > 0 ? details.cleanupErrors.join("\n") : null,
            finishedAt: new Date().toISOString(),
          }, "run_finished", details)
          await this.persistRecord(updated, runDirectory)
        },
      })
      const running = this.runStore.updateRun(runId, {
        status: "running",
        startedAt: new Date().toISOString(),
      }, "run_started")
      await this.persistRecord(running, runDirectory)
      this.solvers.add(solver)
      return solver
    } catch (error) {
      const cleanupErrors: string[] = []
      if (capability?.instance) {
        try {
          await capability.instance.destroy()
        } catch (cleanupError) {
          cleanupErrors.push(`远程实例销毁失败: ${errorText(cleanupError)}`)
        }
      }
      if (sandbox) {
        try {
          await sandbox.close()
        } catch (cleanupError) {
          cleanupErrors.push(`Sandbox 关闭失败: ${errorText(cleanupError)}`)
        }
      }
      const updated = this.runStore.updateRun(runId, {
        status: "failed",
        closeReason: "failed",
        error: errorText(error),
        cleanupError: cleanupErrors.length > 0 ? cleanupErrors.join("\n") : null,
        finishedAt: new Date().toISOString(),
      }, "run_creation_failed", { error: errorText(error), cleanupErrors })
      await this.persistRecord(updated, runDirectory)
      if (cleanupErrors.length > 0) {
        throw new AggregateError([error, ...cleanupErrors.map((message) => new Error(message))], `无法创建 Solver ${runId}`)
      }
      throw error
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const errors: unknown[] = []
    const solverResults = await Promise.allSettled([...this.solvers].map((solver) => solver.close("manual")))
    for (const result of solverResults) if (result.status === "rejected") errors.push(result.reason)
    try {
      await this.platform.close()
    } catch (error) {
      errors.push(error)
    }
    try {
      this.runStore.close()
    } catch (error) {
      errors.push(error)
    }
    if (errors.length > 0) throw new AggregateError(errors, "Project 关闭时发生错误")
  }

  private async persistRecord(record: RunRecord, runDirectory: string): Promise<void> {
    const target = join(runDirectory, "run.json")
    const temporary = `${target}.tmp-${process.pid}`
    await writeFile(temporary, JSON.stringify(record, null, 2))
    await rename(temporary, target)
  }
}

function runStatus(details: SolverCloseDetails): RunStatus {
  switch (details.reason) {
    case "submitted": return "solved"
    case "failed": return "failed"
    case "timed_out": return "timed_out"
    case "cancelled": return "cancelled"
    case "manual": return "closed"
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
