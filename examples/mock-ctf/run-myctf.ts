// examples/mock-ctf/run-myctf.ts —— 8 路并发批量解题(MyCTF 平台管道第五步)
// 复用 run.ts 的 loadEnvFile 与模型构造样板(复制,不重写)。
// CLI: --only <id> 只跑单题(便于冒烟);不传则跑全部未解决题目。
import { execFile } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import type { AgentOptions } from "@earendil-works/pi-agent-core"
import { getModel, type Model } from "@earendil-works/pi-ai/compat"
import { ContestRunner, Project, parseProjectConfig, type ProjectConfig } from "@ctf-agent/project"
import { mockPlatform } from "@ctf-agent/platform-mock"
import { remotePlatform } from "@ctf-agent/platform-client"
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions"
import { deepseekThinkingLevelMap, thinkingEnabledFromEnv, thinkingLevelFromEnv } from "./agent-config.ts"
import { withPlatformConfigOverride } from "./platform-env.ts"

const exec = promisify(execFile)

// 从项目根目录的 .env 文件加载环境变量(不依赖 dotenv 包) —— 与 run.ts 相同
function loadEnvFile(): void {
  const candidates = [
    join(resolve(import.meta.dirname), "..", "..", ".env"),
    join(process.cwd(), ".env"),
  ]
  for (const path of candidates) {
    if (!existsSync(path)) continue
    const content = readFileSync(path, "utf-8")
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("#")) continue
      const match = /^([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*"?([^"#]*?)"?\s*(?:#.*)?$/.exec(trimmed)
      if (!match) continue
      const key = match[1]!
      if (process.env[key]) continue // 不覆盖已有的环境变量
      process.env[key] = match[2]!
    }
    return
  }
}
loadEnvFile()

// 顶层收口:任何前置校验失败都打印干净文案并退出,不抛原始堆栈。
function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

// API Key 前置门控:无 Key 或占位 Key 时打印指引并退出,而不是跑到一半才报错。
// 有效 Key 判定:以 "sk-" 开头且长度 > 20(.env.example 占位符 sk-your-api-key-here 恰为 20 字符)。
const apiKey = process.env.CTF_MODEL_API_KEY ?? process.env.OPENROUTER_API_KEY
if (!apiKey || !(apiKey.startsWith("sk-") && apiKey.length > 20)) {
  fail("未设置 API Key:请在项目根目录 .env 填入 CTF_MODEL_API_KEY(参考 .env.example),然后重试。")
}

// CLI: --only <id> 只跑单题(便于冒烟)
function parseOnlyArg(): string | undefined {
  const args = process.argv.slice(2)
  const index = args.indexOf("--only")
  if (index === -1) return undefined
  const value = args[index + 1]
  if (!value || value.startsWith("--")) {
    fail("--only 需要一个题目 id,例如: --only misc-ez-png")
  }
  return value
}
const onlyId = parseOnlyArg()

const modelId = process.env.CTF_MODEL_ID ?? process.env.OPENROUTER_MODEL
const provider = process.env.CTF_MODEL_PROVIDER ?? "openrouter"
const baseUrl = process.env.CTF_MODEL_BASE_URL

if (!modelId) {
  fail(
    "未设置 MODEL。请在项目根目录创建 .env 文件(参考 .env.example):\n" +
    "  CTF_MODEL_ID = \"deepseek-chat\"\n" +
    "或设置环境变量 CTF_MODEL_ID / OPENROUTER_MODEL",
  )
}

