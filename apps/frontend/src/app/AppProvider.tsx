import type { ControlPlaneProjectSnapshot } from "@ctf-agent/core"
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

export interface AuthenticationState {
  enabled: boolean
  authenticated: boolean
  username: string | null
}

interface ProjectListResponse {
  projects: ProjectListItem[]
  selectedProjectId: string | null
}

export interface ProjectListItem extends ControlPlaneProjectSnapshot {
  solved: number
  total: number
}

interface AppContextValue {
  auth: AuthenticationState | null
  projects: ProjectListItem[]
  selectedProjectId: string | null
  loading: boolean
  refreshAuth: () => Promise<AuthenticationState>
  refreshProjects: () => Promise<void>
  logout: () => Promise<void>
}

const AppContext = createContext<AppContextValue | null>(null)

export function AppProvider({ children }: { children: ReactNode }): React.ReactElement {
  const [auth, setAuth] = useState<AuthenticationState | null>(null)
  const [projects, setProjects] = useState<ProjectListItem[]>([])
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const refreshAuth = useCallback(async (): Promise<AuthenticationState> => {
    const next = await apiRequest<AuthenticationState>("/api/auth")
    setAuth(next)
    return next
  }, [])

  const refreshProjects = useCallback(async (): Promise<void> => {
    const response = await apiRequest<ProjectListResponse>("/api/projects")
    setProjects(response.projects)
    setSelectedProjectId(response.selectedProjectId)
  }, [])

  useEffect(() => {
    let active = true
    void refreshAuth()
      .then(async (state) => {
        if (state.authenticated) await refreshProjects()
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [refreshAuth, refreshProjects])

  const logout = useCallback(async (): Promise<void> => {
    await apiMutation("/api/auth/logout", "POST")
    await refreshAuth()
    setProjects([])
  }, [refreshAuth])

  const value = useMemo<AppContextValue>(
    () => ({
      auth,
      projects,
      selectedProjectId,
      loading,
      refreshAuth,
      refreshProjects,
      logout,
    }),
    [auth, projects, selectedProjectId, loading, refreshAuth, refreshProjects, logout],
  )

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}

export function useApp(): AppContextValue {
  const context = useContext(AppContext)
  if (!context) throw new Error("useApp 必须在 AppProvider 中使用")
  return context
}
