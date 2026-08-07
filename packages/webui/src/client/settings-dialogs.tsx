import type { ControlPlaneSetupSnapshot, ProjectConfig } from "@ctf-agent/core"
import { useEffect, useMemo, useRef, useState } from "react"
import type {
  DashboardSnapshot,
  ModelConfigurationUpdate,
  ModelConfigurationView,
  ModelPoolEntryView,
} from "../types.ts"
import { controlPost, errorMessage, getJson } from "./lib.ts"
import { ModelAuthPanel } from "./model-auth-panel.tsx"

interface CommonProps {
  onClose: () => void
  toast: (message: string, error?: boolean) => void
}

export function ModelDialog(
  props: CommonProps & {
    summary: ModelConfigurationView | null
    onSaved: (
      configuration: ModelConfigurationView,
      snapshot: DashboardSnapshot,
    ) => void
  },
) {
  const dialog = useDialog()
  const [configuration, setConfiguration] =
    useState<ModelConfigurationView | null>(props.summary)
  const [selectedId, setSelectedId] = useState(
    props.summary?.solverModelId ?? props.summary?.models[0]?.id ?? "",
  )
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({})
  const [clearApiKeys, setClearApiKeys] = useState<Record<string, boolean>>({})
  const [showSecret, setShowSecret] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState("")

  useEffect(() => {
    let live = true
    setBusy(true)
    void getJson<ModelConfigurationView>("/api/model-config")
      .then((value) => {
        if (live) {
          setConfiguration(value)
          setSelectedId((current) =>
            value.models.some((model) => model.id === current)
              ? current
              : value.solverModelId || value.models[0]?.id || "",
          )
        }
      })
      .catch((error) => {
        if (live) setFailure(errorMessage(error))
      })
      .finally(() => {
        if (live) setBusy(false)
      })
    return () => {
      live = false
    }
  }, [])

  function modelField<K extends keyof ModelPoolEntryView>(
    key: K,
    value: ModelPoolEntryView[K],
  ) {
    setConfiguration((current) =>
      current
        ? {
            ...current,
            models: current.models.map((model) =>
              model.id === selectedId ||
              (key === "baseUrl" && model.provider === selected?.provider)
                ? { ...model, [key]: value }
                : model,
            ),
          }
        : current,
    )
  }

  function assignment(key: "solverModelId" | "tldrModelId", value: string) {
    setConfiguration((current) =>
      current ? { ...current, [key]: value } : current,
    )
  }

  async function refreshConfiguration() {
    const next = await getJson<ModelConfigurationView>("/api/model-config")
    setConfiguration(next)
    setSelectedId((current) =>
      next.models.some((model) => model.id === current)
        ? current
        : next.solverModelId || next.models[0]?.id || "",
    )
  }

  function addModel(provider = "openrouter", modelId = "") {
    setConfiguration((current) => {
      if (!current) return current
      const duplicate = current.models.find(
        (model) => model.provider === provider && model.modelId === modelId,
      )
      if (duplicate) {
        setSelectedId(duplicate.id)
        return current
      }
      const id = nextModelId(current.models)
      const model: ModelPoolEntryView = {
        id,
        provider,
        modelId,
        baseUrl: "",
        contextWindow: 64_000,
        apiKeyConfigured: false,
        apiKeySource: "none",
        thinkingEnabled: true,
        reasoningEffort: "medium",
        passthroughThinking: false,
        supportedThinkingLevels: [],
        configured: false,
        unavailableReason: "尚未保存",
      }
      setSelectedId(id)
      return {
        ...current,
        models: [...current.models, model],
        solverModelId: current.solverModelId || id,
        tldrModelId: current.tldrModelId || id,
      }
    })
  }

  function removeSelectedModel() {
    setConfiguration((current) => {
      if (!current) return current
      const models = current.models.filter((model) => model.id !== selectedId)
      const fallback = models[0]?.id ?? ""
      const solverModelId =
        current.solverModelId === selectedId ? fallback : current.solverModelId
      const tldrModelId =
        current.tldrModelId === selectedId
          ? solverModelId || fallback
          : current.tldrModelId
      const subagentModels = Object.fromEntries(
        Object.entries(current.subagentModels).filter(
          ([, model]) => model !== selectedId,
        ),
      )
      setSelectedId(fallback)
      return {
        ...current,
        models,
        solverModelId,
        tldrModelId,
        subagentModels,
      }
    })
  }

  async function save(event: React.FormEvent) {
    event.preventDefault()
    if (!configuration) return
    setBusy(true)
    setFailure("")
    const body: ModelConfigurationUpdate = {
      models: configuration.models.map((model) => ({
        id: model.id,
        provider: model.provider.trim(),
        modelId: model.modelId.trim(),
        baseUrl: model.baseUrl.trim(),
        contextWindow: Number(model.contextWindow),
        thinkingEnabled: model.thinkingEnabled,
        reasoningEffort: model.reasoningEffort,
        passthroughThinking: model.passthroughThinking,
        ...(clearApiKeys[model.id] ? { clearApiKey: true } : {}),
        ...(!clearApiKeys[model.id] && apiKeys[model.id]?.trim()
          ? { apiKey: apiKeys[model.id]?.trim() }
          : {}),
      })),
      solverModelId: configuration.solverModelId,
      tldrModelId: configuration.tldrModelId,
      subagentModels: configuration.subagentModels,
    }
    try {
      const result = await controlPost<{
        configuration: ModelConfigurationView
        snapshot: DashboardSnapshot
      }>("/api/model-config", body)
      props.onSaved(result.configuration, result.snapshot)
      props.toast(
        result.configuration.configured
          ? "模型配置已保存，调度器现在可用"
          : "模型配置已保存，调度器保持暂停",
      )
      props.onClose()
    } catch (error) {
      setFailure(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  const selected = configuration?.models.find(
    (model) => model.id === selectedId,
  )
  const levels = selected?.supportedThinkingLevels ?? []
  const modelChoices = configuration?.models ?? []
  return (
    <dialog
      className="model-dialog"
      ref={dialog}
      aria-labelledby="model-dialog-title"
      onCancel={(event) => {
        event.preventDefault()
        props.onClose()
      }}
    >
      <div className="model-shell">
        <DialogHeader
          eyebrow="MODEL UPLINK / LOCAL CONTROL"
          title="模型连接设置"
          description="维护可用模型池，并分别绑定 Solver、TLDR 与各类 SubAgent。"
          onClose={props.onClose}
        />
        <StatusCard
          kind={
            configuration?.configured ? "ready" : failure ? "error" : "loading"
          }
          title={
            configuration?.configured
              ? "模型连接已配置"
              : failure
                ? "无法读取模型配置"
                : "模型配置未完成"
          }
          description={
            configuration?.configured
              ? `${configuration.models.length} 个模型；Solver 使用 ${modelLabel(configuration.models, configuration.solverModelId)}`
              : failure ||
                configuration?.unavailableReason ||
                "请添加并选择 Solver 模型"
          }
        />
        {configuration ? (
          <form
            className="model-form"
            onSubmit={(event) => void save(event)}
            aria-busy={busy}
          >
            <ModelAuthPanel
              disabled={busy}
              toast={props.toast}
              onCredentialsChanged={refreshConfiguration}
              onSelectModel={(provider, modelId) => {
                addModel(provider, modelId)
                props.toast(`已加入 ${provider} / ${modelId}，保存后生效`)
              }}
            />
            <section className="model-pool" aria-label="可用模型池">
              <header>
                <div>
                  <strong>可用模型池</strong>
                  <small>同一 Provider 的模型共享 Base URL 与本机凭据。</small>
                </div>
                <button
                  className="outline-button"
                  type="button"
                  onClick={() => addModel()}
                  disabled={busy}
                >
                  添加自定义模型
                </button>
              </header>
              <div className="model-pool-tabs">
                {modelChoices.map((model) => (
                  <button
                    className={model.id === selectedId ? "is-active" : ""}
                    key={model.id}
                    type="button"
                    onClick={() => setSelectedId(model.id)}
                  >
                    <span>{model.provider}</span>
                    <strong>{model.modelId || "未命名"}</strong>
                  </button>
                ))}
              </div>
            </section>
            {selected ? (
              <div className="model-form-grid">
                <Field
                  label="Provider"
                  hint="模型提供方标识，用于匹配请求凭证。"
                >
                  <input
                    value={selected.provider}
                    onChange={(event) =>
                      modelField("provider", event.target.value)
                    }
                    maxLength={128}
                    placeholder="openai-codex"
                    required
                    disabled={busy}
                  />
                </Field>
                <Field
                  label="Model ID"
                  hint="可从上方已登录 Provider 的模型列表填入，或手动填写。"
                >
                  <input
                    value={selected.modelId}
                    onChange={(event) =>
                      modelField("modelId", event.target.value)
                    }
                    maxLength={256}
                    required
                    disabled={busy}
                  />
                </Field>
                <Field
                  label="Base URL"
                  hint="留空使用 Pi 内置 Provider；自建中转站填写 HTTPS 地址。"
                  wide
                >
                  <input
                    type="url"
                    value={selected.baseUrl}
                    onChange={(event) =>
                      modelField("baseUrl", event.target.value)
                    }
                    placeholder="https://api.example.com/v1"
                    disabled={busy}
                  />
                </Field>
                <Field
                  label="API Key"
                  hint={
                    selected.apiKeyConfigured
                      ? "已配置；留空保持现有密钥。"
                      : "仅写入本机 Secret Store。"
                  }
                  wide
                >
                  <div className="secret-control">
                    <input
                      type={showSecret ? "text" : "password"}
                      value={apiKeys[selected.id] ?? ""}
                      onChange={(event) => {
                        setApiKeys((current) => ({
                          ...current,
                          [selected.id]: event.target.value,
                        }))
                        if (event.target.value) {
                          setClearApiKeys((current) => ({
                            ...current,
                            [selected.id]: false,
                          }))
                        }
                      }}
                      disabled={busy || clearApiKeys[selected.id] === true}
                      autoComplete="new-password"
                      placeholder={
                        selected.apiKeyConfigured
                          ? "已配置；留空保持"
                          : "输入新的 API Key"
                      }
                    />
                    <button
                      className="secret-toggle"
                      type="button"
                      onClick={() => setShowSecret((value) => !value)}
                      disabled={busy}
                    >
                      {showSecret ? "HIDE" : "SHOW"}
                    </button>
                  </div>
                </Field>
                {selected.apiKeyConfigured ? (
                  <Field
                    label="清除现有 API Key"
                    hint="保存时从本机 Secret Store 删除。"
                  >
                    <input
                      className="model-checkbox"
                      type="checkbox"
                      checked={clearApiKeys[selected.id] === true}
                      onChange={(event) => {
                        setClearApiKeys((current) => ({
                          ...current,
                          [selected.id]: event.target.checked,
                        }))
                        if (event.target.checked) {
                          setApiKeys((current) => ({
                            ...current,
                            [selected.id]: "",
                          }))
                        }
                      }}
                      disabled={busy}
                    />
                  </Field>
                ) : null}
                <Field label="Context Window" hint="Agent 可使用的上下文上限。">
                  <input
                    type="number"
                    value={selected.contextWindow}
                    onChange={(event) =>
                      modelField("contextWindow", Number(event.target.value))
                    }
                    min={1_024}
                    disabled={busy}
                  />
                </Field>
                <Field
                  label="启用思考"
                  hint="模型级默认值；运行中可在题目详情单独切换。"
                >
                  <input
                    className="model-checkbox"
                    type="checkbox"
                    checked={selected.thinkingEnabled}
                    onChange={(event) =>
                      modelField("thinkingEnabled", event.target.checked)
                    }
                    disabled={busy}
                  />
                </Field>
                <Field label="思考强度" hint="档位由 Pi 根据当前模型动态计算。">
                  <select
                    value={
                      levels.includes(selected.reasoningEffort)
                        ? selected.reasoningEffort
                        : ""
                    }
                    onChange={(event) =>
                      modelField("reasoningEffort", event.target.value)
                    }
                    disabled={
                      busy || levels.length === 0 || levels.includes("off")
                    }
                  >
                    <option value="">—</option>
                    {levels
                      .filter((level) => level !== "off")
                      .map((level) => (
                        <option key={level} value={level}>
                          {level}
                        </option>
                      ))}
                  </select>
                </Field>
                <Field
                  label="透传思考档位"
                  hint="自定义 Base URL 场景将档位同名直通。"
                >
                  <input
                    className="model-checkbox"
                    type="checkbox"
                    checked={selected.passthroughThinking}
                    onChange={(event) =>
                      modelField("passthroughThinking", event.target.checked)
                    }
                    disabled={busy || !selected.baseUrl}
                  />
                </Field>
                <Field label="删除模型" hint="移除模型及其 Agent 绑定。">
                  <button
                    className="outline-button"
                    type="button"
                    onClick={removeSelectedModel}
                    disabled={busy}
                  >
                    移除当前模型
                  </button>
                </Field>
              </div>
            ) : (
              <p className="model-empty">模型池为空，请添加一个模型。</p>
            )}
            <section className="model-assignments">
              <header>
                <strong>Agent 模型绑定</strong>
                <small>最大 Solver 并发量继续在主控制台即时设置。</small>
              </header>
              <div className="model-form-grid">
                <ModelAssignment
                  label="Solver"
                  value={configuration.solverModelId}
                  models={modelChoices}
                  disabled={busy}
                  onChange={(value) => assignment("solverModelId", value)}
                />
                <ModelAssignment
                  label="TLDR"
                  value={configuration.tldrModelId}
                  models={modelChoices}
                  disabled={busy}
                  onChange={(value) => assignment("tldrModelId", value)}
                />
                {configuration.subagentRoles?.map((role) => (
                  <ModelAssignment
                    key={role.name}
                    label={`SubAgent · ${role.displayName}`}
                    value={configuration.subagentModels[role.name] ?? ""}
                    models={modelChoices}
                    disabled={busy}
                    allowDefault
                    onChange={(value) =>
                      setConfiguration((current) => {
                        if (!current) return current
                        const subagentModels = { ...current.subagentModels }
                        if (value) subagentModels[role.name] = value
                        else delete subagentModels[role.name]
                        return { ...current, subagentModels }
                      })
                    }
                  />
                ))}
              </div>
            </section>
            <aside className="model-security-note">
              <span aria-hidden="true">LOCAL SECRET</span>
              <p>
                OAuth 与 API Key
                均保存在本机；读取配置时仅显示凭据类型和是否已配置。
              </p>
            </aside>
            {failure ? (
              <p className="model-form-error" role="alert">
                {failure}
              </p>
            ) : null}
            <footer className="model-form-actions">
              <button
                className="outline-button"
                type="button"
                onClick={props.onClose}
              >
                取消
              </button>
              <button
                className={`control-button model-save${busy ? " is-loading" : ""}`}
                type="submit"
                disabled={busy}
              >
                {busy ? "正在应用…" : "保存并应用"}
              </button>
            </footer>
          </form>
        ) : null}
      </div>
    </dialog>
  )
}

function nextModelId(models: readonly ModelPoolEntryView[]): string {
  const used = new Set(models.map((model) => model.id))
  let sequence = models.length + 1
  while (used.has(`model-${sequence}`)) sequence++
  return `model-${sequence}`
}

function modelLabel(models: readonly ModelPoolEntryView[], id: string): string {
  const model = models.find((candidate) => candidate.id === id)
  return model ? `${model.provider}/${model.modelId}` : "未选择"
}

function ModelAssignment(props: {
  label: string
  value: string
  models: readonly ModelPoolEntryView[]
  disabled: boolean
  allowDefault?: boolean
  onChange: (value: string) => void
}) {
  return (
    <Field label={props.label} hint="新建 Agent 时生效。">
      <select
        value={props.value}
        disabled={props.disabled}
        required={!props.allowDefault && props.models.length > 0}
        onChange={(event) => props.onChange(event.target.value)}
      >
        {props.allowDefault ? <option value="">继承 role 配置</option> : null}
        {!props.allowDefault && props.models.length === 0 ? (
          <option value="">无可用模型</option>
        ) : null}
        {props.models.map((model) => (
          <option key={model.id} value={model.id}>
            {model.provider}/{model.modelId || "未命名"}
          </option>
        ))}
      </select>
    </Field>
  )
}

export function PlatformDialog(
  props: CommonProps & {
    summary: ControlPlaneSetupSnapshot | null
    onApplied: (
      setup: ControlPlaneSetupSnapshot,
      snapshot: DashboardSnapshot,
    ) => void
  },
) {
  const dialog = useDialog()
  const [setup, setSetup] = useState<ControlPlaneSetupSnapshot | null>(
    props.summary,
  )
  const [projectId, setProjectId] = useState("ctf-project")
  const [projectName, setProjectName] = useState("CTF")
  const [pluginId, setPluginId] = useState("")
  const [authId, setAuthId] = useState("")
  const [values, setValues] = useState<Record<string, string>>({})
  const [secrets, setSecrets] = useState<Record<string, string>>({})
  const [image, setImage] = useState("ctf-agent-solver:latest")
  const [networkMode, setNetworkMode] = useState<"bridge" | "none" | "host">(
    "bridge",
  )
  const [privileged, setPrivileged] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState("")
  const [tested, setTested] = useState("")

  useEffect(() => {
    let live = true
    setBusy(true)
    void getJson<ControlPlaneSetupSnapshot>("/api/control-plane")
      .then((value) => {
        if (!live) return
        setSetup(value)
        setProjectId(value.config?.project.id ?? "ctf-project")
        setProjectName(value.config?.project.name ?? "CTF")
        setImage(value.config?.sandbox.image ?? "ctf-agent-solver:latest")
        setNetworkMode(value.config?.sandbox.networkMode ?? "bridge")
        setPrivileged(value.config?.sandbox.privileged === true)
        setPluginId(
          value.config?.platform.plugin ?? value.platforms[0]?.id ?? "",
        )
      })
      .catch((error) => {
        if (live) setFailure(errorMessage(error))
      })
      .finally(() => {
        if (live) setBusy(false)
      })
    return () => {
      live = false
    }
  }, [])

  const platform = setup?.platforms.find((item) => item.id === pluginId)
  const strategies = platform?.setup.authStrategies ?? []
  const strategy =
    strategies.find((item) => item.id === authId) ?? strategies[0]

  useEffect(() => {
    if (!setup) return
    const selectedPlatform = setup.platforms.find(
      (item) => item.id === pluginId,
    )
    if (!selectedPlatform) return
    const stored =
      setup.config?.platform.plugin === selectedPlatform.id
        ? (setup.config.platform.config as Record<string, unknown>)
        : {}
    const merged = { ...selectedPlatform.setup.defaultConfig, ...stored }
    setValues(
      Object.fromEntries(
        Object.entries(merged).map(([key, value]) => [
          key,
          String(value ?? ""),
        ]),
      ),
    )
    const matched = selectedPlatform.setup.authStrategies.find((candidate) =>
      configContains(merged, candidate.config),
    )
    setAuthId(matched?.id ?? selectedPlatform.setup.authStrategies[0]?.id ?? "")
    setSecrets({})
  }, [pluginId, setup])

  const payload = useMemo(() => {
    if (!platform || !strategy) return null
    const config: Record<string, unknown> = {
      ...platform.setup.defaultConfig,
      ...strategy.config,
    }
    for (const field of platform.setup.fields) {
      const value = values[field.key]?.trim()
      if (!value) delete config[field.key]
      else config[field.key] = field.type === "integer" ? Number(value) : value
    }
    return {
      config: {
        version: 1,
        project: { id: projectId.trim(), name: projectName.trim() },
        platform: { plugin: platform.id, config },
        sandbox: { image: image.trim(), privileged, networkMode },
      } satisfies ProjectConfig,
      secrets,
    }
  }, [
    platform,
    strategy,
    values,
    projectId,
    projectName,
    image,
    privileged,
    networkMode,
    secrets,
  ])

  async function test() {
    if (!payload) return
    setBusy(true)
    setFailure("")
    try {
      const result = await controlPost<{
        overview: { name: string; challenges: number }
      }>("/api/control-plane/test", payload)
      setTested(`${result.overview.name} · ${result.overview.challenges} 道题`)
      props.toast("平台连接测试成功，配置尚未保存")
    } catch (error) {
      setFailure(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  async function save(event: React.FormEvent) {
    event.preventDefault()
    if (!payload) return
    setBusy(true)
    setFailure("")
    try {
      const result = await controlPost<{
        setup: ControlPlaneSetupSnapshot
        snapshot: DashboardSnapshot
      }>("/api/control-plane/apply", payload)
      props.onApplied(result.setup, result.snapshot)
      props.toast("比赛平台配置已保存并连接")
      props.onClose()
    } catch (error) {
      setFailure(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <dialog
      className="model-dialog"
      ref={dialog}
      aria-labelledby="platform-dialog-title"
    >
      <div className="model-shell">
        <DialogHeader
          eyebrow="CONTEST UPLINK / PLUGIN SETUP"
          title="比赛平台设置"
          description="选择平台插件，测试凭据后保存并建立比赛连接。"
          onClose={props.onClose}
        />
        <StatusCard
          kind={
            setup?.state.phase === "ready" || tested
              ? "ready"
              : failure
                ? "error"
                : "loading"
          }
          title={
            setup?.state.phase === "ready"
              ? "比赛平台已连接"
              : tested
                ? "平台连接测试成功"
                : "比赛平台尚未连接"
          }
          description={
            failure || tested || setup?.state.lastError || "请填写并测试配置"
          }
        />
        {setup ? (
          <form
            className="model-form"
            onSubmit={(event) => void save(event)}
            aria-busy={busy}
          >
            <div className="model-form-grid">
              <Field label="项目 ID" hint="用于本地工作区和运行记录归档。">
                <input
                  value={projectId}
                  onChange={(event) => setProjectId(event.target.value)}
                  required
                  disabled={busy}
                />
              </Field>
              <Field label="比赛名称" hint="显示在控制台顶部。">
                <input
                  value={projectName}
                  onChange={(event) => setProjectName(event.target.value)}
                  required
                  disabled={busy}
                />
              </Field>
              <Field
                label="平台插件"
                hint={platform?.setup.description ?? "选择比赛平台。"}
              >
                <select
                  value={pluginId}
                  onChange={(event) => setPluginId(event.target.value)}
                  disabled={busy}
                >
                  {setup.platforms.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.setup.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="认证方式" hint="密钥单独保存在本地密钥文件。">
                <select
                  value={strategy?.id ?? ""}
                  onChange={(event) => setAuthId(event.target.value)}
                  disabled={busy}
                >
                  {strategies.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </Field>
              {platform?.setup.fields.map((field) => (
                <Field label={field.label} key={field.key}>
                  <input
                    type={field.type === "integer" ? "number" : field.type}
                    value={values[field.key] ?? ""}
                    onChange={(event) =>
                      setValues((current) => ({
                        ...current,
                        [field.key]: event.target.value,
                      }))
                    }
                    required={field.required}
                    placeholder={field.placeholder}
                    min={field.minimum}
                    max={field.maximum}
                    disabled={busy}
                  />
                </Field>
              ))}
              {strategy?.secrets.map((secret) => {
                const stored = setup.secrets[secret.name]?.configured === true
                return (
                  <Field
                    label={secret.label}
                    key={secret.name}
                    hint={stored ? "已配置；留空保持。" : undefined}
                  >
                    <input
                      type={secret.type === "text" ? "text" : "password"}
                      value={secrets[secret.name] ?? ""}
                      onChange={(event) =>
                        setSecrets((current) => ({
                          ...current,
                          [secret.name]: event.target.value,
                        }))
                      }
                      required={secret.required && !stored}
                      placeholder={stored ? "已配置；留空保持" : "请输入凭据"}
                      autoComplete="new-password"
                      disabled={busy}
                    />
                  </Field>
                )
              })}
              <Field
                label="Solver Docker 镜像"
                hint="主 Agent 与 SubAgent 的共享隔离执行环境。"
                wide
              >
                <input
                  value={image}
                  onChange={(event) => setImage(event.target.value)}
                  required
                  disabled={busy}
                />
              </Field>
              <Field label="网络模式" hint="远程靶机通常需要 bridge。">
                <select
                  value={networkMode}
                  onChange={(event) =>
                    setNetworkMode(event.target.value as typeof networkMode)
                  }
                  disabled={busy}
                >
                  <option value="bridge">bridge</option>
                  <option value="none">none</option>
                  <option value="host">host</option>
                </select>
              </Field>
              <Field label="特权容器" hint="仅题目确实需要底层系统能力时开启。">
                <input
                  className="model-checkbox"
                  type="checkbox"
                  checked={privileged}
                  onChange={(event) => setPrivileged(event.target.checked)}
                  disabled={busy}
                />
              </Field>
            </div>
            <aside className="model-security-note">
              <span>LOCAL SECRET</span>
              <p>凭据不会回传到浏览器；界面只显示是否已配置。</p>
            </aside>
            {failure ? (
              <p className="model-form-error" role="alert">
                {failure}
              </p>
            ) : null}
            <footer className="model-form-actions">
              <button
                className="outline-button"
                type="button"
                onClick={() => void test()}
                disabled={busy}
              >
                测试连接
              </button>
              <button
                className={`control-button model-save${busy ? " is-loading" : ""}`}
                type="submit"
                disabled={busy}
              >
                {busy ? "正在连接…" : "保存并连接"}
              </button>
            </footer>
          </form>
        ) : null}
      </div>
    </dialog>
  )
}

function useDialog() {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    if (ref.current && !ref.current.open) ref.current.showModal()
  }, [])
  return ref
}

function DialogHeader(props: {
  eyebrow: string
  title: string
  description: string
  onClose: () => void
}) {
  return (
    <header className="model-header">
      <div>
        <p className="section-index">{props.eyebrow}</p>
        <h2>{props.title}</h2>
        <p>{props.description}</p>
      </div>
      <button className="icon-button" type="button" onClick={props.onClose}>
        <span aria-hidden="true">×</span>
        <span className="sr-only">关闭设置</span>
      </button>
    </header>
  )
}

function StatusCard(props: {
  kind: "ready" | "error" | "loading"
  title: string
  description: string
}) {
  return (
    <div
      className={`model-status${props.kind === "ready" ? " is-ready" : props.kind === "error" ? " is-error" : ""}`}
      role="status"
    >
      <span className="model-status-dot" aria-hidden="true"></span>
      <div>
        <strong>{props.title}</strong>
        <small>{props.description}</small>
      </div>
    </div>
  )
}

function Field(props: {
  label: string
  hint?: string
  wide?: boolean
  children: React.ReactNode
}) {
  return (
    <label className={`model-field${props.wide ? " model-field-wide" : ""}`}>
      <span>{props.label}</span>
      {props.children}
      {props.hint ? <small>{props.hint}</small> : null}
    </label>
  )
}

function configContains(value: unknown, expected: unknown): boolean {
  if (!expected || typeof expected !== "object") return value === expected
  if (!value || typeof value !== "object") return false
  return Object.entries(expected).every(([key, child]) =>
    configContains((value as Record<string, unknown>)[key], child),
  )
}
