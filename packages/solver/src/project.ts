import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { AgentOptions } from "@earendil-works/pi-agent-core"
import { findProjectRoot, loadProjectConfig, type ProjectConfig } from "./config.ts"
import { DockerSandbox, newRunId, type DockerSandboxOptions, type Sandbox } from "./sandbox.ts"
import { CtfSolverAgent } from "./solver-agent.ts"
import { discoverProjectSkills, materializeSkills, type AgentSkill } from "./skills.ts"
import type { CompactionOptions } from "./compaction.ts"
import type { Announcement, ChallengeSummary, ContestOverview, PlatformPlugin, PlatformProject, RemoteEnvironment } from "./platform.ts"

interface RunRecord {
  id: string
  challengeId: string
  workspace: string
  status: "running" | "closed"
  closedReason?: "submitted" | "manual"
  createdAt: string
  closedAt?: string
}

interface ProjectState {
  version: 1
  runs: RunRecord[]
}

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
}

/**
 * Project 是比赛的基本单元：它拥有完整平台 API 与持久化；Solver 永远只获得单题 capability。
 */
export class Project {
  readonly root: string
  readonly config: ProjectConfig
  private state: ProjectState = { version: 1, runs: [] }
  private readonly solvers = new Set<CtfSolverAgent>()
  private constructor(
    root: string,
    config: ProjectConfig,
    private readonly platform: PlatformProject,
    private readonly sandboxFactory: (options: DockerSandboxOptions) => Promise<Sandbox>,
    private readonly skills: readonly AgentSkill[],
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
    const skills = await discoverProjectSkills(root, options.skillPaths)
    const project = new Project(root, config, platform, options.sandboxFactory ?? DockerSandbox.create, skills)
    await mkdir(project.agentDirectory, { recursive: true })
    await project.loadState()
    await project.saveState()
    return project
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

  async createSolver(challengeId: string, options: CreateSolverOptions): Promise<CtfSolverAgent> {
    const capability = await this.platform.bindChallenge(challengeId)
    const challenge = await capability.getInfo()
    const runId = newRunId()
    const runDirectory = join(this.agentDirectory, "runs", runId)
    const workspace = join(runDirectory, "workspace")
    // 仅此处在宿主机创建持久化 bind mount；Solver 的文件与系统操作都进入容器。
    await mkdir(workspace, { recursive: true })
    // skills 的脚本/参考资料必须在容器内可见，不能把宿主机路径注入给 Agent。
    const skills = await materializeSkills(this.skills, workspace)

    const record: RunRecord = {
      id: runId,
      challengeId,
      workspace,
      status: "running",
      createdAt: new Date().toISOString(),
    }
    this.state.runs.push(record)
    await this.saveState()
    await writeFile(join(runDirectory, "run.json"), JSON.stringify(record, null, 2))

    let sandbox: Sandbox
    try {
      sandbox = await this.sandboxFactory({
        projectId: this.config.project.id,
        runId,
        image: this.config.sandbox.image,
        workspace,
        privileged: this.config.sandbox.privileged,
        networkMode: this.config.sandbox.networkMode,
      })
    } catch (error) {
      record.status = "closed"
      record.closedReason = "manual"
      record.closedAt = new Date().toISOString()
      await this.persistRecord(record, runDirectory)
      throw error
    }

    let solver: CtfSolverAgent
    try {
      solver = await CtfSolverAgent.create({
        identity: { projectId: this.config.project.id, runId, workspace, challenge },
        capability,
        sandbox,
        agent: options.agent,
        features: { skills, compaction: options.compaction },
        onClosed: async (reason) => {
          record.status = "closed"
          record.closedReason = reason
          record.closedAt = new Date().toISOString()
          this.solvers.delete(solver)
          await this.persistRecord(record, runDirectory)
        },
      })
    } catch (error) {
      await sandbox.close()
      record.status = "closed"
      record.closedReason = "manual"
      record.closedAt = new Date().toISOString()
      await this.persistRecord(record, runDirectory)
      throw error
    }
    this.solvers.add(solver)
    return solver
  }

  async close(): Promise<void> {
    await Promise.all([...this.solvers].map((solver) => solver.close()))
    await this.platform.close()
  }

  private async persistRecord(record: RunRecord, runDirectory: string): Promise<void> {
    await this.saveState()
    await writeFile(join(runDirectory, "run.json"), JSON.stringify(record, null, 2))
  }

  private async loadState(): Promise<void> {
    try {
      const raw: unknown = JSON.parse(await readFile(join(this.agentDirectory, "state.json"), "utf8"))
      if (typeof raw !== "object" || raw === null || (raw as { version?: unknown }).version !== 1 || !Array.isArray((raw as { runs?: unknown }).runs)) {
        throw new Error("state.json 格式无效")
      }
      this.state = raw as ProjectState
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return
      throw new Error(`无法加载 Project 状态: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async saveState(): Promise<void> {
    await writeFile(join(this.agentDirectory, "state.json"), JSON.stringify(this.state, null, 2))
  }
}
