import { Icon } from "@iconify/react"
import { type FormEvent, useCallback, useEffect, useState } from "react"
import { useApp } from "../../app/AppProvider.tsx"
import {
  Badge,
  Button,
  Card,
  Combobox,
  ErrorNotice,
  Input,
  Spinner,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "../../components/index.ts"
import { apiMutation, apiRequest } from "../../lib/api.ts"
import { errorMessage } from "../../lib/format.ts"
import type {
  CustomModelProviderApi,
  ModelAuthenticationView,
  ModelConfigurationView,
} from "../../types.ts"
import { ModelPoolEditor } from "./ModelPoolEditor.tsx"
import { ProviderCredentialCard } from "./ProviderCredentialCard.tsx"

interface Cfg {
  authentication: { enabled: boolean; username: string | null }
  modelConfiguration: ModelConfigurationView | null
  modelAuthentication: ModelAuthenticationView | null
}

export function GlobalSettingsPage() {
  const { refreshAuth } = useApp()
  const [g, setG] = useState<Cfg | null>(null)
  const [uname, setUname] = useState("")
  const [pw, setPw] = useState("")
  const [on, setOn] = useState(false)
  const [err, setErr] = useState("")
  const [busy, setBusy] = useState(false)
  const [importing, setImporting] = useState(false)
  const [providerChoice, setProviderChoice] = useState("")
  const [customName, setCustomName] = useState("")
  const [customApi, setCustomApi] =
    useState<CustomModelProviderApi>("openai-completions")
  const [customBaseUrl, setCustomBaseUrl] = useState("")
  const [customKey, setCustomKey] = useState("")

  const load = useCallback(async () => {
    const c = await apiRequest<Cfg>("/api/global-config")
    setG(c)
    setUname(c.authentication.username ?? "")
    setOn(c.authentication.enabled)
  }, [])
  useEffect(() => {
    void load().catch((e) => setErr(errorMessage(e)))
  }, [load])

  const saveAuth = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setErr("")
    try {
      await apiMutation("/api/global-config/authentication", "POST", {
        enabled: on,
        ...(on ? { username: uname, ...(pw && { password: pw }) } : {}),
      })
      setPw("")
      await refreshAuth()
      await load()
    } catch (e) {
      setErr(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const doImport = async (src: { json: string } | "file") => {
    setImporting(true)
    setErr("")
    try {
      await apiMutation(
        src === "file"
          ? "/api/model-auth/import-file"
          : "/api/model-auth/import",
        "POST",
        src === "file" ? {} : src,
      )
      await load()
    } catch (e) {
      setErr(errorMessage(e))
    } finally {
      setImporting(false)
    }
  }

  const addCustomProvider = async () => {
    setBusy(true)
    setErr("")
    try {
      await apiMutation("/api/model-config/providers", "POST", {
        name: customName,
        api: customApi,
        baseUrl: customBaseUrl,
        apiKey: customKey,
      })
      setCustomName("")
      setCustomBaseUrl("")
      setCustomKey("")
      await load()
    } catch (e) {
      setErr(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const removeCustomProvider = async (providerId: string) => {
    setBusy(true)
    setErr("")
    try {
      await apiMutation(
        `/api/model-config/providers/${encodeURIComponent(providerId)}`,
        "DELETE",
        {},
      )
      await load()
    } catch (e) {
      setErr(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  if (!g) return <Spinner label="加载全局配置" />
  const auth = g.modelAuthentication
  const configuredProviders = auth?.providers.filter((p) => p.configured) ?? []
  const subscriptionOptions =
    auth?.providers.flatMap((provider) => {
      const method = provider.methods.find((candidate) =>
        candidate.id.startsWith("oauth_"),
      )
      return method
        ? [
            {
              value: `${provider.id}:${method.id}`,
              label: provider.name,
              description: method.label,
            },
          ]
        : []
    }) ?? []
  const keyOptions =
    auth?.providers.flatMap((provider) => {
      const method = provider.methods.find(
        (candidate) => candidate.id === "api_key",
      )
      return method
        ? [
            {
              value: `${provider.id}:${method.id}`,
              label: provider.name,
              description: method.description,
            },
          ]
        : []
    }) ?? []
  const [chosenProviderId, chosenMethodId] = providerChoice.split(":")
  const chosenProvider = auth?.providers.find(
    (provider) => provider.id === chosenProviderId,
  )

  return (
    <div className="page-container">
      <header className="mb-8">
        <p className="hero-eyebrow text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">
          Global Config
        </p>
        <h1 className="hero-title mt-3 text-3xl font-bold tracking-tight">
          全局配置
        </h1>
        <p className="hero-desc mt-3 max-w-2xl text-sm text-muted-foreground">
          Provider 凭据与模型池全局共享，角色绑定在各场比赛中独立配置。
        </p>
      </header>

      {err ? <ErrorNotice message={err} className="mb-6" /> : null}

      <Tabs defaultValue="providers">
        <TabsList className="mb-6">
          <TabsTrigger value="providers">Provider</TabsTrigger>
          <TabsTrigger value="models">模型池</TabsTrigger>
          <TabsTrigger value="security">登录</TabsTrigger>
        </TabsList>

        <TabsContent value="providers" className="space-y-5">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">模型供应商</h2>
              <p className="text-sm text-muted-foreground">
                凭据写入 Secret Store。
              </p>
            </div>
            <Badge className="text-[10px]">
              {configuredProviders.length} 已连接
            </Badge>
          </div>

          <section>
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold">已有供应商</h3>
              <span className="text-xs text-muted-foreground">
                {configuredProviders.length +
                  (g.modelConfiguration?.customProviders.length ?? 0)}{" "}
                个
              </span>
            </div>
            <div className="space-y-3">
              {configuredProviders.map((p) => (
                <ProviderCredentialCard
                  key={p.id}
                  provider={p}
                  onRefresh={load}
                />
              ))}
              {g.modelConfiguration?.customProviders.map((p) => (
                <Card key={p.id} className="flex items-center gap-3 p-4">
                  <span className="flex size-9 items-center justify-center rounded-lg bg-muted text-primary">
                    <Icon icon="lucide:waypoints" width="16" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{p.name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {p.api} · {p.baseUrl}
                    </p>
                  </div>
                  <Badge tone="positive" className="text-[10px]">
                    已连接
                  </Badge>
                  <Button
                    size="icon"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void removeCustomProvider(p.id)}
                    aria-label={`删除 ${p.name}`}
                  >
                    <Icon icon="lucide:trash-2" width="14" />
                  </Button>
                </Card>
              ))}
              {configuredProviders.length +
                (g.modelConfiguration?.customProviders.length ?? 0) ===
              0 ? (
                <div className="border-y border-border px-1 py-8 text-sm text-muted-foreground">
                  尚未添加供应商。
                </div>
              ) : null}
            </div>
          </section>

          {auth ? (
            <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div className="flex items-center gap-3">
                <span className="flex size-9 items-center justify-center rounded-lg border border-border bg-muted text-muted-foreground">
                  <Icon icon="lucide:file-key-2" width="16" />
                </span>
                <div>
                  <p className="text-sm font-medium">导入凭据</p>
                  <p className="text-xs text-muted-foreground">
                    兼容 Pi · Codex CLI · Claude Code auth JSON
                  </p>
                </div>
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" asChild>
                  <label className="cursor-pointer">
                    <Icon icon="lucide:upload" width="13" />
                    上传
                    <input
                      className="sr-only"
                      type="file"
                      accept=".json"
                      disabled={importing}
                      onChange={(e) => {
                        const f = e.target.files?.[0]
                        if (f) void f.text().then((j) => doImport({ json: j }))
                        e.target.value = ""
                      }}
                    />
                  </label>
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={importing || !auth.importFileAvailable}
                  onClick={() => void doImport("file")}
                >
                  <Icon icon="lucide:folder-key" width="13" />
                  {auth.importPath}
                </Button>
              </div>
            </Card>
          ) : null}

          {auth ? (
            <Card className="p-5">
              <div className="mb-4">
                <h3 className="text-sm font-semibold">添加供应商</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  订阅账号使用官方登录；按量计费或兼容端点使用 API Key。
                </p>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <ProviderPicker
                  icon="lucide:badge-check"
                  label="Subscription 登录"
                  description="Codex、Claude 等订阅账号"
                  value={
                    subscriptionOptions.some(
                      (option) => option.value === providerChoice,
                    )
                      ? providerChoice
                      : ""
                  }
                  options={subscriptionOptions}
                  onChange={setProviderChoice}
                />
                <ProviderPicker
                  icon="lucide:key-round"
                  label="API Key"
                  description="官方 API 与兼容供应商"
                  value={
                    keyOptions.some((option) => option.value === providerChoice)
                      ? providerChoice
                      : ""
                  }
                  options={keyOptions}
                  onChange={setProviderChoice}
                />
              </div>
              <div className="mt-5 border-t border-border pt-5">
                <div className="mb-3 flex items-center gap-2">
                  <Icon
                    icon="lucide:waypoints"
                    width="15"
                    className="text-primary"
                  />
                  <h4 className="text-sm font-medium">自定义兼容 Provider</h4>
                </div>
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                  <Input
                    value={customName}
                    onChange={(e) => setCustomName(e.target.value)}
                    placeholder="供应商名称"
                  />
                  <Combobox
                    value={customApi}
                    onChange={(value) =>
                      setCustomApi(value as CustomModelProviderApi)
                    }
                    options={[
                      {
                        value: "openai-completions",
                        label: "OpenAI Completions",
                      },
                      { value: "openai-responses", label: "OpenAI Responses" },
                      {
                        value: "anthropic-messages",
                        label: "Anthropic Messages",
                      },
                    ]}
                    compactOptions
                  />
                  <Input
                    type="url"
                    value={customBaseUrl}
                    onChange={(e) => setCustomBaseUrl(e.target.value)}
                    placeholder="Base URL"
                  />
                  <Input
                    type="password"
                    value={customKey}
                    onChange={(e) => setCustomKey(e.target.value)}
                    placeholder="API Key"
                  />
                </div>
                <div className="mt-3 flex justify-end">
                  <Button
                    size="sm"
                    disabled={
                      busy ||
                      !customName.trim() ||
                      !customBaseUrl.trim() ||
                      !customKey.trim()
                    }
                    onClick={() => void addCustomProvider()}
                  >
                    <Icon icon="lucide:plus" width="13" /> 添加自定义供应商
                  </Button>
                </div>
              </div>
            </Card>
          ) : null}

          {chosenProvider && !chosenProvider.configured ? (
            <ProviderCredentialCard
              key={providerChoice}
              provider={chosenProvider}
              initialMethod={chosenMethodId}
              onCancel={() => setProviderChoice("")}
              onRefresh={async () => {
                setProviderChoice("")
                await load()
              }}
            />
          ) : null}
        </TabsContent>

        <TabsContent value="models" className="space-y-5">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">模型池</h2>
              <p className="text-sm text-muted-foreground">
                管理可用模型，支持自动补全 Provider 目录。
              </p>
            </div>
            <Badge className="text-[10px]">
              {g.modelConfiguration?.models.length ?? 0} 个
            </Badge>
          </div>
          {g.modelConfiguration && auth ? (
            <ModelPoolEditor
              configuration={g.modelConfiguration}
              authentication={auth}
              onSaved={(n) =>
                setG((c) => (c ? { ...c, modelConfiguration: n } : c))
              }
            />
          ) : (
            <ErrorNotice message="模型配置不可用" />
          )}
        </TabsContent>

        <TabsContent value="security" className="space-y-5">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">访问控制</h2>
              <p className="text-sm text-muted-foreground">
                启用后要求 HttpOnly 会话 Cookie 认证。
              </p>
            </div>
            <Badge tone={on ? "positive" : "warning"} className="text-[10px]">
              {on ? "启用" : "禁用"}
            </Badge>
          </div>
          <Card className="w-full overflow-hidden p-0">
            <form onSubmit={(e) => void saveAuth(e)}>
              <div className="flex items-center justify-between gap-6 px-6 py-5">
                <div>
                  <p className="text-sm font-medium">WebUI 登录</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    通过 SameSite=Strict、HttpOnly 会话 Cookie 保护控制台。
                  </p>
                </div>
                <Switch
                  checked={on}
                  onCheckedChange={setOn}
                  aria-label="启用 WebUI 登录"
                />
              </div>
              {on ? (
                <div className="grid gap-4 border-t border-border bg-muted/20 px-6 py-5 sm:grid-cols-2">
                  <div>
                    <label
                      htmlFor="auth-username"
                      className="mb-1.5 block text-xs font-medium text-muted-foreground"
                    >
                      用户名
                    </label>
                    <Input
                      id="auth-username"
                      value={uname}
                      onChange={(e) => setUname(e.target.value)}
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="auth-password"
                      className="mb-1.5 block text-xs font-medium text-muted-foreground"
                    >
                      {g.authentication.enabled ? "新密码（可选）" : "密码"}
                    </label>
                    <Input
                      id="auth-password"
                      type="password"
                      value={pw}
                      onChange={(e) => setPw(e.target.value)}
                    />
                  </div>
                </div>
              ) : null}
              <div className="flex justify-end border-t border-border px-6 py-4">
                <Button
                  type="submit"
                  disabled={
                    busy ||
                    (on && (!uname || (!g.authentication.enabled && !pw)))
                  }
                >
                  <Icon icon="lucide:shield-check" width="14" />
                  保存
                </Button>
              </div>
            </form>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}

function ProviderPicker({
  icon,
  label,
  description,
  value,
  options,
  onChange,
}: {
  icon: string
  label: string
  description: string
  value: string
  options: Array<{ value: string; label: string; description?: string }>
  onChange(value: string): void
}) {
  return (
    <div className="rounded-lg border border-border bg-background/30 p-4">
      <div className="mb-3 flex items-start gap-3">
        <span className="flex size-8 items-center justify-center rounded-md bg-muted text-primary">
          <Icon icon={icon} width="15" />
        </span>
        <div>
          <p className="text-sm font-medium">{label}</p>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
      </div>
      <Combobox
        value={value}
        onChange={onChange}
        options={options}
        placeholder="选择供应商…"
        searchPlaceholder="搜索供应商…"
        emptyText="没有可用供应商"
        compactOptions
      />
    </div>
  )
}
