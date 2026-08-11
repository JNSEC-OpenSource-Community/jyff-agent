import { buildDashboardSnapshot, buildEmptyDashboardSnapshot } from "../domain/view.ts"
import type {
  DashboardControlPlane,
  DashboardProject,
  DashboardScheduler,
  DashboardSnapshot,
} from "../types.ts"
import { errorText } from "./errors.ts"
import type { SseHub } from "./sse/hub.ts"

export interface DashboardSyncHealth {
  status: "ok" | "degraded"
  consecutiveFailures: number
  lastAttemptAt: string
  lastSuccessAt: string | null
  lastError: string | null
}

interface SnapshotSyncOptions {
  project?: DashboardProject
  controlPlane?: DashboardControlPlane
  scheduler?: DashboardScheduler
  projectId?: string
  sse: SseHub
}

function emptySnapshot(): DashboardSnapshot {
  const now = new Date().toISOString()
  return {
    generatedAt: now,
    overview: {
      id: "setup",
      name: "尚未配置比赛",
      challenges: 0,
      announcements: 0,
    },
    stats: {
      total: 0,
      solved: 0,
      active: 0,
      failed: 0,
      pending: 0,
      attempts: 0,
      queued: 0,
    },
    challenges: [],
    categories: [],
    announcements: [],
    announcementCandidates: [],
    environments: [],
    scheduler: null,
    controlPlane: null,
  }
}

/**
 * 平台快照同步器。
 * - refresh() 单飞：并发调用共享同一次构建；
 * - 全局快照按 fingerprint 去重广播，scoped 按项目分别去重；
 * - 连续失败进入 degraded，轮询方按 nextPollDelay() 指数退避。
 */
export class SnapshotSync {
  private readonly options: SnapshotSyncOptions
  private readonly sse: SseHub
  private latest: DashboardSnapshot
  private serialized: string
  private globalFingerprint: string
  private readonly scopedFingerprints = new Map<string, string>()
  private pendingRefresh: Promise<DashboardSnapshot> | undefined
  private healthState: DashboardSyncHealth

  constructor(options: SnapshotSyncOptions) {
    this.options = options
    this.sse = options.sse
    const now = new Date().toISOString()
    this.latest = options.controlPlane
      ? buildEmptyDashboardSnapshot(options.controlPlane, options.projectId)
      : emptySnapshot()
    this.serialized = JSON.stringify(this.latest)
    this.globalFingerprint = fingerprint(this.latest)
    this.healthState = {
      status: "ok",
      consecutiveFailures: 0,
      lastAttemptAt: now,
      lastSuccessAt: now,
      lastError: null,
    }
  }

  health(): DashboardSyncHealth {
    return { ...this.healthState }
  }

  latestSnapshot(): DashboardSnapshot {
    return this.latest
  }

  serializedSnapshot(): string {
    return this.serialized
  }

  /** 构建当前（全局/选中项目）快照，失败记入 degraded 并广播。单飞。 */
  refresh(): Promise<DashboardSnapshot> {
    if (this.pendingRefresh) return this.pendingRefresh
    this.pendingRefresh = this.build()
      .then((snapshot) => {
        this.markSyncSuccess(snapshot)
        this.latest = snapshot
        this.serialized = JSON.stringify(snapshot)
        const nextFingerprint = fingerprint(snapshot)
        if (nextFingerprint !== this.globalFingerprint) {
          this.globalFingerprint = nextFingerprint
          this.sse.broadcast("snapshot", this.serialized, snapshot.generatedAt)
        }
        return snapshot
      })
      .catch((error: unknown) => {
        this.markSyncFailure(error)
        throw error
      })
      .finally(() => {
        this.pendingRefresh = undefined
      })
    return this.pendingRefresh
  }

  /** 构建指定项目的新快照（HTTP 返回用，不广播）。 */
  async refreshProject(projectId: string): Promise<DashboardSnapshot> {
    const project = this.currentProject(projectId)
    if (project) {
      return await buildDashboardSnapshot(
        project,
        this.currentScheduler(projectId),
        this.options.controlPlane,
        projectId,
      )
    }
    if (this.options.controlPlane) {
      return buildEmptyDashboardSnapshot(this.options.controlPlane, projectId)
    }
    throw new Error("WebUI 当前没有可用的 project")
  }

  /** 轮询用：刷新指定项目快照，内容变化时才广播给该项目订阅者。 */
  async pollProject(projectId: string): Promise<void> {
    const snapshot = await this.refreshProject(projectId)
    const nextFingerprint = fingerprint(snapshot)
    if (this.scopedFingerprints.get(projectId) === nextFingerprint) return
    this.scopedFingerprints.set(projectId, nextFingerprint)
    this.sse.broadcast("snapshot", JSON.stringify(snapshot), snapshot.generatedAt, projectId)
  }

  /** 轮询退避：正常时固定间隔，degraded 时指数退避，30s 封顶。 */
  nextPollDelay(pollIntervalMs: number): number {
    if (this.healthState.status === "ok") return pollIntervalMs
    const exponent = Math.min(this.healthState.consecutiveFailures, 5)
    return Math.min(30_000, pollIntervalMs * 2 ** exponent)
  }

  private async build(): Promise<DashboardSnapshot> {
    const project = this.currentProject()
    if (project) {
      return await buildDashboardSnapshot(
        project,
        this.currentScheduler(),
        this.options.controlPlane,
      )
    }
    if (this.options.controlPlane) {
      return buildEmptyDashboardSnapshot(this.options.controlPlane)
    }
    throw new Error("WebUI 当前没有可用的 project")
  }

  private currentProject(projectId?: string): DashboardProject | undefined {
    return this.options.controlPlane
      ? this.options.controlPlane.currentProject(projectId)
      : this.options.project
  }

  private currentScheduler(projectId?: string): DashboardScheduler | undefined {
    return this.options.controlPlane
      ? this.options.controlPlane.currentScheduler(projectId)
      : this.options.scheduler
  }

  private markSyncSuccess(snapshot: DashboardSnapshot): void {
    const recovered = this.healthState.status === "degraded"
    this.healthState = {
      status: "ok",
      consecutiveFailures: 0,
      lastAttemptAt: snapshot.generatedAt,
      lastSuccessAt: snapshot.generatedAt,
      lastError: null,
    }
    if (recovered) {
      console.info("[webui] 平台同步已恢复")
      this.sse.broadcast("dashboard_recovered", JSON.stringify(this.healthState))
    }
  }

  private markSyncFailure(error: unknown): void {
    const message = errorText(error)
    this.healthState = {
      status: "degraded",
      consecutiveFailures: this.healthState.consecutiveFailures + 1,
      lastAttemptAt: new Date().toISOString(),
      lastSuccessAt: this.healthState.lastSuccessAt,
      lastError: message,
    }
    console.warn(
      `[webui] 平台快照同步失败（连续 ${this.healthState.consecutiveFailures} 次）：${message}`,
    )
    this.sse.broadcast("dashboard_error", JSON.stringify(this.healthState))
  }
}

function fingerprint(snapshot: DashboardSnapshot): string {
  return JSON.stringify({
    overview: snapshot.overview,
    stats: snapshot.stats,
    challenges: snapshot.challenges,
    categories: snapshot.categories,
    announcements: snapshot.announcements,
    environments: snapshot.environments,
    scheduler: snapshot.scheduler,
    controlPlane: snapshot.controlPlane,
  })
}
