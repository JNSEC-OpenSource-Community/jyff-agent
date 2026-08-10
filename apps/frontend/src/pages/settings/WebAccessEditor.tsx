import { Icon } from "@iconify/react"
import { useState } from "react"
import {
  Badge,
  Button,
  Card,
  Combobox,
  ErrorNotice,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
  Switch,
  Textarea,
} from "../../components/index.ts"
import { apiMutation } from "../../lib/api.ts"
import { errorMessage } from "../../lib/format.ts"
import type {
  ModelConfigurationView,
  WebAccessConfigurationUpdate,
  WebAccessConfigurationView,
} from "../../types.ts"

/** web-access 支持的 provider 显式 allowlist 白名单（与后端一致）。 */
const WEB_ACCESS_PROVIDERS = [
  "openai",
  "brave",
  "parallel",
  "tinyfish",
  "search1api",
  "searchinfinity",
  "querit",
  "tavily",
  "jina",
  "searxng",
  "perplexity",
  "gemini",
  "exa",
  "serpdive",
  "kagi",
  "nekozuki",
  "ollama",
  "anysearch",
  "xai",
  "brightdata",
  "serpbase",
] as const

const PROVIDER_LABELS: Record<string, string> = {
  openai: "OpenAI",
  brave: "Brave",
  parallel: "Parallel",
  tinyfish: "TinyFish",
  search1api: "Search1API",
  searchinfinity: "Searchinfinity",
  querit: "Querit",
  tavily: "Tavily",
  jina: "Jina",
  searxng: "SearXNG",
  perplexity: "Perplexity",
  gemini: "Gemini",
  exa: "Exa",
  serpdive: "SERPdive",
  kagi: "Kagi",
  nekozuki: "Nekozuki",
  ollama: "Ollama",
  anysearch: "AnySearch",
  xai: "xAI",
  brightdata: "Bright Data",
  serpbase: "SerpBase",
}

function providerLabel(id: string): string {
  return PROVIDER_LABELS[id] ?? id
}

