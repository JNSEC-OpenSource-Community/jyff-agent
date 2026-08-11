import { AsyncLocalStorage } from "node:async_hooks"
import type { SecretResolver } from "./index.ts"

/** DNS 解析器（SSRF 校验用）；主要作为测试接缝。 */
export type LookupAddress = { address: string; family: number }
export type Lookup = (hostname: string) => Promise<LookupAddress[]>

/**
 * Model 认证解析器：把宿主模型池适配成 pi-web-access 期望的
 * `modelRegistry.getApiKeyAndHeaders` 语义。用于 openai/xai 搜索
 * 以及 auto-summary 的模型调用。
 */
export interface ModelAuthResolver {
  find(provider: string, modelId: string): { provider: string; id: string } | undefined
  getApiKeyAndHeaders(model: {
    provider: string
    id: string
  }): Promise<{ ok: true; apiKey: string; headers?: Record<string, string> } | { ok: false }>
  getAvailable(): readonly { provider: string; id: string }[]
}

/** 运行期配置，由 createWebAccessTools 注入，被各 vendored 模块经 getRuntime() 读取。 */
export interface WebAccessRuntime {
  /** 显式 allowlist；不在集合内的 provider 不可用。空集合 = 全部禁用。 */
  providers: Set<string>
  resolveSecret: SecretResolver
  /** provider 的非密钥配置（zone/baseUrl/model 等），按 provider 名分组。 */
  providerConfig: Record<string, Record<string, string>>
  /** openai/xai 搜索 + auto-summary；缺省则这些路径禁用。 */
  modelAuth?: ModelAuthResolver
  /** auto-summary 用的模型；workflow==="auto-summary" 时必需。 */
  summaryModel?: { provider: string; id: string }
  /** 默认搜索 workflow。 */
  workflow?: "none" | "auto-summary"
  ssrf: { allowRanges: string[]; trustEnvProxy: boolean }
  fetchContent?: { allowDomains?: string[]; denyDomains?: string[] }
  /** 自定义 DNS 解析器，用于 SSRF 校验；主要作为测试接缝。 */
  lookup?: Lookup
  /** 宿主 challenge workspace（bind-mount 到容器 /workspace）。缺省则 clone/PDF 禁用。 */
  workspaceHostPath?: string
  /** = workspaceHostPath + "/.web-access/github" */
  githubClonePath?: string
  /** = workspaceHostPath + "/.web-access/pdf" */
  pdfDir?: string
  timeouts: { fetchMs: number; searchMs: number; cloneMs: number }
  limits: { maxContentSliceLength: number; maxInlineChars: number }
  /** run 结束时 abort → 清理 fetch / clone 缓存。 */
  sessionSignal?: AbortSignal
}

/**
 * runtime 经 AsyncLocalStorage 按工具执行上下文隔离：多个 Project/run 并发时，
 * 每个工具的 execute 只读到属于它自己的配置（密钥 / workspace / allowlist）。
 * `setRuntime` 只设置 fallback（例如测试直接调用 vendored 函数时的兜底）。
 */
const runtimeContext = new AsyncLocalStorage<WebAccessRuntime>()
let fallbackRuntime: WebAccessRuntime | null = null

export function setRuntime(r: WebAccessRuntime): void {
  fallbackRuntime = r
}

/** 在指定 runtime 上下文中执行（createWebAccessTools 包装每个工具的 execute）。 */
export function withRuntime<T>(r: WebAccessRuntime, fn: () => T): T {
  return runtimeContext.run(r, fn)
}

export function getRuntime(): WebAccessRuntime {
  const current = runtimeContext.getStore() ?? fallbackRuntime
  if (!current) {
    throw new Error("web-access runtime 未初始化：必须先调用 createWebAccessTools(config)")
  }
  return current
}

/**
 * 解析某 provider 的 API key（来自宿主 SecretStore）。
 * 取代上游每个 provider 的 loadConfig() + process.env.<X>_API_KEY 兜底。
 */
export function resolveProviderKey(provider: string): string | undefined {
  return getRuntime().resolveSecret(provider)
}

/** 该 provider 的 key 是否已配置（用于 availability 检查）。 */
export function providerKeyConfigured(provider: string): boolean {
  return resolveProviderKey(provider) !== undefined
}

/** 读取某 provider 的非密钥配置项（zone/baseUrl/model 等）。 */
export function providerOption(provider: string, key: string): string | undefined {
  const opts = getRuntime().providerConfig[provider]
  return opts?.[key]
}
