import { Icon } from "@iconify/react"
import { cloneElement, type ReactNode, useEffect, useId, useMemo, useState } from "react"
import {
  Button,
  Checkbox,
  Combobox,
  ErrorNotice,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/index.ts"
import { apiMutation, apiRequest } from "../../lib/api.ts"
import { errorMessage } from "../../lib/format.ts"
import { modelPoolEntryId } from "../../lib/model-pool.ts"
import type {
  ModelAuthenticationView,
  ModelConfigurationUpdate,
  ModelConfigurationView,
  ModelPoolEntryUpdate,
} from "../../types.ts"

interface EM extends ModelPoolEntryUpdate {
  uiKey: string
  automaticId: boolean
  supportedThinkingLevels: string[]
}

let modelUiKeySequence = 0

function createModelUiKey(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID()
  }

  modelUiKeySequence += 1
  return `model-${Date.now().toString(36)}-${modelUiKeySequence.toString(36)}`
}

const ed = (m: ModelConfigurationView["models"][number]): EM => ({
  uiKey: createModelUiKey(),
  automaticId: false,
  id: m.id,
  provider: m.provider,
  modelId: m.modelId,
  contextWindow: m.contextWindow,
  ...(m.maxTokens !== undefined ? { maxTokens: m.maxTokens } : {}),
  thinkingEnabled: m.thinkingEnabled,
  reasoningEffort: m.reasoningEffort,
  passthroughThinking: m.passthroughThinking,
  supportedThinkingLevels: m.supportedThinkingLevels,
})

