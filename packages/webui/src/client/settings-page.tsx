import type { ControlPlaneSetupSnapshot, ProjectConfig } from "@ctf-agent/core"
import { Icon } from "@iconify/react"
import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react"
import { useParams } from "react-router-dom"
import type {
  ModelAuthenticationView,
  ModelAuthLoginSessionView,
  ModelAuthProviderView,
  ModelConfigurationUpdate,
  ModelConfigurationView,
  ModelPoolEntryUpdate,
  ProjectRuntimeConfigurationView,
} from "../types.ts"
import { apiMutation, apiRequest, projectApi } from "./api.ts"
import { useApp } from "./app-context.tsx"
import {
  Badge,
  Button,
  Card,
  ErrorNotice,
  PageHeader,
  Spinner,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "./components/index.ts"
import { errorMessage } from "./lib.ts"

interface GlobalConfigurationResponse {
  authentication: { enabled: boolean; username: string | null }
  modelConfiguration: ModelConfigurationView | null
  modelAuthentication: ModelAuthenticationView | null
}

interface EditableModel extends ModelPoolEntryUpdate {
  uiKey: string
  apiKeyConfigured: boolean
  supportedThinkingLevels: string[]
}

function editableModel(
  model: ModelConfigurationView["models"][number],
): EditableModel {
  return {
    uiKey: crypto.randomUUID(),
    id: model.id,
    provider: model.provider,
    modelId: model.modelId,
    baseUrl: model.baseUrl,
    contextWindow: model.contextWindow,
    thinkingEnabled: model.thinkingEnabled,
    reasoningEffort: model.reasoningEffort,
    passthroughThinking: model.passthroughThinking,
    apiKeyConfigured: model.apiKeyConfigured,
    supportedThinkingLevels: model.supportedThinkingLevels,
  }
}

function ProviderCredentialCard({
  provider,
  onRefresh,
}: {
  provider: ModelAuthProviderView
  onRefresh(): Promise<void>
}): React.ReactElement {
  const [method, setMethod] = useState(provider.methods[0]?.id ?? "")
  const [secret, setSecret] = useState("")
  const [session, setSession] = useState<ModelAuthLoginSessionView | null>(null)
  const [promptValue, setPromptValue] = useState("")
  const [error, setError] = useState("")
  const selectedMethod = provider.methods.find(
    (candidate) => candidate.id === method,
  )

  useEffect(() => {
    if (!session || !["running", "awaiting_input"].includes(session.status))
      return
    const timer = window.setInterval(() => {
      void apiRequest<ModelAuthLoginSessionView>(
        `/api/model-auth/login/${encodeURIComponent(session.id)}`,
      )
        .then(async (next) => {
          setSession(next)
          if (next.status === "success") await onRefresh()
        })
        .catch((cause) => setError(errorMessage(cause)))
    }, 1_200)
    return () => window.clearInterval(timer)
  }, [onRefresh, session])

  async function connect(): Promise<void> {
    setError("")
    try {
      setSession(
        await apiMutation<ModelAuthLoginSessionView>(
          "/api/model-auth/login",
          "POST",
          { provider: provider.id, method, ...(secret ? { secret } : {}) },
        ),
      )
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  async function submitPrompt(): Promise<void> {
    if (!session) return
    setError("")
    try {
      setSession(
        await apiMutation<ModelAuthLoginSessionView>(
          `/api/model-auth/login/${encodeURIComponent(session.id)}/prompt`,
          "POST",
          { value: promptValue },
        ),
      )
      setPromptValue("")
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  async function disconnect(): Promise<void> {
    setError("")
    try {
      await apiMutation(
        `/api/model-auth/providers/${encodeURIComponent(provider.id)}/logout`,
        "POST",
      )
      setSession(null)
      await onRefresh()
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  return (
    <Card className="provider-card">
      <div className="provider-heading">
        <span className="provider-icon">
          <Icon icon="lucide:key-round" width="17" />
        </span>
        <div>
          <strong>{provider.name}</strong>
          <small>{provider.description}</small>
        </div>
        <Badge tone={provider.configured ? "positive" : "neutral"}>
          {provider.configured ? "已认证" : "未连接"}
        </Badge>
      </div>
      {error ? <ErrorNotice message={error} /> : null}
      {provider.configured ? (
        <div className="provider-actions">
          <span>
            {provider.credentialType === "oauth" ? "OAuth 会话" : "API Key"}{" "}
            已保存
          </span>
          <Button size="sm" variant="danger" onClick={() => void disconnect()}>
            断开
          </Button>
        </div>
      ) : (
        <div className="provider-connect">
          <label className="field">
            <span>认证方式</span>
            <select
              value={method}
              onChange={(event) => {
                setMethod(event.target.value as typeof method)
                setSession(null)
              }}
            >
              {provider.methods.map((candidate) => (
                <option value={candidate.id} key={candidate.id}>
                  {candidate.label}
                </option>
              ))}
            </select>
          </label>
          {selectedMethod?.requiresSecret ? (
            <label className="field">
              <span>凭据</span>
              <input
                type="password"
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
                placeholder={selectedMethod.description}
              />
            </label>
          ) : null}
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void connect()}
            disabled={
              !method || (selectedMethod?.requiresSecret === true && !secret)
            }
          >
            <Icon icon="lucide:link" width="14" />
            开始认证
          </Button>
        </div>
      )}
      {session && session.status !== "success" ? (
        <div className="auth-session">
          <div className="auth-session-status">
            <Icon
              icon={
                session.status === "error"
                  ? "lucide:circle-x"
                  : "lucide:loader-circle"
              }
              className={session.status === "running" ? "spin" : ""}
              width="15"
            />
            {session.progress ??
              session.instructions ??
              session.error ??
              "等待认证"}
          </div>
          {session.authUrl ? (
            <a
              className="auth-link"
              href={session.authUrl}
              target="_blank"
              rel="noreferrer"
            >
              在浏览器中继续 <Icon icon="lucide:external-link" width="13" />
            </a>
          ) : null}
          {session.deviceCode ? (
            <div className="device-code">
              <span>{session.deviceCode.verificationUri}</span>
              <strong>{session.deviceCode.userCode}</strong>
            </div>
          ) : null}
          {session.prompt ? (
            <div className="auth-prompt">
              <label className="field" htmlFor={`auth-prompt-${session.id}`}>
                <span>{session.prompt.message}</span>
                {session.prompt.options ? (
                  <select
                    id={`auth-prompt-${session.id}`}
                    value={promptValue}
                    onChange={(event) => setPromptValue(event.target.value)}
                  >
                    <option value="">请选择</option>
                    {session.prompt.options.map((option) => (
                      <option value={option.id} key={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    id={`auth-prompt-${session.id}`}
                    type={
                      session.prompt.type === "secret" ? "password" : "text"
                    }
                    value={promptValue}
                    placeholder={session.prompt.placeholder}
                    onChange={(event) => setPromptValue(event.target.value)}
                  />
                )}
              </label>
              <Button
                size="sm"
                onClick={() => void submitPrompt()}
                disabled={!promptValue}
              >
                提交
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </Card>
  )
}

function ModelPoolEditor({
  configuration,
  authentication,
  onSaved,
}: {
  configuration: ModelConfigurationView
  authentication: ModelAuthenticationView
  onSaved(next: ModelConfigurationView): void
}): React.ReactElement {
  const [models, setModels] = useState<EditableModel[]>(
    configuration.models.map(editableModel),
  )
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)

  function update(index: number, patch: Partial<EditableModel>): void {
    setModels((current) =>
      current.map((model, candidate) =>
        candidate === index ? { ...model, ...patch } : model,
      ),
    )
  }

  function addModel(): void {
    const provider = authentication.providers[0]
    const suggested = provider?.models[0]
    setModels((current) => [
      ...current,
      {
        uiKey: crypto.randomUUID(),
        id: `model-${current.length + 1}`,
        provider: provider?.id ?? "openai",
        modelId: suggested?.id ?? "",
        baseUrl: "",
        contextWindow: suggested?.contextWindow ?? 128_000,
        thinkingEnabled: suggested?.reasoning ?? true,
        reasoningEffort: suggested?.reasoning ? "medium" : "off",
        passthroughThinking: false,
        apiKeyConfigured: false,
        supportedThinkingLevels: suggested?.reasoning
          ? ["off", "low", "medium", "high"]
          : ["off"],
      },
    ])
  }

  async function save(): Promise<void> {
    setBusy(true)
    setError("")
    try {
      const payload: ModelConfigurationUpdate = {
        models: models.map(
          ({
            uiKey: _,
            apiKeyConfigured: __,
            supportedThinkingLevels: ___,
            ...model
          }) => model,
        ),
        solverModelId: configuration.solverModelId,
        tldrModelId: configuration.tldrModelId,
        subagentModels: configuration.subagentModels,
      }
      const result = await apiMutation<{
        configuration: ModelConfigurationView
      }>("/api/model-config", "POST", payload)
      setModels(result.configuration.models.map(editableModel))
      onSaved(result.configuration)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="settings-stack">
      {error ? <ErrorNotice message={error} /> : null}
      {models.map((model, index) => {
        const provider = authentication.providers.find(
          (candidate) => candidate.id === model.provider,
        )
        return (
          <Card className="model-card" key={model.uiKey}>
            <div className="model-card-heading">
              <span>{String(index + 1).padStart(2, "0")}</span>
              <input
                aria-label="模型配置 ID"
                value={model.id}
                onChange={(event) => update(index, { id: event.target.value })}
              />
              <Button
                size="icon"
                variant="ghost"
                aria-label="删除模型"
                onClick={() =>
                  setModels((current) =>
                    current.filter((_, candidate) => candidate !== index),
                  )
                }
              >
                <Icon icon="lucide:trash-2" width="15" />
              </Button>
            </div>
            <div className="form-grid model-grid">
              <label className="field">
                <span>Provider</span>
                <input
                  list="provider-options"
                  value={model.provider}
                  onChange={(event) =>
                    update(index, { provider: event.target.value })
                  }
                />
              </label>
              <label className="field">
                <span>Model ID</span>
                <input
                  list={`model-options-${index}`}
                  value={model.modelId}
                  onChange={(event) => {
                    const selected = provider?.models.find(
                      (candidate) => candidate.id === event.target.value,
                    )
                    update(index, {
                      modelId: event.target.value,
                      ...(selected
                        ? {
                            contextWindow: selected.contextWindow,
                            thinkingEnabled: selected.reasoning,
                            reasoningEffort: selected.reasoning
                              ? "medium"
                              : "off",
                          }
                        : {}),
                    })
                  }}
                />
                <datalist id={`model-options-${index}`}>
                  {provider?.models.map((candidate) => (
                    <option value={candidate.id} key={candidate.id}>
                      {candidate.name}
                    </option>
                  ))}
                </datalist>
              </label>
              <label className="field">
                <span>Base URL（可选）</span>
                <input
                  type="url"
                  value={model.baseUrl}
                  onChange={(event) =>
                    update(index, { baseUrl: event.target.value })
                  }
                  placeholder="使用 Provider 默认地址"
                />
              </label>
              <label className="field">
                <span>Context Window</span>
                <input
                  type="number"
                  min="1"
                  value={model.contextWindow}
                  onChange={(event) =>
                    update(index, { contextWindow: Number(event.target.value) })
                  }
                />
              </label>
              <label className="field">
                <span>Reasoning Effort</span>
                <select
                  value={model.reasoningEffort}
                  onChange={(event) =>
                    update(index, { reasoningEffort: event.target.value })
                  }
                >
                  {[
                    "off",
                    "minimal",
                    "low",
                    "medium",
                    "high",
                    "xhigh",
                    "max",
                  ].map((level) => (
                    <option value={level} key={level}>
                      {level}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>模型专用 API Key</span>
                <input
                  type="password"
                  value={model.apiKey ?? ""}
                  onChange={(event) =>
                    update(index, {
                      apiKey: event.target.value,
                      clearApiKey: false,
                    })
                  }
                  placeholder={
                    model.apiKeyConfigured
                      ? "已配置；留空保持不变"
                      : "优先使用 Provider 凭据"
                  }
                />
              </label>
            </div>
            <div className="toggle-row">
              <label>
                <input
                  type="checkbox"
                  checked={model.thinkingEnabled}
                  onChange={(event) =>
                    update(index, { thinkingEnabled: event.target.checked })
                  }
                />
                启用模型推理
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={model.passthroughThinking}
                  onChange={(event) =>
                    update(index, { passthroughThinking: event.target.checked })
                  }
                />
                透传自定义推理档位
              </label>
              {model.apiKeyConfigured ? (
                <label>
                  <input
                    type="checkbox"
                    checked={model.clearApiKey === true}
                    onChange={(event) =>
                      update(index, {
                        clearApiKey: event.target.checked,
                        apiKey: "",
                      })
                    }
                  />
                  清除专用 Key
                </label>
              ) : null}
            </div>
          </Card>
        )
      })}
      <datalist id="provider-options">
        {authentication.providers.map((provider) => (
          <option value={provider.id} key={provider.id}>
            {provider.name}
          </option>
        ))}
      </datalist>
      <div className="settings-actions">
        <Button variant="secondary" onClick={addModel}>
          <Icon icon="lucide:plus" width="15" />
          添加模型
        </Button>
        <Button
          onClick={() => void save()}
          disabled={busy || models.length === 0}
        >
          <Icon
            icon={busy ? "lucide:loader-circle" : "lucide:save"}
            className={busy ? "spin" : ""}
            width="15"
          />
          保存模型池
        </Button>
      </div>
    </div>
  )
}

export function GlobalSettingsPage(): React.ReactElement {
  const { refreshAuth } = useApp()
  const [configuration, setConfiguration] =
    useState<GlobalConfigurationResponse | null>(null)
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [authEnabled, setAuthEnabled] = useState(false)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [importing, setImporting] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    const next =
      await apiRequest<GlobalConfigurationResponse>("/api/global-config")
    setConfiguration(next)
    setUsername(next.authentication.username ?? "")
    setAuthEnabled(next.authentication.enabled)
  }, [])

  useEffect(() => {
    void load().catch((cause) => setError(errorMessage(cause)))
  }, [load])

  async function saveWebAuthentication(event: FormEvent): Promise<void> {
    event.preventDefault()
    setBusy(true)
    setError("")
    try {
      await apiMutation("/api/global-config/authentication", "POST", {
        enabled: authEnabled,
        ...(authEnabled ? { username, ...(password ? { password } : {}) } : {}),
      })
      setPassword("")
      await refreshAuth()
      await load()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  async function importAuthentication(
    source: { json: string } | "file",
  ): Promise<void> {
    setImporting(true)
    setError("")
    try {
      await apiMutation(
        source === "file"
          ? "/api/model-auth/import-file"
          : "/api/model-auth/import",
        "POST",
        source === "file" ? {} : source,
      )
      await load()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setImporting(false)
    }
  }

  if (!configuration) return <Spinner label="正在读取全局配置" />
  const modelAuth = configuration.modelAuthentication
  const models = configuration.modelConfiguration
  return (
    <div className="page page-settings">
      <PageHeader
        eyebrow="GLOBAL CONTROL"
        title="全局配置"
        description="Provider 凭据和模型池由所有项目共享；角色绑定与并发量留在各项目内部。"
      />
      {error ? <ErrorNotice message={error} /> : null}
      <Tabs defaultValue="providers">
        <TabsList className="settings-tabs">
          <TabsTrigger value="providers">Provider 凭据</TabsTrigger>
          <TabsTrigger value="models">模型池</TabsTrigger>
          <TabsTrigger value="security">WebUI 登录</TabsTrigger>
        </TabsList>
        <TabsContent value="providers" className="settings-content">
          <div className="settings-intro">
            <div>
              <h2>模型供应商</h2>
              <p>凭据写入独立 Secret Store，不进入 model-config.json。</p>
            </div>
            <Badge>
              {modelAuth?.providers.filter((provider) => provider.configured)
                .length ?? 0}{" "}
              connected
            </Badge>
          </div>
          {modelAuth ? (
            <Card className="auth-import-bar">
              <div>
                <Icon icon="lucide:file-key-2" width="17" />
                <span>
                  <strong>导入现有凭据</strong>
                  <small>兼容 Pi、Codex CLI 与 Claude Code auth JSON。</small>
                </span>
              </div>
              <div>
                <label className="button button-secondary button-sm">
                  <Icon icon="lucide:upload" width="14" />
                  上传 JSON
                  <input
                    className="sr-only"
                    type="file"
                    accept="application/json,.json"
                    disabled={importing}
                    onChange={(event) => {
                      const file = event.target.files?.[0]
                      if (!file) return
                      void file
                        .text()
                        .then(
                          async (json) => await importAuthentication({ json }),
                        )
                      event.target.value = ""
                    }}
                  />
                </label>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={importing || !modelAuth.importFileAvailable}
                  title={
                    modelAuth.importFileAvailable
                      ? modelAuth.importPath
                      : "容器内未找到导入文件"
                  }
                  onClick={() => void importAuthentication("file")}
                >
                  <Icon icon="lucide:folder-key" width="14" />
                  读取 {modelAuth.importPath}
                </Button>
              </div>
            </Card>
          ) : null}
          <div className="provider-grid">
            {modelAuth?.providers.map((provider) => (
              <ProviderCredentialCard
                key={provider.id}
                provider={provider}
                onRefresh={load}
              />
            ))}
          </div>
        </TabsContent>
        <TabsContent value="models" className="settings-content">
          <div className="settings-intro">
            <div>
              <h2>可用模型池</h2>
              <p>
                Provider 与 Model ID
                支持从已认证供应商的目录自动补全，也允许自定义兼容端点。
              </p>
            </div>
            <Badge>{models?.models.length ?? 0} models</Badge>
          </div>
          {models && modelAuth ? (
            <ModelPoolEditor
              configuration={models}
              authentication={modelAuth}
              onSaved={(next) =>
                setConfiguration((current) =>
                  current ? { ...current, modelConfiguration: next } : current,
                )
              }
            />
          ) : (
            <ErrorNotice message="模型配置服务当前不可用" />
          )}
        </TabsContent>
        <TabsContent value="security" className="settings-content">
          <div className="settings-intro">
            <div>
              <h2>访问控制</h2>
              <p>默认关闭。启用后，所有 API、SSE 与导出端点都要求有效会话。</p>
            </div>
            <Badge tone={authEnabled ? "positive" : "warning"}>
              {authEnabled ? "ENABLED" : "DISABLED"}
            </Badge>
          </div>
          <Card>
            <form
              className="security-form"
              onSubmit={(event) => void saveWebAuthentication(event)}
            >
              <label className="toggle-line">
                <input
                  type="checkbox"
                  checked={authEnabled}
                  onChange={(event) => setAuthEnabled(event.target.checked)}
                />
                <span>
                  <strong>启用 WebUI 登录</strong>
                  <small>使用 HttpOnly、SameSite=Strict 会话 Cookie。</small>
                </span>
              </label>
              {authEnabled ? (
                <div className="form-grid form-grid-two">
                  <label className="field">
                    <span>管理员用户名</span>
                    <input
                      value={username}
                      onChange={(event) => setUsername(event.target.value)}
                    />
                  </label>
                  <label className="field">
                    <span>
                      {configuration.authentication.enabled
                        ? "新密码（留空保持）"
                        : "管理员密码"}
                    </span>
                    <input
                      type="password"
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                    />
                  </label>
                </div>
              ) : null}
              <div className="settings-actions">
                <Button
                  type="submit"
                  disabled={
                    busy ||
                    (authEnabled &&
                      (!username ||
                        (!configuration.authentication.enabled && !password)))
                  }
                >
                  <Icon icon="lucide:shield-check" width="15" />
                  保存访问策略
                </Button>
              </div>
            </form>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}

interface ProjectRuntimeResponse {
  runtime: ProjectRuntimeConfigurationView
  models: ModelConfigurationView
}

export function ProjectSettingsPage(): React.ReactElement {
  const { projectId = "" } = useParams()
  const { refreshProjects } = useApp()
  const [setup, setSetup] = useState<ControlPlaneSetupSnapshot | null>(null)
  const [runtimeResponse, setRuntimeResponse] =
    useState<ProjectRuntimeResponse | null>(null)
  const [projectConfig, setProjectConfig] = useState<ProjectConfig | null>(null)
  const [runtime, setRuntime] =
    useState<ProjectRuntimeConfigurationView | null>(null)
  const [secrets, setSecrets] = useState<Record<string, string>>({})
  const [error, setError] = useState("")
  const [busy, setBusy] = useState<"platform" | "runtime" | null>(null)

  useEffect(() => {
    void Promise.all([
      apiRequest<ControlPlaneSetupSnapshot>(
        projectApi(projectId, "/api/control-plane"),
      ),
      apiRequest<ProjectRuntimeResponse>(
        projectApi(projectId, "/api/runtime-config"),
      ),
    ])
      .then(([setupValue, runtimeValue]) => {
        setSetup(setupValue)
        setProjectConfig(setupValue.config)
        setRuntimeResponse(runtimeValue)
        setRuntime(runtimeValue.runtime)
      })
      .catch((cause) => setError(errorMessage(cause)))
  }, [projectId])

  const platform = useMemo(
    () =>
      setup?.platforms.find(
        (candidate) => candidate.id === projectConfig?.platform.plugin,
      ),
    [projectConfig?.platform.plugin, setup],
  )
  const platformConfig = (projectConfig?.platform.config ?? {}) as Record<
    string,
    unknown
  >
  const strategy =
    platform?.setup.authStrategies.find((candidate) => {
      const configuredAuth = (
        platformConfig.auth as { type?: string } | undefined
      )?.type
      return (
        candidate.id === configuredAuth ||
        platform?.setup.authStrategies.length === 1
      )
    }) ?? platform?.setup.authStrategies[0]

  async function savePlatform(): Promise<void> {
    if (!projectConfig) return
    setBusy("platform")
    setError("")
    try {
      await apiMutation("/api/projects", "POST", {
        config: projectConfig,
        secrets: Object.fromEntries(
          Object.entries(secrets).filter(([, value]) => value.length > 0),
        ),
      })
      setSecrets({})
      await refreshProjects()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(null)
    }
  }

  async function saveRuntime(): Promise<void> {
    if (!runtime) return
    setBusy("runtime")
    setError("")
    try {
      const next = await apiMutation<ProjectRuntimeResponse>(
        projectApi(projectId, "/api/runtime-config"),
        "POST",
        runtime,
      )
      setRuntimeResponse(next)
      setRuntime(next.runtime)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(null)
    }
  }

  if (!setup || !runtimeResponse || !projectConfig || !runtime)
    return <Spinner label="正在读取项目配置" />
  const modelOptions = runtimeResponse.models.models
  return (
    <div className="page page-settings">
      <PageHeader
        eyebrow={projectConfig.project.id}
        title="项目配置"
        description="平台连接属于项目；Solver、TLDR、SubAgent 角色和并发量可以独立绑定。"
      />
      {error ? <ErrorNotice message={error} /> : null}
      <Tabs defaultValue="runtime">
        <TabsList className="settings-tabs">
          <TabsTrigger value="runtime">运行策略</TabsTrigger>
          <TabsTrigger value="platform">比赛平台</TabsTrigger>
        </TabsList>
        <TabsContent value="runtime" className="settings-content">
          <div className="settings-intro">
            <div>
              <h2>Agent 模型绑定</h2>
              <p>保存后应用于新 turn 与新 SubAgent；全局模型池保持不变。</p>
            </div>
          </div>
          <Card className="runtime-card">
            <div className="form-grid form-grid-two">
              <ModelBindingField
                label="Solver Agent"
                value={runtime.solverModelId}
                models={modelOptions}
                onChange={(value) =>
                  setRuntime((current) =>
                    current ? { ...current, solverModelId: value } : current,
                  )
                }
              />
              <ModelBindingField
                label="TLDR Agent"
                value={runtime.tldrModelId}
                models={modelOptions}
                onChange={(value) =>
                  setRuntime((current) =>
                    current ? { ...current, tldrModelId: value } : current,
                  )
                }
              />
              <label className="field">
                <span>最大并发 Solver</span>
                <input
                  type="number"
                  min="1"
                  max="64"
                  value={runtime.maxConcurrent}
                  onChange={(event) =>
                    setRuntime((current) =>
                      current
                        ? {
                            ...current,
                            maxConcurrent: Number(event.target.value),
                          }
                        : current,
                    )
                  }
                />
              </label>
            </div>
            <div className="role-bindings">
              <h3>SubAgent Roles</h3>
              {runtimeResponse.models.subagentRoles?.map((role) => (
                <ModelBindingField
                  key={role.name}
                  label={role.displayName}
                  hint={role.name}
                  value={runtime.subagentModels[role.name] ?? ""}
                  models={modelOptions}
                  onChange={(value) =>
                    setRuntime((current) =>
                      current
                        ? {
                            ...current,
                            subagentModels: {
                              ...current.subagentModels,
                              [role.name]: value,
                            },
                          }
                        : current,
                    )
                  }
                />
              ))}
            </div>
            <div className="settings-actions">
              <Button
                onClick={() => void saveRuntime()}
                disabled={busy !== null}
              >
                <Icon icon="lucide:save" width="15" />
                保存运行策略
              </Button>
            </div>
          </Card>
        </TabsContent>
        <TabsContent value="platform" className="settings-content">
          <div className="settings-intro">
            <div>
              <h2>{platform?.setup.label ?? projectConfig.platform.plugin}</h2>
              <p>{platform?.setup.description}</p>
            </div>
            <Badge
              tone={setup.state.phase === "ready" ? "positive" : "warning"}
            >
              {setup.state.phase}
            </Badge>
          </div>
          <Card className="runtime-card">
            <div className="form-grid form-grid-two">
              <label className="field">
                <span>项目显示名称</span>
                <input
                  value={projectConfig.project.name}
                  onChange={(event) =>
                    setProjectConfig((current) =>
                      current
                        ? {
                            ...current,
                            project: {
                              ...current.project,
                              name: event.target.value,
                            },
                          }
                        : current,
                    )
                  }
                />
              </label>
              {platform?.setup.fields.map((field) => (
                <label className="field" key={field.key}>
                  <span>{field.label}</span>
                  <input
                    type={field.type === "integer" ? "number" : field.type}
                    min={field.minimum}
                    max={field.maximum}
                    value={String(platformConfig[field.key] ?? "")}
                    onChange={(event) =>
                      setProjectConfig((current) =>
                        current
                          ? {
                              ...current,
                              platform: {
                                ...current.platform,
                                config: {
                                  ...(current.platform.config as Record<
                                    string,
                                    unknown
                                  >),
                                  [field.key]:
                                    field.type === "integer"
                                      ? Number(event.target.value)
                                      : event.target.value,
                                },
                              },
                            }
                          : current,
                      )
                    }
                  />
                </label>
              ))}
              {strategy?.secrets.map((field) => (
                <label className="field" key={field.name}>
                  <span>{field.label}</span>
                  <input
                    type={field.type === "text" ? "text" : "password"}
                    value={secrets[field.name] ?? ""}
                    onChange={(event) =>
                      setSecrets((current) => ({
                        ...current,
                        [field.name]: event.target.value,
                      }))
                    }
                    placeholder={
                      setup.secrets[field.name]?.configured
                        ? "已保存；留空保持不变"
                        : "尚未配置"
                    }
                  />
                </label>
              ))}
            </div>
            <div className="settings-actions">
              <Button
                onClick={() => void savePlatform()}
                disabled={busy !== null}
              >
                <Icon icon="lucide:plug-zap" width="15" />
                保存并重新连接
              </Button>
            </div>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}

function ModelBindingField({
  label,
  hint,
  value,
  models,
  onChange,
}: {
  label: string
  hint?: string
  value: string
  models: ModelConfigurationView["models"]
  onChange(value: string): void
}): React.ReactElement {
  return (
    <label className="field">
      <span>
        {label}
        {hint ? ` · ${hint}` : ""}
      </span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">继承 Solver</option>
        {models.map((model) => (
          <option value={model.id} key={model.id} disabled={!model.configured}>
            {model.id} · {model.provider}/{model.modelId}
            {model.configured ? "" : "（不可用）"}
          </option>
        ))}
      </select>
    </label>
  )
}
