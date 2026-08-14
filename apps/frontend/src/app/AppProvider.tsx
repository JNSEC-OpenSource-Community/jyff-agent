import type { CodeAuditProject, ControlPlaneProjectSnapshot } from "@ctf-agent/core"
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react"
import { apiMutation, apiRequest } from "../lib/api.ts"
import { errorMessage } from "../lib/format.ts"
import type {
  BuiltInPluginConfigurationView,
  BuiltInPluginId,
  BuiltInPluginView,
} from "../types.ts"
export interface AuthenticationState {
  enabled: boolean
  authenticated: boolean
  username: string | null
}
interface ProjectListResponse {
  projects: ProjectListItem[]
  selectedProjectId: string | null
  plugins?: BuiltInPluginConfigurationView
}
export interface ProjectListItem extends ControlPlaneProjectSnapshot {
  solved: number
  total: number
}
interface CodeAuditCatalogResponse {
  audits: CodeAuditProject[]
}
interface AppContextValue {
  auth: AuthenticationState | null
  projects: ProjectListItem[]
  auditProjects: CodeAuditProject[]
  plugins: BuiltInPluginView[]
  selectedProjectId: string | null
  loading: boolean
  bootstrapError: string
  refreshAuth: () => Promise<AuthenticationState>
  refreshProjects: () => Promise<void>
  refreshAuditProjects: () => Promise<void>
  retryBootstrap: () => Promise<void>
  logout: () => Promise<void>
}
const AppContext = createContext<AppContextValue | null>(null)
const DEFAULT_PLUGINS: BuiltInPluginView[] = [
  {
    id: "token-usage",
    name: "Token 消耗",
    description: "按比赛和模型汇总 Token 用量。",
    enabled: true,
    defaultEnabled: true,
  },
]
export function isPluginEnabled(
  plugins: readonly BuiltInPluginView[] | undefined,
  pluginId: BuiltInPluginId,
): boolean {
  return plugins?.find((plugin) => plugin.id === pluginId)?.enabled ?? true
}
export function AppProvider({ children }: { children: ReactNode }): React.ReactElement {
  const [auth, setAuth] = useState<AuthenticationState | null>(null)
  const [projects, setProjects] = useState<ProjectListItem[]>([])
  const [auditProjects, setAuditProjects] = useState<CodeAuditProject[]>([])
  const [plugins, setPlugins] = useState<BuiltInPluginView[]>(DEFAULT_PLUGINS)
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [bootstrapError, setBootstrapError] = useState("")
  const refreshAuth = useCallback(async () => {
    const next = await apiRequest<AuthenticationState>("/api/auth")
    setAuth(next)
    return next
  }, [])
  const refreshAuditProjects = useCallback(async () => {
    try {
      setAuditProjects((await apiRequest<CodeAuditCatalogResponse>("/api/audits")).audits)
    } catch {
      setAuditProjects([])
    }
  }, [])
  const refreshProjects = useCallback(async () => {
    const response = await apiRequest<ProjectListResponse>("/api/projects")
    setProjects(response.projects)
    setSelectedProjectId(response.selectedProjectId)
    setPlugins(response.plugins?.plugins ?? DEFAULT_PLUGINS)
    await refreshAuditProjects()
  }, [refreshAuditProjects])
  const bootstrap = useCallback(async () => {
    setLoading(true)
    setBootstrapError("")
    try {
      const state = await refreshAuth()
      if (state.authenticated) await refreshProjects()
    } catch (cause) {
      setBootstrapError(errorMessage(cause))
    } finally {
      setLoading(false)
    }
  }, [refreshAuth, refreshProjects])
  useEffect(() => {
    void bootstrap()
  }, [bootstrap])
  const logout = useCallback(async () => {
    await apiMutation("/api/auth/logout", "POST")
    await refreshAuth()
    setBootstrapError("")
    setProjects([])
    setAuditProjects([])
    setPlugins(DEFAULT_PLUGINS)
  }, [refreshAuth])
  const value = useMemo<AppContextValue>(
    () => ({
      auth,
      projects,
      auditProjects,
      plugins,
      selectedProjectId,
      loading,
      bootstrapError,
      refreshAuth,
      refreshProjects,
      refreshAuditProjects,
      retryBootstrap: bootstrap,
      logout,
    }),
    [
      auth,
      projects,
      auditProjects,
      plugins,
      selectedProjectId,
      loading,
      bootstrapError,
      refreshAuth,
      refreshProjects,
      refreshAuditProjects,
      bootstrap,
      logout,
    ],
  )
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}
export function useApp(): AppContextValue {
  const context = useContext(AppContext)
  if (!context) throw new Error("useApp 必须在 AppProvider 中使用")
  return context
}
