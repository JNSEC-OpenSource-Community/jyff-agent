import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { discoverProjectSkillsWithDiagnostics } from "@ctf-agent/agents"
import {
  AuditStore,
  ContestScheduler,
  ControlPlane,
  FatherSessionManager,
  FatherValidationConfigStore,
  FileSecretStore,
  PlatformExtensionStore,
  shellpoopApiKeySecretName,
  webAccessSecretName,
} from "@ctf-agent/core"
import {
  ctfdPlatform,
  dasctfPlatform,
  gzctfPlatform,
  PlatformPluginRegistry,
  ret2shellPlatform,
} from "@ctf-agent/platform"
import { CodeAuditRunner } from "./domain/code-audit-runner.ts"
import { createFileModelAuthentication } from "./domain/model-auth.ts"
import { createFileModelConfiguration } from "./domain/model-pool.ts"
import { createFileProjectRuntimeConfiguration } from "./domain/runtime.ts"
import { createFileSchedulerConfiguration } from "./domain/scheduler-config.ts"
import { createFileShellPoopConfiguration } from "./domain/shellpoop-config.ts"
import { createFileWebAccessConfiguration } from "./domain/web-access-config.ts"
import { createFileWebUiAuthentication } from "./domain/webui-auth.ts"
import {
  createFileBuiltInPluginConfiguration,
  TOKEN_USAGE_PLUGIN_ID,
} from "./domain/built-in-plugin-config.ts"
import { createProcessShutdown } from "./process-shutdown.ts"
import { startWebUi, type WebUiServer } from "./server.ts"

interface WebUiProcessOptions {
  root: string
  host: string
  port: number
  pollIntervalMs: number
  maxConcurrent: number
  maxAttempts: number
  maxSessionInterruptions: number
  challengeTimeoutMs: number
  retryDelayMs: number
  workspaceVolume?: string
  authFile: string
  autoStart: boolean
}

const options = parseOptions(process.argv.slice(2))
const stateDirectory = join(options.root, ".ctf-agent")
const secretStore = await FileSecretStore.open(join(stateDirectory, "secrets.json"))
const modelAuthentication = await createFileModelAuthentication({
  storagePath: join(stateDirectory, "auth.json"),
  importPath: options.authFile,
})
const modelConfiguration = await createFileModelConfiguration({
  storagePath: join(stateDirectory, "model-config.json"),
  secretStore,
  authentication: modelAuthentication,
})
const webAccessConfiguration = await createFileWebAccessConfiguration({
  storagePath: join(stateDirectory, "web-access.json"),
  secretStore,
})
const shellpoopConfiguration = await createFileShellPoopConfiguration({
  storagePath: join(stateDirectory, "shellpoop.json"),
  secretStore,
})
const builtInPluginConfiguration = await createFileBuiltInPluginConfiguration(
  join(stateDirectory, "built-in-plugins.json"),
)
const schedulerConfiguration = await createFileSchedulerConfiguration({
  storagePath: join(stateDirectory, "scheduler-config.json"),
  fallback: options.maxConcurrent,
})
const authentication = await createFileWebUiAuthentication(
  join(stateDirectory, "global-config.json"),
)
const projectRuntimeConfigurations = new Map<
  string,
  Awaited<ReturnType<typeof createFileProjectRuntimeConfiguration>>
