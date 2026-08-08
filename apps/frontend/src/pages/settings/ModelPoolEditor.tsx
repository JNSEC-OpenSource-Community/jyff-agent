import { Icon } from "@iconify/react"
import { cloneElement, type ReactNode, useId, useMemo, useState } from "react"
import {
  Button,
  Card,
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
import { apiMutation } from "../../lib/api.ts"
import { errorMessage } from "../../lib/format.ts"
import type {
  ModelAuthenticationView,
  ModelConfigurationUpdate,
  ModelConfigurationView,
  ModelPoolEntryUpdate,
} from "../../types.ts"

interface EM extends ModelPoolEntryUpdate {
  uiKey: string
  apiKeyConfigured: boolean
  supportedThinkingLevels: string[]
}

const ed = (m: ModelConfigurationView["models"][number]): EM => ({
  uiKey: crypto.randomUUID(),
  id: m.id,
  provider: m.provider,
  modelId: m.modelId,
  baseUrl: m.baseUrl,
  contextWindow: m.contextWindow,
  thinkingEnabled: m.thinkingEnabled,
  reasoningEffort: m.reasoningEffort,
  passthroughThinking: m.passthroughThinking,
  apiKeyConfigured: m.apiKeyConfigured,
  supportedThinkingLevels: m.supportedThinkingLevels,
})

export function ModelPoolEditor({
  configuration,
  authentication,
  onSaved,
}: {
  configuration: ModelConfigurationView
  authentication: ModelAuthenticationView
  onSaved(n: ModelConfigurationView): void
}) {
  const [models, setModels] = useState<EM[]>(configuration.models.map(ed))
  const [err, setErr] = useState("")
  const [busy, setBusy] = useState(false)

  const providerOptions = useMemo(
    () =>
      authentication.providers.map((p) => ({
        value: p.id,
        label: p.name,
        description: p.configured ? "已认证" : "未连接",
        disabled: false,
      })),
    [authentication.providers],
  )

  function up(i: number, p: Partial<EM>) {
    setModels((c) => c.map((m, j) => (j === i ? { ...m, ...p } : m)))
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
          ({
            uiKey: _,
            apiKeyConfigured: __,
            supportedThinkingLevels: ___,
            ...m
          }) => m,
        ),
        solverModelId: configuration.solverModelId,
        tldrModelId: configuration.tldrModelId,
        subagentModels: configuration.subagentModels,
      }
      const r = await apiMutation<{ configuration: ModelConfigurationView }>(
        "/api/model-config",
        "POST",
        payload,
      )
      setModels(r.configuration.models.map(ed))
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
      {models.map((m, i) => {
        const prov = authentication.providers.find((p) => p.id === m.provider)
        return (
          <Card key={m.uiKey} className="overflow-hidden p-0">
            <div className="flex items-center gap-3 border-b border-border bg-muted px-4 py-2.5">
              <span className="flex size-6 items-center justify-center rounded-md bg-muted font-mono text-[11px] font-bold tabular-nums text-muted-foreground">
                {String(i + 1).padStart(2, "0")}
              </span>
              <Input
                aria-label="模型 ID"
                value={m.id}
                onChange={(e) => up(i, { id: e.target.value })}
                className="h-7 flex-1 border-0 bg-transparent text-sm font-medium shadow-none focus-visible:ring-0"
              />
              <Button
                size="icon"
                variant="ghost"
                className="size-7 text-muted-foreground hover:text-danger"
                onClick={() => setModels((c) => c.filter((_, j) => j !== i))}
              >
                <Icon icon="lucide:trash-2" width="13" />
              </Button>
            </div>
            <div className="grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="供应商">
                <Combobox
                  value={m.provider}
                  onChange={(v) => {
                    const newProv = authentication.providers.find(
                      (p) => p.id === v,
                    )
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
              </Field>
              <Field
                label="Base URL（可选）"
                description="留空时使用供应商官方端点；仅兼容网关或中转服务需要填写。"
              >
                <Input
                  type="url"
                  value={m.baseUrl}
                  onChange={(e) => up(i, { baseUrl: e.target.value })}
                  placeholder="默认"
                  className="h-8 text-xs"
                />
              </Field>
              <Field
                label="上下文窗口"
                description="模型可接收的最大 token 数。"
              >
                <Input
                  type="number"
                  min="1"
                  value={m.contextWindow}
                  onChange={(e) =>
                    up(i, { contextWindow: Number(e.target.value) })
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
                    {[
                      "off",
                      "minimal",
                      "low",
                      "medium",
                      "high",
                      "xhigh",
                      "max",
                    ].map((l) => (
                      <SelectItem value={l} key={l}>
                        {l}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field
                label="模型专用 API Key（可选）"
                description="留空时继承供应商凭据。"
              >
                <Input
                  type="password"
                  value={m.apiKey ?? ""}
                  onChange={(e) =>
                    up(i, { apiKey: e.target.value, clearApiKey: false })
                  }
                  placeholder={m.apiKeyConfigured ? "已配置" : "继承"}
                  className="h-8 text-xs"
                />
              </Field>
            </div>
            <div className="flex flex-wrap gap-4 border-t border-border bg-muted/30 px-4 py-2.5">
              <label
                htmlFor={`${m.uiKey}-thinking`}
                className="flex items-center gap-2 text-xs text-muted-foreground"
              >
                <Checkbox
                  id={`${m.uiKey}-thinking`}
                  checked={m.thinkingEnabled}
                  onCheckedChange={(c) =>
                    up(i, { thinkingEnabled: c === true })
                  }
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
                  onCheckedChange={(c) =>
                    up(i, { passthroughThinking: c === true })
                  }
                />
                向自定义端点透传推理档位
              </label>
              {m.apiKeyConfigured ? (
                <label
                  htmlFor={`${m.uiKey}-clear`}
                  className="flex items-center gap-2 text-xs text-muted-foreground"
                >
                  <Checkbox
                    id={`${m.uiKey}-clear`}
                    checked={m.clearApiKey === true}
                    onCheckedChange={(c) =>
                      up(i, { clearApiKey: c === true, apiKey: "" })
                    }
                  />
                  删除模型专用 API Key
                </label>
              ) : null}
            </div>
          </Card>
        )
      })}
      <div className="flex justify-end gap-3">
        <Button
          variant="secondary"
          onClick={() => {
            const p =
              authentication.providers.find((x) => x.id === "openai") ??
              authentication.providers[0]
            const s = p?.models[0]
            setModels((c) => [
              ...c,
              {
                uiKey: crypto.randomUUID(),
                id: `m-${c.length + 1}`,
                provider: p?.id ?? "openai",
                modelId: s?.id ?? "",
                baseUrl: "",
                contextWindow: s?.contextWindow ?? 128000,
                thinkingEnabled: s?.reasoning ?? true,
                reasoningEffort: s?.reasoning ? "medium" : "off",
                passthroughThinking: false,
                apiKeyConfigured: false,
                supportedThinkingLevels: s?.reasoning
                  ? ["off", "low", "medium", "high"]
                  : ["off"],
              } as EM,
            ])
          }}
        >
          <Icon icon="lucide:plus" width="13" />
          添加
        </Button>
        <Button
          onClick={() => void save()}
          disabled={busy || models.length === 0}
        >
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
      <label
        htmlFor={id}
        className="block text-[11px] font-medium text-muted-foreground"
      >
        {label}
      </label>
      {cloneElement(children as React.ReactElement<{ id?: string }>, { id })}
      {description ? (
        <p className="text-[10px] leading-4 text-muted-foreground/80">
          {description}
        </p>
      ) : null}
    </div>
  )
}
