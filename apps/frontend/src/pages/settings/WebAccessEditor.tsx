import { Icon } from "@iconify/react"
import { useState } from "react"
import {
  Button,
  Card,
  Checkbox,
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
  const [keys, setKeys] = useState<Record<string, string>>({})
  const [err, setErr] = useState("")
  const [busy, setBusy] = useState(false)

  const configured = new Set(
    config.providers.filter((p) => p.configured).map((p) => p.id),
  )

  function toggleProvider(id: string, on: boolean) {
    setSelected((current) =>
      on
        ? current.includes(id)
          ? current
          : [...current, id]
        : current.filter((entry) => entry !== id),
    )
  }

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
    <div className="space-y-4">
      {err ? <ErrorNotice message={err} /> : null}

      <Card className="flex items-center justify-between p-4">
        <div>
          <h2 className="text-sm font-semibold">Web 访问（搜索 / 抓取）</h2>
          <p className="text-xs text-muted-foreground">
            为 Solver 与 SubAgent 提供 web_search / fetch_content / source_check
            工具。默认关闭；工具运行在宿主进程，走宿主网络出口，SSRF
            守卫是唯一拦截。
          </p>
        </div>
        <Switch
          checked={enabled}
          onCheckedChange={setEnabled}
          aria-label="启用 Web 访问插件"
        />
      </Card>

      {enabled ? (
        <>
          <Card className="p-4">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold">Provider allowlist</h3>
              <span className="text-xs text-muted-foreground">
                仅 allowlist 内的 provider 可用
              </span>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {WEB_ACCESS_PROVIDERS.map((provider) => {
                const on = selected.includes(provider)
                return (
                  <div
                    key={provider}
                    className="flex items-center justify-between rounded-lg border border-border bg-muted/20 px-3 py-2 text-sm"
                  >
                    <span className="flex items-center gap-2">
                      <Checkbox
                        checked={on}
                        onCheckedChange={(value) =>
                          toggleProvider(provider, value === true)
                        }
                        aria-label={`启用 ${providerLabel(provider)}`}
                      />
                      <span>{providerLabel(provider)}</span>
                    </span>
                    <span className="flex items-center gap-2">
                      {configured.has(provider) ? (
                        <span className="text-[10px] text-emerald-600 dark:text-emerald-400">
                          已配置
                        </span>
                      ) : null}
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
                          configured.has(provider)
                            ? "已配置（留空不改）"
                            : "API Key"
                        }
                        className="h-7 w-40 text-xs"
                      />
                      {configured.has(provider) ? (
                        <Button
                          size="icon"
                          variant="ghost"
                          className="size-7"
                          disabled={busy}
                          onClick={() => void clearKey(provider)}
                          aria-label={`清除 ${providerLabel(provider)} 密钥`}
                        >
                          <Icon icon="lucide:trash-2" width="14" />
                        </Button>
                      ) : null}
                    </span>
                  </div>
                )
              })}
            </div>
          </Card>

          <Card className="p-4">
            <h3 className="mb-3 text-sm font-semibold">搜索工作流</h3>
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

          <Card className="p-4">
            <div className="mb-3 flex items-center justify-between">
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