>()
const auditStorePath = join(stateDirectory, "audits.sqlite")
const auditRunner = new CodeAuditRunner(
  join(stateDirectory, "audit-work"),
  auditStorePath,
  modelConfiguration,
)
const auditStore = await AuditStore.open(auditStorePath)
const interruptedAudits = auditStore.interruptActiveRuns()
auditStore.close()
if (interruptedAudits > 0) {
  console.warn(`已将 ${interruptedAudits} 个未完成审计标记为失败；当前 Worker 不支持进程重启恢复。`)
}
await auditRunner.cleanupOrphans()
const platformRegistry = new PlatformPluginRegistry([
  ctfdPlatform,
  dasctfPlatform,
  gzctfPlatform,
  ret2shellPlatform,
])
const extensions = await PlatformExtensionStore.open({
  root: options.root,
  registry: platformRegistry,
  validationSandbox: {
    image: "ctf-agent-solver:latest",
    ...(options.workspaceVolume
      ? {
          workspaceMount: (sessionId: string) => ({
            type: "volume" as const,
            source: options.workspaceVolume as string,
            subpath: `father/sessions/${sessionId}/workspace`,
          }),
        }
      : {}),
  },
})
const applicationRoot = fileURLToPath(new URL("../../../", import.meta.url))
const fatherSkills = await discoverProjectSkillsWithDiagnostics(applicationRoot, [
  "packages/agents/skills/extension-authoring",
])
if (fatherSkills.diagnostics.length > 0) {
  console.warn("extension-authoring skill 加载警告", fatherSkills.diagnostics)
}
if (!fatherSkills.skills.some(({ name }) => name === "extension-authoring")) {
  throw new Error("内置 extension-authoring skill 加载失败，拒绝启动 Clanker Father")
}
const father = await FatherSessionManager.open({
  root: options.root,
  image: "ctf-agent-solver:latest",
  createAgentOptions: () => modelConfiguration.createAgentOptions("father"),
  skills: fatherSkills.skills,
  skillRevision: "builtin-v1",
  ...(options.workspaceVolume
    ? {
        workspaceMount: (sessionId: string) => ({
          type: "volume" as const,
          source: options.workspaceVolume as string,
          subpath: `father/sessions/${sessionId}/workspace`,
        }),
      }
    : {}),
})
const fatherValidationConfigs = new FatherValidationConfigStore(options.root, secretStore)
async function projectRuntimeConfiguration(context: { projectId: string; stateDirectory: string }) {
  const existing = projectRuntimeConfigurations.get(context.projectId)
  if (existing) return existing
  const globalModels = modelConfiguration.snapshot()
  const configuration = await createFileProjectRuntimeConfiguration({
    storagePath: join(context.stateDirectory, "runtime-config.json"),
    fallback: {
      solverModelId: globalModels.solverModelId,
      tldrModelId: globalModels.tldrModelId,
      subagentModels: globalModels.subagentModels,
      maxConcurrent: schedulerConfiguration.snapshot(),
      maxRemoteEnvironments: 1,
    },
    availableModelIds: () => new Set(modelConfiguration.snapshot().models.map((model) => model.id)),
  })
  projectRuntimeConfigurations.set(context.projectId, configuration)
  return configuration
}
const controlPlane = await ControlPlane.create({
  root: options.root,
  platforms: platformRegistry,
  secretStore,
  project: {
    telemetry: { level: "full", maxTextLength: 8_000 },
    tokenUsageEnabled: () => builtInPluginConfiguration.isEnabled(TOKEN_USAGE_PLUGIN_ID),
    ...(options.workspaceVolume
      ? {
          workspaceMount: ({ relativeWorkspace }) => ({
            type: "volume" as const,
            source: options.workspaceVolume as string,
            subpath: relativeWorkspace,
          }),
        }
      : {}),
    // web-access 插件默认关闭；启用时把 allowlist + 密钥 + 模型解析器组装成
    // WebAccessConfig。密钥只从全局 SecretStore 读取，读 API 永不返回值。
    webAccessConfig: async (workspace, signal) => {
      const snapshot = await webAccessConfiguration.projectSnapshot()
      if (!snapshot.enabled || snapshot.providers.length === 0) return null
      return {
        providers: snapshot.providers,
        workflow: snapshot.workflow,
        resolveSecret: (provider) => secretStore.get(webAccessSecretName(provider)),
        modelAuth: modelConfiguration.resolveModelAuth(),
        ...(snapshot.summaryModel ? { summaryModel: snapshot.summaryModel } : {}),
        workspaceHostPath: workspace,
        ssrf: snapshot.ssrf,
        timeouts: snapshot.timeouts,
        ...(snapshot.providerConfig ? { providerConfig: snapshot.providerConfig } : {}),
        sessionSignal: signal,
      }
    },
    // ShellPoop 反弹 shell 插件默认关闭；启用时把服务地址、超时与 API 密钥
    // 组装成 ShellPoopConfig 注入 Solver/SubAgent 工具，并把所属 challenge
    // 写入 note 标签，使 shell 与 challenge 的绑定在服务端持久可见。
    // 密钥从全局 SecretStore 读取，服务端配了 SHELLPOOP_API_KEY 时用于认证。
    shellpoopConfig: async (signal, { challengeId }) => {
      const snapshot = await shellpoopConfiguration.projectSnapshot()
      if (!snapshot.enabled) return null
      return {
        baseUrl: snapshot.baseUrl,
        timeoutMs: snapshot.timeoutMs,
        // 延迟解析：每次请求都从 SecretStore 重读密钥，改动即时生效，
        // 不必等重启或下一个 run 重建会话。
        resolveApiKey: () => secretStore.get(shellpoopApiKeySecretName()),
        sessionSignal: signal,
        challengeId,
      }
    },
  },
  createProjectOptions: async (context) => {
    const runtime = await projectRuntimeConfiguration(context)
    return {
      remoteEnvironments: {
        maxConcurrent: runtime.snapshot().maxRemoteEnvironments,
      },
      subagents: {
        modelForRole: (role) => modelConfiguration.modelForSubagent(role, runtime.snapshot()),
      },
    }
  },
  createScheduler: async (project, context) => {
    const runtime = await projectRuntimeConfiguration(context)
    const scheduler = new ContestScheduler(project, {
      maxConcurrent: runtime.snapshot().maxConcurrent,
      maxAttempts: options.maxAttempts,
      maxSessionInterruptions: options.maxSessionInterruptions,
      writeup: true,
      challengeTimeoutMs: options.challengeTimeoutMs,
      retryDelayMs: options.retryDelayMs,
      availability: () => {
        const model = modelConfiguration.snapshot(runtime.snapshot())
        return {
          available: model.configured,
          ...(model.unavailableReason ? { unavailableReason: model.unavailableReason } : {}),
        }
      },
      createAgentOptions: () => modelConfiguration.createAgentOptions("solver", runtime.snapshot()),
      compaction: true,
      onMaxConcurrentChange: async (maxConcurrent) => {
        await runtime.update({ ...runtime.snapshot(), maxConcurrent })
      },
    })
    await scheduler.restore()
    return scheduler
  },
})

