import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom"
import { AppProvider, useApp } from "./app/AppProvider.tsx"
import { Spinner, TooltipProvider } from "./components/index.ts"
import { AppShell } from "./layouts/AppShell.tsx"
import { ChallengePage } from "./pages/ChallengePage.tsx"
import { LoginPage } from "./pages/LoginPage.tsx"
import { ProjectPage } from "./pages/ProjectPage.tsx"
import { NewProjectPage, ProjectsPage } from "./pages/ProjectsPage.tsx"
import {
  GlobalSettingsPage,
  ProjectSettingsPage,
} from "./pages/SettingsPage.tsx"

function AuthenticatedRoutes(): React.ReactElement {
  const { auth, loading } = useApp()
  if (loading || !auth) return <Spinner label="正在初始化控制面" />

  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      {auth.authenticated ? (
        <Route element={<AppShell />}>
          <Route index element={<ProjectsPage />} />
          <Route path="projects/new" element={<NewProjectPage />} />
          <Route path="settings" element={<GlobalSettingsPage />} />
          <Route path="projects/:projectId" element={<ProjectPage />} />
          <Route
            path="projects/:projectId/settings"
            element={<ProjectSettingsPage />}
          />
          <Route
            path="projects/:projectId/challenges/:challengeId"
            element={<ChallengePage />}
          />
        </Route>
      ) : (
        <Route path="*" element={<Navigate to="/login" replace />} />
      )}
      <Route
        path="*"
        element={<Navigate to={auth.authenticated ? "/" : "/login"} replace />}
      />
    </Routes>
  )
}

const root = document.querySelector<HTMLElement>("#root")
if (!root) throw new Error("缺少 #root 容器")

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <TooltipProvider>
        <AppProvider>
          <AuthenticatedRoutes />
        </AppProvider>
      </TooltipProvider>
    </BrowserRouter>
  </StrictMode>,
)