export function ModelPoolEditor({
  configuration,
  authentication,
  onSaved,
}: {
  configuration: ModelConfigurationView
  authentication: ModelAuthenticationView
  onSaved: (n: ModelConfigurationView) => void
}) {
  const [models, setModels] = useState<EM[]>(() => configuration.models.map(ed))
  const [err, setErr] = useState("")
  const [busy, setBusy] = useState(false)
  const [solverModelId, setSolverModelId] = useState(configuration.solverModelId)
  const [tldrModelId, setTldrModelId] = useState(configuration.tldrModelId)
  const [fatherModelId, setFatherModelId] = useState(
    configuration.fatherModelId ?? configuration.solverModelId,
  )
  const [subagentModels, setSubagentModels] = useState(configuration.subagentModels)
  const [customModelIds, setCustomModelIds] = useState<Record<string, string[] | null>>({})

  useEffect(() => {
    let cancelled = false
    for (const provider of configuration.customProviders) {
      void apiRequest<{ models: string[] }>(
        `/api/model-config/providers/${encodeURIComponent(provider.id)}/models`,
      )
        .then((result) => {
          if (!cancelled) {
            setCustomModelIds((current) => ({
              ...current,
              [provider.id]: result.models.length > 0 ? result.models : null,
            }))
          }
        })
        .catch(() => {
          if (!cancelled) {
            setCustomModelIds((current) => ({
              ...current,
              [provider.id]: null,
            }))
          }
        })
    }
    return () => {
      cancelled = true
    }
  }, [configuration.customProviders])

  const providerOptions = useMemo(
    () => [
      ...authentication.providers
        .filter((p) => p.configured)
        .map((p) => ({
          value: p.id,
          label: p.name,
          description: "已连接",
        })),
      ...configuration.customProviders.map((p) => ({
        value: p.id,
        label: p.name,
        description: p.api,
      })),
    ],
    [authentication.providers, configuration.customProviders],
  )

  function rebindModel(previousId: string, nextId: string): void {
    const rebind = (modelId: string) => (modelId === previousId ? nextId : modelId)
    setSolverModelId(rebind)
    setTldrModelId(rebind)
    setFatherModelId(rebind)
    setSubagentModels((current) =>
      Object.fromEntries(
        Object.entries(current).flatMap(([role, modelId]) => {
          if (modelId !== previousId) return [[role, modelId]]
          return nextId ? [[role, nextId]] : []
        }),
      ),
    )
  }

  function up(i: number, patch: Partial<EM>): void {
    const current = models[i]
    if (!current) return
    const patched = { ...current, ...patch }
    const next = patched.automaticId ? { ...patched, id: modelPoolEntryId(patched) } : patched
    if (next.id !== current.id) rebindModel(current.id, next.id)
    setModels((entries) => entries.map((model, index) => (index === i ? next : model)))
  }

  function removeModel(i: number): void {
    const removed = models[i]
    if (!removed) return
    const remaining = models.filter((_, index) => index !== i)
    setModels(remaining)
    rebindModel(removed.id, remaining[0]?.id ?? "")
  }

  function modelOptions(providerId: string) {
    const prov = authentication.providers.find((p) => p.id === providerId)
    if (!prov) return []
    return prov.models.map((x) => ({
      value: x.id,
      label: x.name,
      description: `${(x.contextWindow / 1000).toFixed(0)}k · ${x.reasoning ? "支持推理" : "无推理"}`,
    }))
  }

  async function save() {
    setBusy(true)
    setErr("")
    try {
      const payload: ModelConfigurationUpdate = {
        models: models.map(
          ({ uiKey: _, automaticId: __, supportedThinkingLevels: ___, ...m }) => m,
        ),
        solverModelId,
        tldrModelId,
        fatherModelId,
        subagentModels,
      }
      const r = await apiMutation<{ configuration: ModelConfigurationView }>(
        "/api/model-config",
        "POST",
        payload,
      )
      setModels(r.configuration.models.map(ed))
      setSolverModelId(r.configuration.solverModelId)
      setTldrModelId(r.configuration.tldrModelId)
      setFatherModelId(r.configuration.fatherModelId ?? r.configuration.solverModelId)
      setSubagentModels(r.configuration.subagentModels)
      onSaved(r.configuration)
    } catch (e) {
      setErr(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      {err ? <ErrorNotice message={err} /> : null}
      <section>
        <div className="mb-3">
          <h3 className="text-sm font-semibold">Agent 默认模型</h3>
          <p className="mt-1! text-xs text-muted-foreground">
            新建比赛继承 Solver 与 TLDR 默认值；Father 始终使用这里的全局配置。
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Solver">
            <Combobox
              value={solverModelId}
              onChange={setSolverModelId}
              options={models.map((model) => ({ value: model.id, label: model.id }))}
              placeholder="选择 Solver 模型"
              disabled={models.length === 0}
            />
          </Field>
          <Field label="TLDR">
            <Combobox
              value={tldrModelId}
              onChange={setTldrModelId}
              options={models.map((model) => ({ value: model.id, label: model.id }))}
              placeholder="选择 TLDR 模型"
              disabled={models.length === 0}
            />
          </Field>
          <Field label="Clanker Father">
            <Combobox
              value={fatherModelId}
              onChange={setFatherModelId}
              options={models.map((model) => ({ value: model.id, label: model.id }))}
              placeholder="选择 Father 模型"
              disabled={models.length === 0}
            />
          </Field>
        </div>
      </section>
      <section className="border-t border-border pt-4">
        <div className="mb-3 flex items-end justify-between gap-4">
          <div>
            <h3 className="text-sm font-semibold">模型池</h3>
            <p className="mt-1! text-xs text-muted-foreground">
              这些模型可供各比赛绑定 Solver、TLDR 与
              SubAgent；同一模型可配置多个思考强度，但相同有效强度只能配置一次。
            </p>
          </div>
          <span className="font-mono text-xs tabular-nums text-muted-foreground">
            {models.length} 个
          </span>
        </div>
        <div className="space-y-2.5">
          {models.map((m, i) => {
            const prov = authentication.providers.find((p) => p.id === m.provider)
            const customProvider = configuration.customProviders.find((p) => p.id === m.provider)
            const discoveredModels = customProvider ? customModelIds[customProvider.id] : undefined
            return (
              <article key={m.uiKey} className="overflow-hidden rounded-md border border-border">
                <div className="flex items-center gap-3 border-b border-border bg-muted px-4 py-2.5">
                  <span className="flex size-6 items-center justify-center rounded-md bg-muted font-mono text-[11px] font-bold tabular-nums text-muted-foreground">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <Input
                    aria-label="模型配置 ID"
                    value={m.id}
                    readOnly={m.automaticId}
                    onChange={(e) => up(i, { id: e.target.value, automaticId: false })}
                    className="h-7 flex-1 border-0 bg-transparent text-sm font-medium shadow-none focus-visible:ring-0"
                  />
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-7 text-muted-foreground hover:text-danger"
                    aria-label={`删除模型 ${m.id}`}
                    title={`删除模型 ${m.id}`}
                    onClick={() => removeModel(i)}
                  >
                    <Icon icon="lucide:trash-2" width="13" />
                  </Button>
                </div>
                <div className="grid gap-3 p-3 sm:grid-cols-2 lg:grid-cols-3">
                  <Field label="供应商">
                    <Combobox
                      value={m.provider}
                      onChange={(v) => {
                        const newProv = authentication.providers.find((p) => p.id === v)
                        const s = newProv?.models[0]
                        up(i, {
                          provider: v,
                          modelId: s?.id ?? "",
                          ...(s
                            ? {
                                contextWindow: s.contextWindow,
                                thinkingEnabled: s.reasoning,
                                reasoningEffort: s.reasoning ? "medium" : "off",
                              }
                            : {}),
                        })
                      }}
                      options={providerOptions}
                      placeholder="选择 Provider"
                      searchPlaceholder="搜索…"
                      emptyText="无匹配"
                    />
                  </Field>
                  <Field label="模型 ID">
                    {customProvider && discoveredModels?.length ? (
                      <Combobox
                        value={m.modelId}
                        onChange={(modelId) => up(i, { modelId })}
                        options={discoveredModels.map((modelId) => ({
                          value: modelId,
                          label: modelId,
                        }))}
                        placeholder="选择模型"
                        searchPlaceholder="搜索…"
                        emptyText="无匹配"
                      />
                    ) : customProvider ? (
                      <Input
                        value={m.modelId}
                        onChange={(e) => up(i, { modelId: e.target.value })}
                        placeholder="输入兼容端点的模型 ID"
                      />
                    ) : (
                      <Combobox
                        value={m.modelId}
                        onChange={(v) => {
                          const s = prov?.models.find((x) => x.id === v)
                          up(i, {
                            modelId: v,
                            ...(s
                              ? {
                                  contextWindow: s.contextWindow,
                                  thinkingEnabled: s.reasoning,
                                  reasoningEffort: s.reasoning ? "medium" : "off",
                                }
                              : {}),
                          })
                        }}
                        options={modelOptions(m.provider)}
                        placeholder="选择模型"
                        searchPlaceholder="搜索…"
                        emptyText="无匹配"
                      />
                    )}
                  </Field>
                  <Field label="上下文窗口" description="模型可接收的最大 token 数。">
                    <Input
                      type="number"
                      min="1"
                      value={m.contextWindow}
                      onChange={(e) => up(i, { contextWindow: Number(e.target.value) })}
                      className="h-8 text-xs"
                    />
                  </Field>
                  <Field
                    label="最大输出 Tokens"
                    description="单次回复上限(max_tokens)，留空默认 32768。端点报 max_tokens 非法时按其允许范围填写。"
                  >
                    <Input
                      type="number"
                      min="1"
                      value={m.maxTokens ?? ""}
                      placeholder="32768"
                      onChange={(e) =>
                        up(i, {
                          maxTokens: e.target.value === "" ? undefined : Number(e.target.value),
                        })
                      }
                      className="h-8 text-xs"
                    />
                  </Field>
                  <Field
                    label="默认推理强度"
                    description="新建 Agent 时使用；关闭推理后该值不会发送。"
                  >
                    <Select
                      value={m.reasoningEffort}
                      onValueChange={(v) => up(i, { reasoningEffort: v })}
                    >
                      <SelectTrigger className="h-8 w-full text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((l) => (
                          <SelectItem value={l} key={l}>
                            {l}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                </div>
                <div className="flex flex-wrap gap-3 border-t border-border bg-muted/30 px-3 py-2.5">
                  <label
                    htmlFor={`${m.uiKey}-thinking`}
                    className="flex items-center gap-2 text-xs text-muted-foreground"
                  >
                    <Checkbox
                      id={`${m.uiKey}-thinking`}
                      checked={m.thinkingEnabled}
                      onCheckedChange={(c) => up(i, { thinkingEnabled: c === true })}
                    />
                    启用推理输出
                  </label>
                  <label
                    htmlFor={`${m.uiKey}-passthrough`}
                    className="flex items-center gap-2 text-xs text-muted-foreground"
                  >
                    <Checkbox
                      id={`${m.uiKey}-passthrough`}
                      checked={m.passthroughThinking}
                      onCheckedChange={(c) => up(i, { passthroughThinking: c === true })}
                    />
                    向自定义端点透传推理档位
                  </label>
                </div>
              </article>
            )
          })}
        </div>
      </section>
      <div className="flex justify-end gap-3">
        <Button
          variant="secondary"
          onClick={() => {
            const p =
              authentication.providers.find((x) => x.configured && x.id === "openai") ??
              authentication.providers.find((x) => x.configured)
            const cp = configuration.customProviders[0]
            const s = p?.models[0]
            const entry = {
              provider: p?.id ?? cp?.id ?? "",
              modelId: s?.id ?? "",
              contextWindow: s?.contextWindow ?? 128000,
              thinkingEnabled: s?.reasoning ?? true,
              reasoningEffort: s?.reasoning ? "medium" : "off",
              passthroughThinking: false,
            }
            setModels((c) => [
              ...c,
              {
                uiKey: createModelUiKey(),
                automaticId: true,
                id: modelPoolEntryId(entry),
                ...entry,
                supportedThinkingLevels: s?.reasoning ? ["off", "low", "medium", "high"] : ["off"],
              } as EM,
            ])
          }}
        >
          <Icon icon="lucide:plus" width="13" />
          添加
        </Button>
        <Button onClick={() => void save()} disabled={busy}>
          <Icon
            icon={busy ? "lucide:loader-circle" : "lucide:save"}
            className={busy ? "animate-spin" : ""}
            width="13"
          />{" "}
          保存
        </Button>
      </div>
    </div>
  )
}

function Field({
  label,
  description,
  children,
}: {
  label: string
  description?: string
  children: ReactNode
}) {
  const id = useId()
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-[11px] font-medium text-muted-foreground">
        {label}
      </label>
      {cloneElement(children as React.ReactElement<{ id?: string }>, { id })}
      {description ? (
        <p className="text-[10px] leading-4 text-muted-foreground/80">{description}</p>
      ) : null}
    </div>
  )
}
