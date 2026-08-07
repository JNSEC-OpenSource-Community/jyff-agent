import * as TooltipPrimitive from "@radix-ui/react-tooltip"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom"
import { AppProvider, useApp } from "./app-context.tsx"
import { AppShell } from "./app-shell.tsx"
import { LoginPage } from "./login-page.tsx"
import { ProjectPage } from "./project-page.tsx"
import { NewProjectPage, ProjectsPage } from "./projects-page.tsx"
import {
  ChallengePlaceholder,
  GlobalSettingsPlaceholder,
  ProjectSettingsPlaceholder,
} from "./route-placeholders.tsx"
import { Spinner } from "./ui.tsx"

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
          <Route path="settings" element={<GlobalSettingsPlaceholder />} />
          <Route path="projects/:projectId" element={<ProjectPage />} />
          <Route
            path="projects/:projectId/settings"
            element={<ProjectSettingsPlaceholder />}
          />
          <Route
            path="projects/:projectId/challenges/:challengeId"
            element={<ChallengePlaceholder />}
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
      <TooltipPrimitive.Provider>
        <AppProvider>
          <AuthenticatedRoutes />
        </AppProvider>
      </TooltipPrimitive.Provider>
    </BrowserRouter>
  </StrictMode>,
)
