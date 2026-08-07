import type { ThinkingLevel } from "@earendil-works/pi-agent-core"
import { type Api, clampThinkingLevel, type Model } from "@earendil-works/pi-ai"

/** Solver 的产品级默认值；具体模型仍由 Pi clamp 到其支持的档位。 */
export const DEFAULT_SOLVER_THINKING_LEVEL = "medium" satisfies ThinkingLevel
export const DEFAULT_SUBAGENT_THINKING_LEVEL = "low" satisfies ThinkingLevel

const THINKING_LEVELS = new Set<ThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
])

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return (
    typeof value === "string" && THINKING_LEVELS.has(value as ThinkingLevel)
  )
}

/** Apply Pi's model-specific thinking-level support and mapping rules. */
export function resolveThinkingLevel(
  model: Model<Api>,
  requested: ThinkingLevel,
): ThinkingLevel {
  return clampThinkingLevel(model, requested)
}