export function WebAccessEditor({
  config,
  modelConfiguration,
  onSaved,
}: {
  config: WebAccessConfigurationView
  modelConfiguration: ModelConfigurationView | null
  onSaved(): void
}) {
  const [enabled, setEnabled] = useState(config.enabled)
  const [selected, setSelected] = useState<string[]>(
    config.providers.filter((p) => p.enabled).map((p) => p.id),
  )
  const [workflow, setWorkflow] = useState<"none" | "auto-summary">(
    config.workflow,
  )
  const [summaryModel, setSummaryModel] = useState<string>(
    config.summaryModel
      ? `${config.summaryModel.provider}/${config.summaryModel.id}`
      : "",
  )
  const [allowRanges, setAllowRanges] = useState<string>(
    config.ssrf.allowRanges.join("\n"),
  )
  const [trustEnvProxy, setTrustEnvProxy] = useState(config.ssrf.trustEnvProxy)
  const [providerConfig, setProviderConfig] = useState<
    Record<string, Record<string, string>>
  >(config.providerConfig ?? {})
  const [keys, setKeys] = useState<Record<string, string>>({})
  const [err, setErr] = useState("")
  const [busy, setBusy] = useState(false)

  const configured = new Set(
    config.providers.filter((p) => p.configured).map((p) => p.id),
  )

  const providerOptions = WEB_ACCESS_PROVIDERS.filter(
    (p) => !selected.includes(p),
  ).map((p) => ({
    value: p,
    label: providerLabel(p),
    description: configured.has(p) ? "已配置" : undefined,
  }))

  const summaryModelOptions = (modelConfiguration?.models ?? [])
    .filter((model) => model.configured)
    .map((model) => ({
      value: `${model.provider}/${model.modelId}`,
      label: `${model.provider}/${model.modelId}`,
    }))

  async function saveConfiguration() {
    setBusy(true)
    setErr("")
    try {
      const slashIndex = summaryModel.indexOf("/")
      const summaryModelValue =
        slashIndex > 0 && slashIndex < summaryModel.length - 1
          ? {
              provider: summaryModel.slice(0, slashIndex),
              id: summaryModel.slice(slashIndex + 1),
            }
          : null
      const payload: WebAccessConfigurationUpdate = {
        enabled,
        providers: selected,
        workflow,
        summaryModel: summaryModelValue,
        ssrf: {
          allowRanges: allowRanges
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean),
          trustEnvProxy,
        },
        providerConfig,
      }
      await apiMutation("/api/global-config/web-access", "POST", payload)
      // 只保存已填写的密钥（失焦保存已独立处理；这里提交非空项）。
      for (const [provider, apiKey] of Object.entries(keys)) {
        if (!apiKey.trim()) continue
        await saveKey(provider, apiKey.trim())
      }
      setKeys({})
      onSaved()
    } catch (e) {
      setErr(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  async function saveKey(provider: string, apiKey: string | null) {
    await apiMutation(
      `/api/global-config/web-access/providers/${encodeURIComponent(provider)}/key`,
      "POST",
      { apiKey },
    )
  }

  async function clearKey(provider: string) {
    setBusy(true)
    setErr("")
    try {
      await saveKey(provider, null)
      onSaved()
    } catch (e) {
      setErr(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-5">
      {err ? <ErrorNotice message={err} /> : null}

      <Card className="flex items-center gap-3 p-5">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted text-primary">
          <Icon icon="lucide:globe" width="16" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">web-access</p>
          <p className="mt-1! truncate text-[11px] text-muted-foreground">
            为 Agent 提供联网搜索功能
          </p>
        </div>
        <Switch
          checked={enabled}
          onCheckedChange={setEnabled}
          aria-label="启用 web-access 插件"
        />
      </Card>

      {enabled ? (
        <>
          <Card className="p-5">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-sm font-semibold">Providers</h3>
              <span className="text-xs text-muted-foreground">
                {selected.length} / {WEB_ACCESS_PROVIDERS.length} 个
              </span>
            </div>
            <Combobox
              value=""
              onChange={(v) => {
                if (v && !selected.includes(v)) {
                  setSelected((c) => [...c, v])
                }
              }}
              options={providerOptions}
              placeholder="搜索并添加 provider…"
              searchPlaceholder="搜索 provider…"
              emptyText="已全部添加"
            />
            {selected.length > 0 ? (
              <div className="mt-4 space-y-3">
                {selected.map((provider) => {
                  const hasKey = configured.has(provider)
                  return (
                    <Card key={provider} className="flex flex-col p-5">
                      <div className="flex items-center gap-3">
                        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted text-primary">
                          <Icon icon="lucide:key-round" width="16" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium">
                            {providerLabel(provider)}
                          </p>
                          <p className="truncate text-[11px] text-muted-foreground">
                            {provider === "searxng"
                              ? "自托管聚合搜索（需配置 baseUrl）"
                              : provider === "nekozuki"
                                ? "本地 CTF 知识库 RAG（需配置 baseUrl）"
                                : provider === "brightdata" ||
                                    provider === "brightdata-unlocker"
                                  ? "付费代理（需配置 zone）"
                                  : "搜索 / 抓取 provider"}
                          </p>
                        </div>
                        <Badge
                          tone={hasKey ? "positive" : "neutral"}
                          className="shrink-0 text-[10px]"
                        >
                          {hasKey ? "已配置" : "未配置"}
                        </Badge>
                      </div>

                      <div className="mt-4 flex items-center justify-between gap-3">
                        {provider === "nekozuki" ? (
                          <Input
                            type="text"
                            value={providerConfig.nekozuki?.baseUrl ?? ""}
                            onChange={(e) =>
                              setProviderConfig((pc) => ({
                                ...pc,
                                nekozuki: {
                                  ...pc.nekozuki,
                                  baseUrl: e.target.value,
                                },
                              }))
                            }
                            placeholder="http://localhost:8000"
                            className="h-8 flex-1 text-xs font-mono"
                          />
                        ) : (
                          <Input
                            type="password"
                            value={keys[provider] ?? ""}
                            onChange={(e) =>
                              setKeys((k) => ({
                                ...k,
                                [provider]: e.target.value,
                              }))
                            }
                            onBlur={() => {
                              const value = keys[provider] ?? ""
                              if (!value.trim()) return
                              void saveKey(provider, value.trim())
                                .then(() => {
                                  setKeys((k) => {
                                    const next = { ...k }
                                    delete next[provider]
                                    return next
                                  })
                                  onSaved()
                                })
                                .catch((e) => setErr(errorMessage(e)))
                            }}
                            placeholder={
                              hasKey ? "已配置（留空不改）" : "API Key"
                            }
                            className="h-8 flex-1 text-xs"
                          />
                        )}
                        {hasKey ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy}
                            onClick={() => void clearKey(provider)}
                          >
                            清除
                          </Button>
                        ) : null}
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            setSelected((c) =>
                              c.filter((entry) => entry !== provider),
                            )
                          }
                        >
                          移除
                        </Button>
                      </div>
                    </Card>
                  )
                })}
              </div>
            ) : null}
          </Card>

          <Card className="p-5">
            <div className="mb-4">
              <h3 className="text-sm font-semibold">搜索工作流</h3>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1">
                <Label>摘要模式</Label>
                <Select
                  value={workflow}
                  onValueChange={(value) =>
                    setWorkflow(value as "none" | "auto-summary")
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">none（无摘要）</SelectItem>
                    <SelectItem value="auto-summary">auto-summary</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>摘要模型</Label>
                <Select
                  value={summaryModel}
                  onValueChange={setSummaryModel}
                  disabled={summaryModelOptions.length === 0}
                >
                  <SelectTrigger>
                    <SelectValue
                      placeholder={
                        summaryModelOptions.length === 0
                          ? "模型池无可配置模型"
                          : "选择模型池中的模型"
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {summaryModelOptions.map((model) => (
                      <SelectItem key={model.value} value={model.value}>
                        {model.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </Card>

          <Card className="p-5">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-sm font-semibold">SSRF / 网络策略</h3>
              <div className="flex items-center gap-2">
                <Label className="text-xs">信任环境代理</Label>
                <Switch
                  checked={trustEnvProxy}
                  onCheckedChange={setTrustEnvProxy}
                  aria-label="信任环境代理"
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">
                allowRanges（每行一个 CIDR，默认拦截私网地址）
              </Label>
              <Textarea
                value={allowRanges}
                onChange={(e) => setAllowRanges(e.target.value)}
                placeholder="例如：10.0.0.0/8"
                className="min-h-20 font-mono text-xs"
              />
            </div>
          </Card>
        </>
      ) : null}

      <div className="flex justify-end">
        <Button
          variant="primary"
          onClick={() => void saveConfiguration()}
          disabled={busy}
        >
          {busy ? <Spinner className="size-4" /> : null}
          保存
        </Button>
      </div>
    </div>
  )
}
