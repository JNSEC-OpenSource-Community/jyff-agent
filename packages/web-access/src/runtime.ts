import type { SecretResolver } from "./index.ts"

/**
 * Model 认证解析器：把宿主模型池适配成 pi-web-access 期望的
 * `modelRegistry.getApiKeyAndHeaders` 语义。用于 openai/xai 搜索
 * 以及 auto-summary 的模型调用。
 */
export interface ModelAuthResolver {
  find(
    provider: string,
    modelId: string,
  ): { provider: string; id: string } | undefined
  getApiKeyAndHeaders(model: {
    provider: string
    id: string
  }): Promise<
    | { ok: true; apiKey: string; headers?: Record<string, string> }
    | { ok: false }
  >
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

let runtime: WebAccessRuntime | null = null

export function setRuntime(r: WebAccessRuntime): void {
  runtime = r
}

export function getRuntime(): WebAccessRuntime {
  if (!runtime) {
    throw new Error(
      "web-access runtime 未初始化：必须先调用 createWebAccessTools(config)",
    )
  }
  return runtime
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
export function providerOption(
  provider: string,
  key: string,
): string | undefined {
  const opts = getRuntime().providerConfig[provider]
  return opts?.[key]
}
