import type { ControlPlaneSetupSnapshot, ProjectConfig } from "@ctf-agent/core"
import { Icon } from "@iconify/react"
import { useEffect, useMemo, useState } from "react"
import { useParams } from "react-router-dom"
import { useApp } from "../../app/AppProvider.tsx"
import {
  Badge,
  Button,
  Card,
  Combobox,
  ErrorNotice,
  Input,
  Label,
  PageHeader,
  Spinner,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "../../components/index.ts"
import { apiMutation, apiRequest, projectApi } from "../../lib/api.ts"
import { errorMessage } from "../../lib/format.ts"
import type {
  ModelConfigurationView,
  ProjectRuntimeConfigurationView,
} from "../../types.ts"

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
              <div className="field">
                <span>最大并发 Solver</span>
                <Input
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
              </div>
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
              <div className="field">
                <span>项目显示名称</span>
                <Input
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
              </div>
              {platform?.setup.fields.map((field) => (
                <div key={field.key} className="field">
                  <span>{field.label}</span>
                  <Input
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
                </div>
              ))}
              {strategy?.secrets.map((field) => (
                <div key={field.name} className="field">
                  <span>{field.label}</span>
                  <Input
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
                </div>
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
    <div className="grid gap-2">
      <Label>
        {label}
        {hint ? ` · ${hint}` : ""}
      </Label>
      <Combobox
        value={value}
        onChange={onChange}
        placeholder="选择模型…"
        emptyLabel="继承 Solver"
        searchPlaceholder="搜索模型 ID…"
        emptyText="没有匹配的模型"
        options={models.map((model) => ({
          value: model.id,
          label: `${model.id} · ${model.provider}/${model.modelId}`,
          description: model.configured ? undefined : "不可用（未配置凭据）",
          disabled: !model.configured,
        }))}
      />
    </div>
  )
}
