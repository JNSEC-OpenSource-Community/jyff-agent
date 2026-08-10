const THINKING_LEVELS = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
])

interface SummaryModelScopeContext {
  cwd: string
  isProjectTrusted(): boolean
}

export interface ModelLike {
  provider: string
  id: string
}

export interface ModelRegistryLike<T extends ModelLike = ModelLike> {
  find(provider: string, id: string): T | undefined
  getAvailable(): readonly T[]
}

/**
 * Resolve a model through its native provider or a provider that routes that model ID.
 *
 * The direct registry fallback preserves explicit/native model resolution when a
 * provider's availability snapshot does not include the configured model. Callers
 * continue to apply their existing enabled-model and authentication checks.
 */
export function findModelWithProviderRouting<T extends ModelLike>(
  registry: ModelRegistryLike<T>,
  provider: string,
  id: string,
): T | undefined {
  const available = registry.getAvailable()
  const direct = available.find(
    (model) => model.provider === provider && model.id === id,
  )
  if (direct) return direct

  const routedId = `${provider}/${id}`
  // If multiple routers expose the same model ID, Pi's available-model ordering
  // determines which route is selected. An explicit provider/model selector can
  // select a specific route when that distinction matters.
  const routed = available.find((model) => model.id === routedId)
  return routed ?? registry.find(provider, id)
}

export function loadEnabledModelPatterns(
  _ctx: SummaryModelScopeContext,
): string[] | null {
  // The host model pool already gates which models exist and are enabled, so no
  // additional file-based gating is applied here. `null` means "all enabled".
  return null
}

export function summaryModelValue(model: ModelLike): string {
  return `${model.provider}/${model.id}`
}

function stripThinkingSuffix(pattern: string): string {
  const index = pattern.lastIndexOf(":")
  if (index < 0) return pattern
  const suffix = pattern.slice(index + 1)
  return THINKING_LEVELS.has(suffix) ? pattern.slice(0, index) : pattern
}

function globToRegExp(pattern: string): RegExp {
  let source = "^"
  for (const char of pattern) {
    if (char === "*") {
      source += ".*"
    } else if (char === "?") {
      source += "."
    } else {
      source += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&")
    }
  }
  return new RegExp(`${source}$`, "i")
}

export function modelMatchesEnabledPatterns(
  model: ModelLike,
  patterns: string[] | null,
): boolean {
  if (patterns === null) return true
  const value = summaryModelValue(model).toLowerCase()
  const id = model.id.toLowerCase()
  for (const rawPattern of patterns) {
    const pattern = stripThinkingSuffix(rawPattern.trim()).toLowerCase()
    if (!pattern) continue
    if (pattern.includes("*") || pattern.includes("?")) {
      const regex = globToRegExp(pattern)
      if (regex.test(value) || regex.test(id)) return true
      continue
    }
    if (pattern === value || pattern === id) return true
  }
  return false
}
