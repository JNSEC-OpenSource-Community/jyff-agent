import type { ControlPlaneSetupSnapshot, ProjectConfig } from "@ctf-agent/core"
import { Icon } from "@iconify/react"
import { useEffect, useId, useMemo, useState } from "react"
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
  PlatformSetupForm,
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

interface RT {
  runtime: ProjectRuntimeConfigurationView
  models: ModelConfigurationView
}

export function ProjectSettingsPage() {
  const { projectId = "" } = useParams()
  const { refreshProjects } = useApp()
  const maxConcurrentId = useId()
  const [setup, setSetup] = useState<ControlPlaneSetupSnapshot | null>(null)
  const [rt, setRt] = useState<RT | null>(null)
  const [pcfg, setPcfg] = useState<ProjectConfig | null>(null)
  const [runtime, setRuntime] =
    useState<ProjectRuntimeConfigurationView | null>(null)
  const [secrets, setSecrets] = useState<Record<string, string>>({})
  const [err, setErr] = useState("")
  const [busy, setBusy] = useState<"platform" | "runtime" | null>(null)

  useEffect(() => {
    void Promise.all([
      apiRequest<ControlPlaneSetupSnapshot>(
        projectApi(projectId, "/api/control-plane"),
      ),
      apiRequest<RT>(projectApi(projectId, "/api/runtime-config")),
    ])
      .then(([s, r]) => {
        setSetup(s)
        setPcfg(s.config)
        setRt(r)
        setRuntime(r.runtime)
      })
      .catch((e) => setErr(errorMessage(e)))
  }, [projectId])

  const plat = useMemo(
    () => setup?.platforms.find((p) => p.id === pcfg?.platform.plugin),
    [pcfg?.platform.plugin, setup],
  )
  const pconf = (pcfg?.platform.config ?? {}) as Record<string, unknown>
  const strat =
    plat?.setup.authStrategies.find((s) => {
      const a = (pconf.auth as { type?: string })?.type
      return s.id === a || plat.setup.authStrategies.length === 1
    }) ?? plat?.setup.authStrategies[0]

  async function savePlat() {
    if (!pcfg) return
    setBusy("platform")
    setErr("")
    try {
      await apiMutation("/api/projects", "POST", {
        config: pcfg,
        secrets: Object.fromEntries(
          Object.entries(secrets).filter(([, v]) => v),
        ),
      })
      setSecrets({})
      await refreshProjects()
    } catch (e) {
      setErr(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }
  async function saveRt() {
    if (!runtime) return
    setBusy("runtime")
    setErr("")
    try {
      const n = await apiMutation<RT>(
        projectApi(projectId, "/api/runtime-config"),
        "POST",
        runtime,
      )
      setRt(n)
      setRuntime(n.runtime)
    } catch (e) {
      setErr(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  if (!setup || !rt || !pcfg || !runtime)
    return <Spinner label="加载比赛配置" />
  const models = rt.models.models

  return (
    <div className="page-container">
      <header className="mb-8">
        <p className="hero-eyebrow text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">
          {pcfg.project.id}
        </p>
        <h1 className="hero-title mt-3 text-3xl font-bold tracking-tight">
          比赛配置
        </h1>
        <p className="hero-desc mt-3 max-w-2xl text-sm text-muted-foreground">
          模型绑定与并发量在当前比赛内独立配置。
        </p>
      </header>

      {err ? <ErrorNotice message={err} className="mb-6" /> : null}

      <Tabs defaultValue="runtime">
        <TabsList className="mb-6">
          <TabsTrigger value="runtime">运行</TabsTrigger>
          <TabsTrigger value="platform">平台</TabsTrigger>
        </TabsList>

        <TabsContent value="runtime" className="space-y-5">
          <div>
            <h2 className="text-lg font-semibold">Agent 模型绑定</h2>
            <p className="text-sm text-muted-foreground">
              应用于新 turn 与新 SubAgent。
            </p>
          </div>
          <Card className="space-y-6 p-6">
            <div className="grid gap-5 sm:grid-cols-2">
              <ModelField
                label="Solver Agent"
                value={runtime.solverModelId}
                models={models}
                onChange={(v) =>
                  setRuntime((c) => (c ? { ...c, solverModelId: v } : c))
                }
              />
              <ModelField
                label="TLDR Agent"
                value={runtime.tldrModelId}
                models={models}
                onChange={(v) =>
                  setRuntime((c) => (c ? { ...c, tldrModelId: v } : c))
                }
              />
              <div className="space-y-1.5">
                <Label
                  htmlFor={maxConcurrentId}
                  className="text-xs font-medium text-muted-foreground"
                >
                  最大并发
                </Label>
                <Input
                  id={maxConcurrentId}
                  type="number"
                  min="1"
                  max="64"
                  value={runtime.maxConcurrent}
                  onChange={(e) =>
                    setRuntime((c) =>
                      c ? { ...c, maxConcurrent: Number(e.target.value) } : c,
                    )
                  }
                  className="h-8 text-xs"
                />
              </div>
            </div>
            {rt.models.subagentRoles?.length ? (
              <div className="border-t border-border pt-5">
                <h3 className="mb-3 text-sm font-semibold">SubAgent Roles</h3>
                <div className="grid gap-5 sm:grid-cols-2">
                  {rt.models.subagentRoles.map((r) => (
                    <ModelField
                      key={r.name}
                      label={r.displayName}
                      hint={r.name}
                      value={runtime.subagentModels[r.name] ?? ""}
                      models={models}
                      onChange={(v) =>
                        setRuntime((c) =>
                          c
                            ? {
                                ...c,
                                subagentModels: {
                                  ...c.subagentModels,
                                  [r.name]: v,
                                },
                              }
                            : c,
                        )
                      }
                    />
                  ))}
                </div>
              </div>
            ) : null}
            <div className="flex justify-end">
              <Button
                onClick={() => void saveRt()}
                disabled={busy !== null}
                size="sm"
              >
                <Icon icon="lucide:save" width="13" /> 保存
              </Button>
            </div>
          </Card>
        </TabsContent>

        <TabsContent value="platform" className="space-y-5">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">
                {plat?.setup.label ?? pcfg.platform.plugin}
              </h2>
              <p className="text-sm text-muted-foreground">
                {plat?.setup.description}
              </p>
            </div>
            <Badge
              tone={setup.state.phase === "ready" ? "positive" : "warning"}
              className="text-[10px]"
            >
              {setup.state.phase}
            </Badge>
          </div>
          <Card className="space-y-6 p-6">
            <div className="mb-5 max-w-md space-y-1.5">
              <div className="space-y-1.5">
                <Label className="text-xs font-medium text-muted-foreground">
                  显示名称
                </Label>
                <Input
                  value={pcfg.project.name}
                  onChange={(e) =>
                    setPcfg((c) =>
                      c
                        ? {
                            ...c,
                            project: { ...c.project, name: e.target.value },
                          }
                        : c,
                    )
                  }
                  className="h-8 text-xs"
                />
              </div>
            </div>
            {plat && strat ? (
              <PlatformSetupForm
                platform={plat}
                strategyId={strat.id}
                config={pconf}
                secrets={secrets}
                configuredSecrets={setup.secrets}
                onStrategyChange={(_id, defaults) => {
                  setPcfg((current) =>
                    current
                      ? {
                          ...current,
                          platform: {
                            ...current.platform,
                            config: { ...pconf, ...defaults },
                          },
                        }
                      : current,
                  )
                  setSecrets({})
                }}
                onConfigChange={(next) =>
                  setPcfg((current) =>
                    current
                      ? {
                          ...current,
                          platform: { ...current.platform, config: next },
                        }
                      : current,
                  )
                }
                onSecretsChange={setSecrets}
              />
            ) : null}
            <div className="flex justify-end">
              <Button
                onClick={() => void savePlat()}
                disabled={busy !== null}
                size="sm"
              >
                <Icon icon="lucide:plug-zap" width="13" /> 保存并重连
              </Button>
            </div>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}

function ModelField({
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
  onChange(v: string): void
}) {
  const id = useId()
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        {label}
        {hint ? ` · ${hint}` : ""}
      </Label>
      <Combobox
        id={id}
        value={value}
        onChange={onChange}
        placeholder="选择"
        emptyLabel="继承 Solver"
        searchPlaceholder="搜索..."
        emptyText="无匹配"
        options={models.map((m) => ({
          value: m.id,
          label: `${m.id} · ${m.provider}/${m.modelId}`,
          description: m.configured ? undefined : "不可用",
          disabled: !m.configured,
        }))}
      />
    </div>
  )
}