let webui: WebUiServer | undefined
const processShutdown = createProcessShutdown({
  close: async () => {
    // 先调用 WebUI.close() 停止接收新请求；它在首次 await 前会关闭定时器与 SSE。
    // Father 与 ControlPlane 随后并行关闭，单个清理失败不能阻止其他 Agent 正常回收。
    const operations: Promise<void>[] = []
    if (webui) operations.push(webui.close())
    operations.push(father.close(), controlPlane.close())
    const settled = await Promise.allSettled(operations)
    const failures = settled
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason)
    if (failures.length > 0) {
      throw new AggregateError(failures, "Agent 进程资源回收不完整")
    }
  },
})

function shutdownAfterSignal(signal: NodeJS.Signals): void {
  void processShutdown.shutdown(signal).catch((error: unknown) => {
    console.error("Agent 进程资源回收不完整", error)
    process.exitCode = 1
  })
}

process.once("SIGINT", () => shutdownAfterSignal("SIGINT"))
process.once("SIGTERM", () => shutdownAfterSignal("SIGTERM"))
process.once("SIGHUP", () => shutdownAfterSignal("SIGHUP"))
if (process.platform === "win32") {
  process.once("SIGBREAK", () => shutdownAfterSignal("SIGBREAK"))
}
process.on("uncaughtException", (error, origin) => {
  processShutdown.fatal(`uncaughtException:${origin}`, error)
})
process.on("unhandledRejection", (reason) => {
  processShutdown.fatal("unhandledRejection", reason)
})

