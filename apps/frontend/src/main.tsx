import { lazy, StrictMode, Suspense } from "react"
import { createRoot } from "react-dom/client"
import { BrowserRouter, Navigate, Route, Routes, useParams } from "react-router-dom"
import "./styles.css"
import { AppProvider, isPluginEnabled, useApp } from "./app/AppProvider.tsx"
import { Spinner, Toaster, TooltipProvider } from "./components/index.ts"
import { AppShell } from "./layouts/AppShell.tsx"
import { applyTheme, readTheme } from "./lib/preferences.ts"

// 每个业务页面独立加载，避免首次打开控制面时下载 Markdown、代码高亮和拼音词库等仅特定页面需要的依赖。
const ChallengePage = lazy(() =>
  import("./pages/ChallengePage.tsx").then(({ ChallengePage }) => ({ default: ChallengePage })),
)
const AuditProjectsPage = lazy(() =>
  import("./pages/AuditProjectsPage.tsx").then(({ AuditProjectsPage }) => ({
    default: AuditProjectsPage,
  })),
)
const AuditDetailPage = lazy(() =>
  import("./pages/AuditDetailPage.tsx").then(({ AuditDetailPage }) => ({
    default: AuditDetailPage,
  })),
)
const NewAuditProjectPage = lazy(() =>
  import("./pages/NewAuditProjectPage.tsx").then(({ NewAuditProjectPage }) => ({
    default: NewAuditProjectPage,
  })),
)
const AuditSettingsPage = lazy(() =>
  import("./pages/AuditSettingsPage.tsx").then(({ AuditSettingsPage }) => ({
    default: AuditSettingsPage,
  })),
)
const FatherPage = lazy(() =>
  import("./pages/FatherPage.tsx").then(({ FatherPage }) => ({ default: FatherPage })),
)
const LoginPage = lazy(() =>
  import("./pages/LoginPage.tsx").then(({ LoginPage }) => ({ default: LoginPage })),
)
const ProjectPage = lazy(() =>
  import("./pages/ProjectPage.tsx").then(({ ProjectPage }) => ({ default: ProjectPage })),
)
const NewProjectPage = lazy(() =>
  import("./pages/ProjectsPage.tsx").then(({ NewProjectPage }) => ({ default: NewProjectPage })),
)
const ProjectsPage = lazy(() =>
  import("./pages/ProjectsPage.tsx").then(({ ProjectsPage }) => ({ default: ProjectsPage })),
)
const GlobalSettingsPage = lazy(() =>
  import("./pages/settings/index.ts").then(({ GlobalSettingsPage }) => ({
    default: GlobalSettingsPage,
  })),
)
const ProjectSettingsPage = lazy(() =>
  import("./pages/settings/index.ts").then(({ ProjectSettingsPage }) => ({
    default: ProjectSettingsPage,
  })),
)
const TokenUsagePage = lazy(() =>
  import("./pages/TokenUsagePage.tsx").then(({ TokenUsagePage }) => ({
    default: TokenUsagePage,
  })),
)

function TokenUsageRoute(): React.ReactElement {
  const { plugins } = useApp()
  const { projectId = "" } = useParams()
  if (!isPluginEnabled(plugins, "token-usage")) {
    return <Navigate to={`/projects/${encodeURIComponent(projectId)}`} replace />
  }
  return <TokenUsagePage />
}

function AuthenticatedRoutes(): React.ReactElement {
  const { auth, loading } = useApp()
  if (loading || !auth) return <Spinner label="正在初始化控制面" />

  return (
    <Suspense fallback={<Spinner label="加载页面" />}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        {auth.authenticated ? (
          <Route element={<AppShell />}>
            <Route index element={<ProjectsPage />} />
            <Route path="projects/new" element={<NewProjectPage />} />
            <Route path="audits" element={<AuditProjectsPage />} />
            <Route path="audits/new" element={<NewAuditProjectPage />} />
            <Route path="audits/:auditId" element={<AuditDetailPage />} />
            <Route path="audits/:auditId/settings" element={<AuditSettingsPage />} />
            <Route path="settings" element={<GlobalSettingsPage />} />
            <Route path="father" element={<FatherPage />} />
            <Route path="father/sessions/:sessionId" element={<FatherPage />} />
            <Route path="projects/:projectId" element={<ProjectPage />} />
            <Route path="projects/:projectId/settings" element={<ProjectSettingsPage />} />
            <Route path="projects/:projectId/token-usage" element={<TokenUsageRoute />} />
            <Route path="projects/:projectId/challenges/:challengeId" element={<ChallengePage />} />
          </Route>
        ) : (
          <Route path="*" element={<Navigate to="/login" replace />} />
        )}
        <Route path="*" element={<Navigate to={auth.authenticated ? "/" : "/login"} replace />} />
      </Routes>
    </Suspense>
  )
}

const root = document.querySelector<HTMLElement>("#root")
if (!root) throw new Error("缺少 #root 容器")

applyTheme(readTheme())

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <TooltipProvider>
        <AppProvider>
          <AuthenticatedRoutes />
          <Toaster position="bottom-right" richColors />
        </AppProvider>
      </TooltipProvider>
    </BrowserRouter>
  </StrictMode>,
)
