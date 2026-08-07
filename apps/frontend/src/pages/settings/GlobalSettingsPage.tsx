import { Icon } from "@iconify/react"
import { type FormEvent, useCallback, useEffect, useState } from "react"
import { useApp } from "../../app/AppProvider.tsx"
import {
  Badge,
  Button,
  Card,
  Checkbox,
  ErrorNotice,
  Input,
  PageHeader,
  Spinner,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "../../components/index.ts"
import { apiMutation, apiRequest } from "../../lib/api.ts"
import { errorMessage } from "../../lib/format.ts"
import type {
  ModelAuthenticationView,
  ModelConfigurationView,
} from "../../types.ts"
import { ModelPoolEditor } from "./ModelPoolEditor.tsx"
import { ProviderCredentialCard } from "./ProviderCredentialCard.tsx"

interface GlobalConfigurationResponse {
  authentication: { enabled: boolean; username: string | null }
  modelConfiguration: ModelConfigurationView | null
  modelAuthentication: ModelAuthenticationView | null
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
                <Button size="sm" variant="secondary" asChild>
                  <label className="cursor-pointer">
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
                            async (json) =>
                              await importAuthentication({ json }),
                          )
                        event.target.value = ""
                      }}
                    />
                  </label>
                </Button>
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
              <div className="toggle-line">
                <Checkbox
                  checked={authEnabled}
                  onCheckedChange={(checked) =>
                    setAuthEnabled(checked === true)
                  }
                />
                <span>
                  <strong>启用 WebUI 登录</strong>
                  <small>使用 HttpOnly、SameSite=Strict 会话 Cookie。</small>
                </span>
              </div>
              {authEnabled ? (
                <div className="form-grid form-grid-two">
                  <div className="field">
                    <span>管理员用户名</span>
                    <Input
                      value={username}
                      onChange={(event) => setUsername(event.target.value)}
                    />
                  </div>
                  <div className="field">
                    <span>
                      {configuration.authentication.enabled
                        ? "新密码（留空保持）"
                        : "管理员密码"}
                    </span>
                    <Input
                      type="password"
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                    />
                  </div>
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