try {
  await controlPlane.start()
  webui = await startWebUi({
    controlPlane,
    modelAuthentication,
    modelConfiguration,
    authentication,
    father,
    fatherValidationConfigs,
    extensions,
    builtInPluginConfiguration,
    webAccessConfiguration,
    shellpoopConfiguration,
    projectRuntimeConfiguration: (projectId) => projectRuntimeConfigurations.get(projectId),
    auditStore: () => AuditStore.open(auditStorePath),
    auditArchiveDirectory: join(stateDirectory, "audit-archives"),
    auditWorkDirectory: join(stateDirectory, "audit-work"),
    preflightAudit: () => auditRunner.preflight(),
    validateAuditModel: async (modelId) => {
      await modelConfiguration.codexSecurityConfiguration(modelId)
    },
    runAudit: (run, audit) => auditRunner.run(run, audit),
    cancelAudit: (runId) => auditRunner.cancel(runId),
    pauseAudit: (runId) => auditRunner.pause(runId),
    resumeAudit: (runId) => auditRunner.resume(runId),
    onProjectDeleted: (projectId) => {
      projectRuntimeConfigurations.delete(projectId)
    },
    host: options.host,
    port: options.port,
    pollIntervalMs: options.pollIntervalMs,
  })

  console.log(`JYFF Agent WebUI 已启动：${webui.url}`)
  if (controlPlane.snapshot().phase !== "ready") {
    console.log("比赛平台尚未连接，请在 WebUI 中完成配置")
  }
  if (options.autoStart) {
    for (const project of controlPlane.projectSnapshots()) {
      const scheduler = controlPlane.currentScheduler(project.id)
      const runtime = projectRuntimeConfigurations.get(project.id)
      if (!scheduler || !runtime) continue
      const availability = modelConfiguration.snapshot(runtime.snapshot())
      if (availability.configured) {
        await scheduler.startAuto()
        console.log(`${project.name}：自主调度已开启`)
      } else {
        console.log(`${project.name}：自主调度未开启：${availability.unavailableReason}`)
      }
    }
  }
} catch (error) {
  processShutdown.fatal("启动失败", error)
}

function parseOptions(args: string[]): WebUiProcessOptions {
  const values = new Map<string, string>()
  let autoStart = false
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index]
    if (name === "--auto-start") {
      autoStart = true
      continue
    }
    if (!name?.startsWith("--")) throw new Error(`无效启动参数: ${name}`)
    const value = args[index + 1]
    if (!value || value.startsWith("--")) throw new Error(`${name} 缺少值`)
    values.set(name, value)
    index += 1
  }
  const known = new Set([
    "--root",
    "--host",
    "--port",
    "--poll-interval-ms",
    "--max-concurrent",
    "--max-attempts",
    "--max-session-interruptions",
    "--challenge-timeout-ms",
    "--retry-delay-ms",
    "--workspace-volume",
    "--auth-file",
  ])
  for (const name of values.keys()) {
    if (!known.has(name)) throw new Error(`未知启动参数: ${name}`)
  }
  return {
    root: resolve(values.get("--root") ?? process.cwd()),
    host: values.get("--host") ?? "0.0.0.0",
    port: positiveInteger(values, "--port", 3_000, 65_535),
    pollIntervalMs: positiveInteger(values, "--poll-interval-ms", 1_000, 60_000),
    maxConcurrent: positiveInteger(values, "--max-concurrent", 8, 64),
    maxAttempts: positiveInteger(values, "--max-attempts", 2, 100),
    maxSessionInterruptions: positiveInteger(values, "--max-session-interruptions", 3, 100),
    challengeTimeoutMs: positiveInteger(
      values,
      "--challenge-timeout-ms",
      30 * 60_000,
      24 * 60 * 60_000,
    ),
    retryDelayMs: positiveInteger(values, "--retry-delay-ms", 2_000, 60 * 60_000),
    ...(values.get("--workspace-volume")
      ? { workspaceVolume: values.get("--workspace-volume") }
      : {}),
    authFile: resolve(values.get("--auth-file") ?? "/auth.json"),
    autoStart,
  }
}

function positiveInteger(
  values: ReadonlyMap<string, string>,
  name: string,
  fallback: number,
  maximum: number,
): number {
  const raw = values.get(name)
  if (raw === undefined) return fallback
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} 必须是 1 到 ${maximum} 的整数`)
  }
  return parsed
}
