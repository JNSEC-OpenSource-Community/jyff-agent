import { Icon } from "@iconify/react"
import { useMemo, useState } from "react"
import { Link, NavLink, Outlet, useLocation, useParams } from "react-router-dom"
import { useApp } from "../app/AppProvider.tsx"
import { MobileSheet, Tooltip } from "../components/index.ts"
import { cn } from "../lib/utils.ts"

interface NavItem {
  to: string
  label: string
  icon: string
  end?: boolean
}

function NavItems({
  items,
  onNavigate,
}: {
  items: NavItem[]
  onNavigate?(): void
}): React.ReactElement {
  return (
    <nav className="context-nav" aria-label="页面导航">
      {items.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          onClick={onNavigate}
          className={({ isActive }) =>
            cn("context-nav-item", isActive && "is-active")
          }
        >
          <Icon icon={item.icon} width="17" />
          <span>{item.label}</span>
        </NavLink>
      ))}
    </nav>
  )
}

function ContextSidebar({
  onNavigate,
}: {
  onNavigate?(): void
}): React.ReactElement {
  const { projectId } = useParams()
  const { projects } = useApp()
  const project = projects.find((candidate) => candidate.id === projectId)
  const items = useMemo<NavItem[]>(
    () =>
      projectId
        ? [
            {
              to: `/projects/${encodeURIComponent(projectId)}`,
              label: "作战总览",
              icon: "lucide:layout-dashboard",
              end: true,
            },
            {
              to: `/projects/${encodeURIComponent(projectId)}/settings`,
              label: "项目配置",
              icon: "lucide:sliders-horizontal",
            },
          ]
        : [
            { to: "/", label: "全部项目", icon: "lucide:layers-3", end: true },
            {
              to: "/projects/new",
              label: "创建项目",
              icon: "lucide:circle-plus",
            },
            {
              to: "/settings",
              label: "全局配置",
              icon: "lucide:settings-2",
            },
          ],
    [projectId],
  )

  return (
    <aside className="context-sidebar">
      <div className="context-sidebar-header">
        <p className="eyebrow">
          {project ? project.platformId : "CONTROL PLANE"}
        </p>
        <h2>{project?.name ?? "CTF Agent"}</h2>
        <div className="context-status">
          <span
            className={cn(
              "status-dot",
              project?.phase === "ready" && "is-ready",
            )}
          />
          {project ? phaseLabel(project.phase) : `${projects.length} 个项目`}
        </div>
      </div>
      <NavItems items={items} onNavigate={onNavigate} />
      <div className="context-sidebar-section">
        <div className="context-sidebar-section-title">
          <span>项目</span>
          <span>{projects.length}</span>
        </div>
        <div className="project-switcher">
          {projects.map((candidate) => (
            <NavLink
              key={candidate.id}
              to={`/projects/${encodeURIComponent(candidate.id)}`}
              onClick={onNavigate}
              className={({ isActive }) =>
                cn("project-switcher-item", isActive && "is-active")
              }
            >
              <span className="project-monogram">
                {candidate.name.slice(0, 1).toUpperCase()}
              </span>
              <span>
                <strong>{candidate.name}</strong>
                <small>{candidate.platformId}</small>
              </span>
            </NavLink>
          ))}
          {projects.length === 0 ? (
            <p className="sidebar-empty">尚未连接比赛平台</p>
          ) : null}
        </div>
      </div>
      <div className="context-sidebar-footer">
        <span className="text-muted-foreground text-[11px]">
          CTF Agent · Workspace v2
        </span>
      </div>
    </aside>
  )
}

function phaseLabel(phase: string): string {
  return (
    {
      ready: "平台已连接",
      disconnected: "等待连接",
      connecting: "正在连接",
      degraded: "连接异常",
      closing: "正在关闭",
    }[phase] ?? phase
  )
}

export function AppShell(): React.ReactElement {
  const { logout, auth } = useApp()
  const location = useLocation()
  const [mobileOpen, setMobileOpen] = useState(false)

  return (
    <div className="app-frame">
      <aside className="primary-rail">
        <Link to="/" className="brand-mark" aria-label="CTF Agent 首页">
          <Icon icon="lucide:crosshair" width="19" />
          <strong>CTF</strong>
        </Link>
        <nav className="rail-nav" aria-label="全局导航">
          <Tooltip label="项目">
            <NavLink
              to="/"
              className={({ isActive }) =>
                cn(
                  "rail-link",
                  isActive && location.pathname === "/" && "is-active",
                )
              }
            >
              <Icon icon="lucide:blocks" width="21" />
            </NavLink>
          </Tooltip>
          <Tooltip label="创建项目">
            <NavLink
              to="/projects/new"
              className={({ isActive }) =>
                cn("rail-link", isActive && "is-active")
              }
            >
              <Icon icon="lucide:plus" width="21" />
            </NavLink>
          </Tooltip>
          <Tooltip label="全局配置">
            <NavLink
              to="/settings"
              className={({ isActive }) =>
                cn("rail-link", isActive && "is-active")
              }
            >
              <Icon icon="lucide:settings" width="20" />
            </NavLink>
          </Tooltip>
        </nav>
        <div className="rail-bottom">
          {auth?.enabled ? (
            <Tooltip label={`退出 ${auth.username ?? "账户"}`}>
              <button
                type="button"
                className="rail-link"
                onClick={() => void logout()}
              >
                <Icon icon="lucide:log-out" width="20" />
              </button>
            </Tooltip>
          ) : null}
        </div>
      </aside>
      <div className="desktop-context">
        <ContextSidebar />
      </div>
      <MobileSheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <ContextSidebar onNavigate={() => setMobileOpen(false)} />
      </MobileSheet>
      <main className="app-main">
        <button
          type="button"
          className="mobile-menu"
          onClick={() => setMobileOpen(true)}
          aria-label="打开导航"
        >
          <Icon icon="lucide:panel-left" width="20" />
        </button>
        <Outlet />
      </main>
    </div>
  )
}
