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
  PageHeader,
  SettingsSection,
  Spinner,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "../../components/index.ts"
import { apiMutation, apiRequest } from "../../lib/api.ts"
import { errorMessage } from "../../lib/format.ts"
import { cn } from "../../lib/utils.ts"
import type {
  CustomModelProviderApi,
  CustomModelProviderView,
  ModelAuthenticationView,
  ModelConfigurationView,
  WebAccessConfigurationView,
} from "../../types.ts"
import { ModelPoolEditor } from "./ModelPoolEditor.tsx"
import { ProviderCredentialCard } from "./ProviderCredentialCard.tsx"
import { WebAccessEditor } from "./WebAccessEditor.tsx"

interface Cfg {
  authentication: { enabled: boolean; username: string | null }
  modelConfiguration: ModelConfigurationView | null
  modelAuthentication: ModelAuthenticationView | null
  webAccess: WebAccessConfigurationView | null
}

type ProviderSetupMode = "subscription" | "api-key" | "custom"

export function GlobalSettingsPage() {
  const { refreshAuth } = useApp()
  const [g, setG] = useState<Cfg | null>(null)
  const [uname, setUname] = useState("")
  const [pw, setPw] = useState("")
  const [on, setOn] = useState(false)
  const [err, setErr] = useState("")
  const [busy, setBusy] = useState(false)
  const [importing, setImporting] = useState(false)
  const [setupMode, setSetupMode] = useState<ProviderSetupMode | null>(null)
  const [providerChoice, setProviderChoice] = useState("")
  const [editingProviderId, setEditingProviderId] = useState<string | null>(null)
  const [editingCustomId, setEditingCustomId] = useState<string | null>(null)
  const [customName, setCustomName] = useState("")
  const [customApi, setCustomApi] = useState<CustomModelProviderApi>("openai-completions")
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
        src === "file" ? "/api/model-auth/import-file" : "/api/model-auth/import",
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
      setSetupMode(null)
      await load()
    } catch (e) {
      setErr(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const editCustomProvider = (provider: CustomModelProviderView) => {
    setSetupMode(null)
    setProviderChoice("")
    setEditingProviderId(null)
    setEditingCustomId(provider.id)
    setCustomName(provider.name)
    setCustomApi(provider.api)
    setCustomBaseUrl(provider.baseUrl)
    setCustomKey("")
  }

  const updateCustomProvider = async () => {
    if (!editingCustomId) return
    setBusy(true)
    setErr("")
    try {
      await apiMutation(
        `/api/model-config/providers/${encodeURIComponent(editingCustomId)}`,
        "PUT",
        {
          name: customName,
          api: customApi,
          baseUrl: customBaseUrl,
          ...(customKey.trim() ? { apiKey: customKey } : {}),
        },
      )
      setEditingCustomId(null)
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
      if (provider.configured) return []
      const method = provider.methods.find((candidate) => candidate.id.startsWith("oauth_"))
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
      if (provider.configured) return []
      const method = provider.methods.find((candidate) => candidate.id === "api_key")
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
  const chosenProvider = auth?.providers.find((provider) => provider.id === chosenProviderId)

  return (
    <div className="page-container">
      <PageHeader
        eyebrow="系统设置"
        title="全局配置"
        description="管理模型供应商、共享模型和 WebUI 登录。"
      />

      {err ? <ErrorNotice message={err} className="mb-6" /> : null}

      <Tabs defaultValue="providers">
        <TabsList className="mb-4">
          <TabsTrigger value="providers">供应商</TabsTrigger>
          <TabsTrigger value="models">模型</TabsTrigger>
          <TabsTrigger value="plugins">插件</TabsTrigger>
          <TabsTrigger value="security">登录</TabsTrigger>
        </TabsList>

        <TabsContent value="providers">
          <SettingsSection
            title="模型供应商"
            description="连接订阅账号、官方 API 或兼容端点。凭据只写入 Secret Store。"
            meta={
              <Badge>
                {configuredProviders.length + (g.modelConfiguration?.customProviders.length ?? 0)}{" "}
                已连接
              </Badge>
            }
          >
            <div className="space-y-4">
              <section>
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="text-sm font-semibold">已有供应商</h3>
                  <span className="text-xs text-muted-foreground">
                    {configuredProviders.length +
                      (g.modelConfiguration?.customProviders.length ?? 0)}{" "}
                    个
                  </span>
                </div>
                <ul className="overflow-hidden rounded-md border border-border bg-card">
                  {configuredProviders.map((p) => (
                    <li key={p.id} className="border-b border-border last:border-b-0">
                      <div className="flex min-h-16 items-center gap-3 px-4 py-3">
                        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-primary">
                          <Icon icon="lucide:key-round" width="16" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">{p.name}</p>
                          <p className="truncate text-xs text-muted-foreground">
                            {p.credentialType === "oauth" ? "OAuth" : "API Key"} · {p.description}
                          </p>
                        </div>
                        <Badge tone="positive" className="hidden sm:inline-flex">
                          已连接
                        </Badge>
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-expanded={editingProviderId === p.id}
                          onClick={() => {
                            setSetupMode(null)
                            setProviderChoice("")
                            setEditingCustomId(null)
                            setEditingProviderId((current) => (current === p.id ? null : p.id))
                          }}
                        >
                          <Icon icon="lucide:pencil" width="13" /> 编辑
                        </Button>
                      </div>
                      {editingProviderId === p.id ? (
                        <div className="border-t border-border bg-background/35 p-3 sm:p-4">
                          <ProviderCredentialCard
                            provider={p}
                            editingConfigured
                            onCancel={() => setEditingProviderId(null)}
                            onRefresh={async () => {
                              setEditingProviderId(null)
                              await load()
                            }}
                          />
                        </div>
                      ) : null}
                    </li>
                  ))}
                  {g.modelConfiguration?.customProviders.map((p) => (
                    <li key={p.id} className="border-b border-border last:border-b-0">
                      <div className="flex min-h-16 items-center gap-3 px-4 py-3">
                        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-primary">
                          <Icon icon="lucide:waypoints" width="16" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">{p.name}</p>
                          <p className="truncate text-xs text-muted-foreground">
                            {p.api} · {p.baseUrl}
                          </p>
                        </div>
                        <Badge tone="positive" className="hidden sm:inline-flex">
                          已连接
                        </Badge>
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-expanded={editingCustomId === p.id}
                          onClick={() => editCustomProvider(p)}
                        >
                          <Icon icon="lucide:pencil" width="13" /> 编辑
                        </Button>
                      </div>
                      {editingCustomId === p.id ? (
                        <div className="border-t border-border bg-background/35 p-4">
                          <CustomProviderForm
                            name={customName}
                            api={customApi}
                            baseUrl={customBaseUrl}
                            apiKey={customKey}
                            apiKeyPlaceholder="留空则保留当前 API Key"
                            submitLabel="保存修改"
                            busy={busy}
                            onNameChange={setCustomName}
                            onApiChange={setCustomApi}
                            onBaseUrlChange={setCustomBaseUrl}
                            onApiKeyChange={setCustomKey}
                            onCancel={() => setEditingCustomId(null)}
                            onDelete={() => void removeCustomProvider(p.id)}
                            onSubmit={() => void updateCustomProvider()}
                          />
                        </div>
                      ) : null}
                    </li>
                  ))}
                  {configuredProviders.length +
                    (g.modelConfiguration?.customProviders.length ?? 0) ===
                  0 ? (
                    <li className="px-4 py-8 text-sm text-muted-foreground">尚未添加供应商。</li>
                  ) : null}
                </ul>
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
                <section className="border-t border-border pt-5">
                  <div className="mb-4">
                    <h3 className="text-sm font-semibold">添加供应商</h3>
                    <p className="mt-1! text-xs text-muted-foreground">
                      订阅账号使用官方登录；按量计费或兼容端点使用 API Key。
                    </p>
                  </div>
                  <div className="divide-y divide-border overflow-hidden rounded-md border border-border sm:grid sm:grid-cols-3 sm:divide-x sm:divide-y-0">
                    <ProviderSetupOption
                      icon="lucide:badge-check"
                      label="Subscription 登录"
                      description="Codex、Claude 等订阅账号"
                      selected={setupMode === "subscription"}
                      onClick={() => {
                        setSetupMode("subscription")
                        setProviderChoice("")
                      }}
                    />
                    <ProviderSetupOption
                      icon="lucide:key-round"
                      label="配置 API Key"
                      description="连接官方 API 供应商"
                      selected={setupMode === "api-key"}
                      onClick={() => {
                        setSetupMode("api-key")
                        setProviderChoice("")
                      }}
                    />
                    <ProviderSetupOption
                      icon="lucide:waypoints"
                      label="添加自定义 Provider"
                      description="连接兼容协议与中转端点"
                      selected={setupMode === "custom"}
                      onClick={() => {
                        setSetupMode("custom")
                        setProviderChoice("")
                        setCustomName("")
                        setCustomApi("openai-completions")
                        setCustomBaseUrl("")
                        setCustomKey("")
                      }}
                    />
                  </div>
                  {setupMode ? (
                    <div className="mt-5 border-t border-border pt-5">
                      {setupMode === "custom" ? (
                        <CustomProviderForm
                          name={customName}
                          api={customApi}
                          baseUrl={customBaseUrl}
                          apiKey={customKey}
                          apiKeyPlaceholder="API Key"
                          submitLabel="添加自定义供应商"
                          busy={busy}
                          requireApiKey
                          onNameChange={setCustomName}
                          onApiChange={setCustomApi}
                          onBaseUrlChange={setCustomBaseUrl}
                          onApiKeyChange={setCustomKey}
                          onCancel={() => setSetupMode(null)}
                          onSubmit={() => void addCustomProvider()}
                        />
                      ) : (
                        <ProviderPicker
                          label={
                            setupMode === "subscription" ? "选择订阅供应商" : "选择 API 供应商"
                          }
                          value={providerChoice}
                          options={setupMode === "subscription" ? subscriptionOptions : keyOptions}
                          onChange={setProviderChoice}
                        />
                      )}
                      {chosenProvider && !chosenProvider.configured && setupMode !== "custom" ? (
                        <div className="mt-4">
                          <ProviderCredentialCard
                            key={providerChoice}
                            provider={chosenProvider}
                            initialMethod={chosenMethodId}
                            onCancel={() => setProviderChoice("")}
                            onRefresh={async () => {
                              setProviderChoice("")
                              setSetupMode(null)
                              await load()
                            }}
                          />
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </section>
              ) : null}
            </div>
          </SettingsSection>
        </TabsContent>

        <TabsContent value="models">
          <SettingsSection
            title="模型配置"
            description="维护共享模型池，并指定 Clanker Father 使用的模型。"
            meta={<Badge>{g.modelConfiguration?.models.length ?? 0} 个</Badge>}
          >
            {g.modelConfiguration && auth ? (
              <ModelPoolEditor
                configuration={g.modelConfiguration}
                authentication={auth}
                onSaved={(n) => setG((c) => (c ? { ...c, modelConfiguration: n } : c))}
              />
            ) : (
              <ErrorNotice message="模型配置不可用" />
            )}
          </SettingsSection>
        </TabsContent>

        <TabsContent value="plugins">
          <SettingsSection title="插件" description="管理为 Agent 扩展能力的全局插件。">
            {g.webAccess ? (
              <WebAccessEditor
                config={g.webAccess}
                modelConfiguration={g.modelConfiguration}
                onSaved={load}
              />
            ) : (
              <ErrorNotice message="当前控制面不支持 web-access 插件" />
            )}
          </SettingsSection>
        </TabsContent>

        <TabsContent value="security">
          <SettingsSection
            title="访问控制"
            description="启用后，访问 WebUI 必须通过用户名和密码登录。"
            meta={<Badge tone={on ? "positive" : "warning"}>{on ? "已启用" : "未启用"}</Badge>}
          >
            <Card className="w-full overflow-hidden p-0">
              <form onSubmit={(e) => void saveAuth(e)}>
                <div className="flex items-center justify-between gap-4 px-4 py-4">
                  <div>
                    <p className="text-sm font-medium">WebUI 登录</p>
                    <p className="mt-1! text-xs text-muted-foreground">
                      通过 SameSite=Strict、HttpOnly 会话 Cookie 保护控制台。
                    </p>
                  </div>
                  <Switch checked={on} onCheckedChange={setOn} aria-label="启用 WebUI 登录" />
                </div>
                {on ? (
                  <div className="grid gap-4 border-t border-border bg-muted/20 px-4 py-4 sm:grid-cols-2">
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
                <div className="flex justify-end border-t border-border px-4 py-3">
                  <Button
                    type="submit"
                    disabled={busy || (on && (!uname || (!g.authentication.enabled && !pw)))}
                  >
                    <Icon icon="lucide:shield-check" width="14" />
                    保存
                  </Button>
                </div>
              </form>
            </Card>
          </SettingsSection>
        </TabsContent>
      </Tabs>
    </div>
  )
}

function ProviderPicker({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: string
  options: Array<{ value: string; label: string; description?: string }>
  onChange: (value: string) => void
}) {
  return (
    <div className="max-w-xl">
      <p className="mb-2! text-xs font-medium text-muted-foreground">{label}</p>
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

function ProviderSetupOption({
  icon,
  label,
  description,
  selected,
  onClick,
}: {
  icon: string
  label: string
  description: string
  selected: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={cn(
        "group flex min-h-28 flex-col items-start p-4 text-left transition-colors duration-150 active:translate-y-px",
        selected ? "bg-foreground/[0.07] text-foreground" : "hover:bg-muted/50",
      )}
      onClick={onClick}
    >
      <span
        className={cn(
          "mb-3 flex size-7 items-center justify-center text-muted-foreground transition-colors",
          selected && "text-foreground",
        )}
      >
        <Icon icon={icon} width="17" />
      </span>
      <span className="text-sm font-semibold">{label}</span>
      <span className="mt-1! text-xs leading-5 text-muted-foreground">{description}</span>
    </button>
  )
}

function CustomProviderForm({
  name,
  api,
  baseUrl,
  apiKey,
  apiKeyPlaceholder,
  submitLabel,
  busy,
  requireApiKey = false,
  onNameChange,
  onApiChange,
  onBaseUrlChange,
  onApiKeyChange,
  onCancel,
  onDelete,
  onSubmit,
}: {
  name: string
  api: CustomModelProviderApi
  baseUrl: string
  apiKey: string
  apiKeyPlaceholder: string
  submitLabel: string
  busy: boolean
  requireApiKey?: boolean
  onNameChange: (value: string) => void
  onApiChange: (value: CustomModelProviderApi) => void
  onBaseUrlChange: (value: string) => void
  onApiKeyChange: (value: string) => void
  onCancel: () => void
  onDelete?: () => void
  onSubmit: () => void
}) {
  return (
    <div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Input
          aria-label="供应商名称"
          value={name}
          onChange={(event) => onNameChange(event.target.value)}
          placeholder="供应商名称"
        />
        <Combobox
          value={api}
          onChange={(value) => onApiChange(value as CustomModelProviderApi)}
          options={[
            { value: "openai-completions", label: "OpenAI Completions" },
            { value: "openai-responses", label: "OpenAI Responses" },
            { value: "anthropic-messages", label: "Anthropic Messages" },
          ]}
          compactOptions
        />
        <Input
          aria-label="Base URL"
          type="url"
          value={baseUrl}
          onChange={(event) => onBaseUrlChange(event.target.value)}
          placeholder="Base URL"
        />
        <Input
          aria-label="API Key"
          type="password"
          value={apiKey}
          onChange={(event) => onApiKeyChange(event.target.value)}
          placeholder={apiKeyPlaceholder}
        />
      </div>
      <div className="mt-4 flex flex-wrap justify-between gap-2">
        <div>
          {onDelete ? (
            <Button size="sm" variant="danger" disabled={busy} onClick={onDelete}>
              <Icon icon="lucide:trash-2" width="13" /> 删除供应商
            </Button>
          ) : null}
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
            取消
          </Button>
          <Button
            size="sm"
            disabled={busy || !name.trim() || !baseUrl.trim() || (requireApiKey && !apiKey.trim())}
            onClick={onSubmit}
          >
            <Icon icon={requireApiKey ? "lucide:plus" : "lucide:save"} width="13" />
            {submitLabel}
          </Button>
        </div>
      </div>
    </div>
  )
}