// 模型构造 —— 与 run.ts 相同
const model: Model<"openai-completions"> = baseUrl ? {
  id: modelId,
  name: modelId,
  api: "openai-completions",
  provider,
  baseUrl: baseUrl.replace(/\/+$/, ""),
  reasoning: thinkingEnabledFromEnv(),
  thinkingLevelMap: provider === "deepseek" || baseUrl.includes("deepseek.com")
    ? deepseekThinkingLevelMap(modelId)
    : undefined,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: Number(process.env.CTF_MODEL_CONTEXT_WINDOW ?? 64_000),
  maxTokens: Number(process.env.CTF_MODEL_MAX_TOKENS ?? 4_096),
  compat: {
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsUsageInStreaming: false,
    supportsStrictMode: false,
    supportsLongCacheRetention: false,
    maxTokensField: "max_tokens",
  },
} : (() => {
  const builtin = getModel(provider as never, modelId as never) as Model<"openai-completions"> | undefined
  if (!builtin) throw new Error(`Pi 未内置模型: ${provider}/${modelId}。自定义 API 请设置 .env 中的 API-KEY 和 MODEL,脚本会自动使用 ${provider} 的 API endpoint(当前推断: ${baseUrl ?? "未知"})`)
  return {
    ...builtin,
    contextWindow: Math.min(builtin.contextWindow, Number(process.env.CTF_MODEL_CONTEXT_WINDOW ?? 16_000)),
    maxTokens: Math.min(builtin.maxTokens, Number(process.env.CTF_MODEL_MAX_TOKENS ?? 4_096)),
    reasoning: thinkingEnabledFromEnv(),
    compat: {
      ...builtin.compat,
      supportsDeveloperRole: false,
    },
  }
})()

// 从合并后的 ctf-config.json 读取平台模式与题列表;与 Project.open 共用 parseProjectConfig 统一 schema 校验。
const root = resolve(import.meta.dirname)
const configPath = join(root, ".pi", "ctf-config.json")
let parsedConfig: ProjectConfig
try {
  parsedConfig = parseProjectConfig(JSON.parse(readFileSync(configPath, "utf-8")))
} catch (error) {
  fail(`无法读取 ctf-config.json:${error instanceof Error ? error.message : String(error)}`)
}
// 平台模式由 contest.platform 决定(SWITCH.md:默认 remote,可切 mock);题列表仅 mock 配置内置,remote 由服务器提供。
const activePlatform = parsedConfig.contest.platform
interface MockChallengeList { challenges?: Array<{ id: string; remote?: boolean }> }
const mockChallenges = (parsedConfig.platform.config as MockChallengeList).challenges ?? []
const allIds = mockChallenges.map((challenge) => challenge.id)
const uniqueIds = new Set(allIds)

// 重复 id 警告:配置存在碰撞时 ContestRunner 按 id 去重,实际运行的题数少于配置条数。
const duplicateCount = allIds.length - uniqueIds.size
if (activePlatform === "mock") {
  console.log(`配置存在 ${duplicateCount} 个重复 id,实际运行 ${uniqueIds.size} 题`)
}

// --only 校验:mock 配置即权威题列表,禁止 total=0 假通过;remote 题列表由服务器提供,交给 selectChallenge 过滤。
if (activePlatform === "mock" && onlyId && !uniqueIds.has(onlyId)) {
  fail(`未找到题目 id: ${onlyId}`)
}

const remoteIds = new Set(
  mockChallenges
    .filter((challenge) => challenge.remote)
    .map((challenge) => challenge.id),
)

function buildSystemPrompt(challengeId: string): string {
  const lines = [
    "你是 CTF Solver;所有命令和文件操作必须使用 Docker sandbox tools。",
    "请始终使用中文进行思考和推理(reasoning 输出中文)。",
    "开始时必须调用 ctf_blackboard_read 查看共享知识。",
    "必须先调用 ctf_challenge_info,使用 ctf_download_attachment 下载附件,使用 read 读取附件。",
    "必须使用 bash 解码附件,使用 ctf_blackboard_record 记录解码结果,最后调用 ctf_submit_flag。",
  ]
  if (remoteIds.has(challengeId)) {
    lines.push(
      "远程题:必须先用 ctf_instance_start 申请环境,再用 bash 连接 endpoint(tcp://主机名:端口)。",
      "动态 flag 题:FLAG 已写入容器内文件(Pwn:/home/ctf/flag;Web:/flag.txt),找到后直接提交。",
      "用完后必须调用 ctf_instance_destroy 销毁实例。",
    )
  }
  return lines.join("\n")
}

