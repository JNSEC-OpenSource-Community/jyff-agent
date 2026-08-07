import type {
  ControlPlaneSetupSnapshot,
  PlatformConnectionTest,
  ProjectConfig,
} from "@ctf-agent/core"
import { Icon } from "@iconify/react"
import { useEffect, useMemo, useState } from "react"
import { Link, useNavigate } from "react-router-dom"
import { apiMutation, apiRequest } from "./api.ts"
import { useApp } from "./app-context.tsx"
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  PageHeader,
  Spinner,
} from "./ui.tsx"

export function ProjectsPage(): React.ReactElement {
  const { projects, loading } = useApp()

  if (loading) return <Spinner label="正在读取项目注册表" />

  return (
    <div className="page page-projects">
      <PageHeader
        eyebrow="WORKSPACES"
        title="比赛项目"
        description="每个项目拥有独立的运行状态、调度队列与 Sandbox 工作区。"
        actions={
          <Button asChild>
            <Link to="/projects/new">
              <Icon icon="lucide:plus" width="17" /> 新建项目
            </Link>
          </Button>
        }
      />
      {projects.length === 0 ? (
        <Card>
          <EmptyState
            icon="lucide:radar"
            title="还没有比赛项目"
            description="连接 CTFd 或 GZCTF 后，Agent 才能同步题目并开始调度。"
            action={
              <Button asChild>
                <Link to="/projects/new">连接第一个平台</Link>
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="project-grid">
          {projects.map((project, index) => (
            <Link
              key={project.id}
              className="project-card"
              to={`/projects/${encodeURIComponent(project.id)}`}
            >
              <div className="project-card-index">
                {String(index + 1).padStart(2, "0")}
              </div>
              <div className="project-card-platform">{project.platformId}</div>
              <h2>{project.name}</h2>
              <p className="project-card-id">{project.id}</p>
              <div className="project-card-footer">
                <Badge
                  tone={project.phase === "ready" ? "positive" : "warning"}
                >
                  {project.phase === "ready" ? "已连接" : "待恢复"}
                </Badge>
                <span>
                  进入作战面板 <Icon icon="lucide:arrow-up-right" width="16" />
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}

interface SetupField {
  key: string
  label: string
  type: "text" | "url" | "integer"
  required: boolean
  placeholder?: string
  minimum?: number
  maximum?: number
}

interface SecretField {
  name: string
  label: string
  type: "text" | "password" | "token" | "cookie"
  required: boolean
}

interface SetupStrategy {
  id: string
  label: string
  config: Record<string, unknown>
  secrets: SecretField[]
}

interface SetupPlatform {
  id: string
  setup: {
    label: string
    description: string
    defaultConfig: Record<string, unknown>
    fields: SetupField[]
    authStrategies: SetupStrategy[]
  }
}

function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
}

export function NewProjectPage(): React.ReactElement {
  const navigate = useNavigate()
  const { refreshProjects } = useApp()
  const [setup, setSetup] = useState<ControlPlaneSetupSnapshot | null>(null)
  const [platformId, setPlatformId] = useState("")
  const [strategyId, setStrategyId] = useState("")
  const [projectId, setProjectId] = useState("")
  const [projectName, setProjectName] = useState("")
  const [identityTouched, setIdentityTouched] = useState(false)
  const [config, setConfig] = useState<Record<string, unknown>>({})
  const [secrets, setSecrets] = useState<Record<string, string>>({})
  const [testResult, setTestResult] = useState<PlatformConnectionTest | null>(
    null,
  )
  const [error, setError] = useState("")
  const [busy, setBusy] = useState<"test" | "create" | null>(null)

  useEffect(() => {
    void apiRequest<ControlPlaneSetupSnapshot>("/api/control-plane")
      .then((snapshot) => {
        setSetup(snapshot)
        const first = snapshot.platforms[0] as SetupPlatform | undefined
        if (first) {
          const firstStrategy = first.setup.authStrategies[0]
          setPlatformId(first.id)
          setStrategyId(firstStrategy?.id ?? "")
          setConfig({
            ...first.setup.defaultConfig,
            ...(firstStrategy?.config ?? {}),
          })
        }
      })
      .catch((cause) =>
        setError(cause instanceof Error ? cause.message : String(cause)),
      )
  }, [])

  const platforms = (setup?.platforms ?? []) as SetupPlatform[]
  const platform = platforms.find((candidate) => candidate.id === platformId)
  const strategy = platform?.setup.authStrategies.find(
    (candidate) => candidate.id === strategyId,
  )

  function selectPlatform(next: SetupPlatform): void {
    setPlatformId(next.id)
    const nextStrategy = next.setup.authStrategies[0]
    setStrategyId(nextStrategy?.id ?? "")
    setConfig({ ...next.setup.defaultConfig, ...(nextStrategy?.config ?? {}) })
    setSecrets({})
    setTestResult(null)
  }

  function selectStrategy(nextId: string): void {
    const next = platform?.setup.authStrategies.find(
      (item) => item.id === nextId,
    )
    setStrategyId(nextId)
    if (next) setConfig((current) => ({ ...current, ...next.config }))
    setSecrets({})
    setTestResult(null)
  }

  const payload = useMemo(() => {
    const safeName = projectName.trim() || "待连接比赛"
    const safeId = projectId.trim() || `contest-${Date.now()}`
    const project: ProjectConfig = {
      version: 1,
      project: { id: safeId, name: safeName },
      platform: { plugin: platformId, config },
      sandbox: {
        image: "ctf-agent-solver:latest",
        privileged: false,
        networkMode: "bridge",
      },
    }
    return { config: project, secrets }
  }, [config, platformId, projectId, projectName, secrets])

  async function testConnection(): Promise<void> {
    setBusy("test")
    setError("")
    try {
      const result = await apiMutation<PlatformConnectionTest>(
        "/api/projects/test",
        "POST",
        payload,
      )
      setTestResult(result)
      if (!identityTouched) {
        setProjectName(result.overview.name)
        setProjectId(slugify(result.overview.name) || result.overview.id)
      }
    } catch (cause) {
      setTestResult(null)
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }

  async function createProject(): Promise<void> {
    setBusy("create")
    setError("")
    try {
      const result = await apiMutation<{
        project: { projectId: string | null }
      }>("/api/projects", "POST", payload)
      await refreshProjects()
      navigate(
        `/projects/${encodeURIComponent(result.project.projectId ?? payload.config.project.id)}`,
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }

  if (!setup) return <Spinner label="正在读取平台插件" />

  return (
    <div className="page page-narrow">
      <PageHeader
        eyebrow="NEW WORKSPACE"
        title="连接比赛平台"
        description="先验证连接；成功后自动从比赛名称生成项目 ID 与显示名称，你仍可以覆盖。"
      />
      {error ? <ErrorNotice message={error} /> : null}
      <div className="setup-layout">
        <Card className="form-card">
          <section className="form-section">
            <div className="section-number">01</div>
            <div className="section-content">
              <h2>平台类型</h2>
              <div className="choice-grid">
                {platforms.map((candidate) => (
                  <button
                    type="button"
                    key={candidate.id}
                    className={
                      candidate.id === platformId
                        ? "choice-card is-selected"
                        : "choice-card"
                    }
                    onClick={() => selectPlatform(candidate)}
                  >
                    <strong>{candidate.setup.label}</strong>
                    <span>{candidate.setup.description}</span>
                  </button>
                ))}
              </div>
            </div>
          </section>
          <section className="form-section">
            <div className="section-number">02</div>
            <div className="section-content">
              <h2>连接信息</h2>
              <div className="form-grid">
                {platform?.setup.fields.map((field) => (
                  <label className="field" key={field.key}>
                    <span>
                      {field.label}
                      {field.required ? " *" : ""}
                    </span>
                    <input
                      type={field.type === "integer" ? "number" : field.type}
                      required={field.required}
                      min={field.minimum}
                      max={field.maximum}
                      placeholder={field.placeholder}
                      value={String(config[field.key] ?? "")}
                      onChange={(event) =>
                        setConfig((current) => ({
                          ...current,
                          [field.key]:
                            field.type === "integer"
                              ? Number(event.target.value)
                              : event.target.value,
                        }))
                      }
                    />
                  </label>
                ))}
              </div>
              {platform && platform.setup.authStrategies.length > 1 ? (
                <fieldset className="segmented-control">
                  <legend className="sr-only">认证方式</legend>
                  {platform.setup.authStrategies.map((candidate) => (
                    <button
                      type="button"
                      key={candidate.id}
                      className={candidate.id === strategyId ? "is-active" : ""}
                      onClick={() => selectStrategy(candidate.id)}
                    >
                      {candidate.label}
                    </button>
                  ))}
                </fieldset>
              ) : null}
              <div className="form-grid">
                {strategy?.secrets.map((field) => (
                  <label className="field" key={field.name}>
                    <span>
                      {field.label}
                      {field.required ? " *" : ""}
                    </span>
                    <input
                      type={
                        field.type === "password" ||
                        field.type === "token" ||
                        field.type === "cookie"
                          ? "password"
                          : "text"
                      }
                      autoComplete="off"
                      value={secrets[field.name] ?? ""}
                      onChange={(event) =>
                        setSecrets((current) => ({
                          ...current,
                          [field.name]: event.target.value,
                        }))
                      }
                    />
                  </label>
                ))}
              </div>
              <Button
                type="button"
                variant="secondary"
                onClick={() => void testConnection()}
                disabled={busy !== null}
              >
                <Icon
                  icon={
                    busy === "test" ? "lucide:loader-circle" : "lucide:plug-zap"
                  }
                  className={busy === "test" ? "spin" : ""}
                  width="17"
                />
                验证连接
              </Button>
              {testResult ? (
                <div className="connection-result">
                  <Icon icon="lucide:circle-check" width="18" />
                  <span>
                    <strong>{testResult.overview.name}</strong> ·{" "}
                    {testResult.overview.challenges} 题 ·{" "}
                    {testResult.overview.announcements} 条公告
                  </span>
                </div>
              ) : null}
            </div>
          </section>
          <section className="form-section">
            <div className="section-number">03</div>
            <div className="section-content">
              <h2>项目身份</h2>
              <div className="form-grid form-grid-two">
                <label className="field">
                  <span>项目 ID</span>
                  <input
                    value={projectId}
                    placeholder="自动生成"
                    onChange={(event) => {
                      setIdentityTouched(true)
                      setProjectId(event.target.value)
                    }}
                  />
                  <small>用于路由与持久化命名空间，创建后不应修改。</small>
                </label>
                <label className="field">
                  <span>显示名称</span>
                  <input
                    value={projectName}
                    placeholder="自动读取比赛名称"
                    onChange={(event) => {
                      setIdentityTouched(true)
                      setProjectName(event.target.value)
                    }}
                  />
                </label>
              </div>
            </div>
          </section>
          <div className="form-actions">
            <Button variant="ghost" asChild>
              <Link to="/">取消</Link>
            </Button>
            <Button
              type="button"
              onClick={() => void createProject()}
              disabled={
                !testResult ||
                !projectId.trim() ||
                !projectName.trim() ||
                busy !== null
              }
            >
              {busy === "create" ? (
                <Icon icon="lucide:loader-circle" className="spin" width="17" />
              ) : (
                <Icon icon="lucide:arrow-right" width="17" />
              )}
              创建并进入项目
            </Button>
          </div>
        </Card>
      </div>
    </div>
  )
}
