import type { ModelPoolEntryUpdate } from "../types.ts"

type ModelIdentity = Pick<
  ModelPoolEntryUpdate,
  "provider" | "modelId" | "thinkingEnabled" | "reasoningEffort"
>

/** 新模型条目使用可读且稳定的 Provider/模型/推理档位作为配置 ID。 */
export function modelPoolEntryId(model: ModelIdentity): string {
  const thinkingLevel = model.thinkingEnabled ? model.reasoningEffort : "off"
  return `${model.provider}/${model.modelId}@${thinkingLevel}`
}