// 容器泄漏审计:challenge-* 远程实例与 solver 沙箱应全部清理,ctf-net 网络常驻属正常。
// 审计自身的 docker 命令失败不落入外层 catch(不误标"批量解题失败"),单独报错并置审计失败。
let auditFailed = false
async function auditLeaks(): Promise<void> {
  let containers: { stdout: string }
  let networks: { stdout: string }
  try {
    ;[containers, networks] = await Promise.all([
      exec("docker", ["ps", "-a", "--format", "{{.Names}}"]),
      exec("docker", ["network", "ls", "--format", "{{.Name}}"]),
    ])
  } catch (error) {
    auditFailed = true
    console.error(`泄漏审计失败: docker 命令执行失败:${error instanceof Error ? error.message : String(error)}`)
    return
  }
  const names = containers.stdout.split(/\r?\n/).map((name) => name.trim()).filter(Boolean)
  const challengeContainers = names.filter((name) => name.startsWith("challenge-"))
  const solverContainers = names.filter((name) => name.includes("solver"))
  const ctfNetExists = networks.stdout.split(/\r?\n/).map((name) => name.trim()).includes("ctf-net")
  console.log(`泄漏审计: challenge-* 容器数=${challengeContainers.length} solver 容器数=${solverContainers.length} ctf-net 网络存在=${ctfNetExists}`)
  if (challengeContainers.length > 0 || solverContainers.length > 0) {
    auditFailed = true
    console.error(`泄漏审计失败: 存在残留容器 ${challengeContainers.concat(solverContainers).join(", ")}`)
  }
  if (!ctfNetExists) {
    auditFailed = true
    console.error("泄漏审计失败: ctf-net 网络不存在")
  }
}

let project: Project | undefined
try {
  console.log(`\n[1/3] 打开 CTF Project(平台: ${activePlatform})`)
  // 双模式:config 的 contest.platform 决定插件(mock/remote);remote 模式经 env 覆盖临时写回配置。
  project = await withPlatformConfigOverride(configPath, () =>
    Project.open({ root, platforms: [mockPlatform, remotePlatform] }),
  )

  console.log(`[2/3] 创建 ContestRunner(8 路并发 / maxAttempts 2 / 30min 超时 / retryDelay 2s)${onlyId ? `,仅跑 --only ${onlyId}` : ""}\n`)
  const runner = new ContestRunner(project, {
    maxConcurrent: Number(process.env.CTF_SCHEDULER_MAX_CONCURRENT ?? 6),
    maxAttempts: 2,
    challengeTimeoutMs: 30 * 60_000,
    retryDelayMs: 2_000,
    createAgentOptions: ({ challenge }) => ({
      // 原生思维链开关:CTF_MODEL_THINKING=on 时 thinkingLevel 生效(与 webui 同源 agent-config)
      streamFn: streamSimple as AgentOptions["streamFn"],
      getApiKey: (requestedProvider) => requestedProvider === provider ? apiKey : undefined,
      initialState: {
        model,
        thinkingLevel: thinkingLevelFromEnv(),
        systemPrompt: buildSystemPrompt(challenge.id),
      },
    }),
    compaction: true,
    prompt: "解决当前 CTF 题目。严格完成黑板读取、题目信息、附件下载、read 读取、bash 分析、黑板记录和 Flag 提交的完整工具链。",
    selectChallenge: (challenge) => (onlyId ? challenge.id === onlyId : true),
  })

  const summary = await runner.run()
  // --only 假通过守卫:remote 模式题列表来自服务器,拼错 id 会 total=0 静默成功,两种模式都必须显式失败。
  if (onlyId && summary.total === 0) {
    fail(`未找到题目 id: ${onlyId}`)
  }
  console.log(`\n[3/3] 完成: 共 ${summary.total} 题, solved=${summary.solved} failed=${summary.failed} cancelled=${summary.cancelled} skipped=${summary.skipped}, 总尝试 ${summary.attempts} 次`)
  for (const result of summary.results) {
    if (result.status !== "skipped") {
      console.log(`  - ${result.challengeId}: ${result.status}${result.error ? ` (${result.error})` : ""}`)
    }
  }

  if (activePlatform === "mock") {
    const diagnostics = mockPlatform.diagnostics()
    console.log(`平台诊断: instanceStarts=${diagnostics.instanceStarts} instanceDestroys=${diagnostics.instanceDestroys} activeEnvironments=${diagnostics.activeEnvironments} maxActiveEnvironments=${diagnostics.maxActiveEnvironments}`)
  }

  await auditLeaks()
  if (summary.failed > 0 || auditFailed) process.exitCode = 1
} catch (error) {
  console.error(`\n批量解题失败:${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  process.exitCode = 1
} finally {
  await project?.close()
}
