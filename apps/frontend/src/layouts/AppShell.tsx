import { Icon } from "@iconify/react"
import { useState } from "react"
import { NavLink, Outlet, useParams } from "react-router-dom"
import { useApp } from "../app/AppProvider.tsx"
import { MobileSheet, Tooltip } from "../components/index.ts"
import {
  applyTheme,
  readSidebarCollapsed,
  readTheme,
  writeSidebarCollapsed,
  writeTheme,
} from "../lib/preferences.ts"
import { cn } from "../lib/utils.ts"

const iconBtn =
  "group flex size-10 items-center justify-center rounded-md text-foreground/90 transition-colors duration-150 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 active:translate-y-px"
const iconLink = cn(
  iconBtn,
  "aria-[current=page]:bg-foreground/8 aria-[current=page]:text-foreground aria-[current=page]:ring-1 aria-[current=page]:ring-inset aria-[current=page]:ring-foreground/15",
)

const navItem =
  "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium transition-colors duration-150"
const navItemActive = "bg-foreground/[0.08] text-foreground ring-1 ring-inset ring-foreground/15"
const navItemIdle = "text-muted-foreground hover:text-foreground hover:bg-muted/50"

function SidebarNavLink({
  to,
  end,
  icon,
  children,
}: {
  to: string
  end?: boolean
  icon: string
  children: React.ReactNode
}) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) => cn(navItem, isActive ? navItemActive : navItemIdle)}
    >
      <Icon icon={icon} width={17} className="shrink-0" />
      {children}
    </NavLink>
  )
}

export function AppShell() {
  const { logout, auth } = useApp()
  const [collapsed, setCollapsed] = useState(readSidebarCollapsed)
  const [theme, setTheme] = useState(readTheme)
  const [mobileOpen, setMobileOpen] = useState(false)
  const toggleSidebar = () => {
    setCollapsed((current) => {
      const next = !current
      writeSidebarCollapsed(next)
      return next
    })
  }
  const toggleTheme = () => {
    setTheme((current) => {
      const next = current === "dark" ? "light" : "dark"
      applyTheme(next)
      writeTheme(next)
      return next
    })
  }

  return (
    <div className="flex h-dvh overflow-hidden">
      {/* ── Unified sidebar (wide) ── */}
      <aside
        className={cn(
          "sidebar-desktop shrink-0 flex-col border-r border-border bg-sidebar transition-[width] duration-200",
          collapsed ? "w-16" : "w-60",
        )}
      >
        <SidebarContent
          collapsed={collapsed}
          onToggle={toggleSidebar}
          onLogout={() => void logout()}
          authEnabled={auth?.enabled ?? false}
          theme={theme}
          onToggleTheme={toggleTheme}
        />
      </aside>

      {/* ── Mobile drawer ── */}
      <MobileSheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SidebarContent
          collapsed={false}
          onToggle={() => setMobileOpen(false)}
          onLogout={() => void logout()}
          authEnabled={auth?.enabled ?? false}
          theme={theme}
          onToggleTheme={toggleTheme}
          inMobile={true}
        />
      </MobileSheet>

      {/* ── Main ── */}
      <main className="main-mobile relative min-w-0 flex-1 overflow-y-auto">
        <div className="mobile-menu-bar">
          <button
            type="button"
            className="mobile-menu-trigger size-10 items-center justify-center rounded-md border border-border bg-card text-foreground"
            onClick={() => setMobileOpen(true)}
            aria-label="菜单"
          >
            <Icon icon="lucide:menu" width={19} />
          </button>
        </div>
        <div className="main-outlet">
          <Outlet />
        </div>
      </main>
    </div>
  )
}

function SidebarContent({
  collapsed,
  onToggle,
  onLogout,
  authEnabled,
  theme,
  onToggleTheme,
  inMobile = false,
}: {
  collapsed: boolean
  onToggle: () => void
  onLogout: () => void
  authEnabled: boolean
  theme: "dark" | "light"
  onToggleTheme: () => void
  inMobile?: boolean
}) {
  const { projectId } = useParams()
  const { projects } = useApp()
  const project = projects.find((p) => p.id === projectId)

  if (collapsed) {
    return (
      <div className="flex h-full flex-col items-center gap-1 px-3 py-4">
        {/* Logo */}
        <NavLink
          to="/"
          end
          className="mb-3 flex size-10 items-center justify-center rounded-md text-foreground transition-colors hover:bg-muted"
          aria-label="首页"
        >
          <Icon icon="unjs:automd" width={20} />
        </NavLink>

        {/* Three nav icons */}
        <Tooltip label="比赛列表">
          <NavLink to="/" end className={iconLink}>
            <Icon icon="lucide:blocks" width={18} />
          </NavLink>
        </Tooltip>
        <Tooltip label="创建比赛">
          <NavLink to="/projects/new" className={iconLink}>
            <Icon icon="lucide:plus" width={18} />
          </NavLink>
        </Tooltip>
        <Tooltip label="全局配置">
          <NavLink to="/settings" className={iconLink}>
            <Icon icon="lucide:settings-2" width={18} />
          </NavLink>
        </Tooltip>
        <Tooltip label="Clanker Father">
          <NavLink to="/father" className={iconLink}>
            <Icon icon="emojione-monotone:old-man" width={18} />
          </NavLink>
        </Tooltip>

        {/* Project-specific nav (when in a project) */}
        {projectId ? (
          <>
            <div className="my-2 h-px w-8 bg-border" />
            <Tooltip label="作战面板">
              <NavLink to={`/projects/${encodeURIComponent(projectId)}`} end className={iconLink}>
                <Icon icon="lucide:layout-dashboard" width={18} />
              </NavLink>
            </Tooltip>
            <Tooltip label="比赛设置">
              <NavLink
                to={`/projects/${encodeURIComponent(projectId)}/settings`}
                className={iconLink}
              >
                <Icon icon="lucide:sliders-horizontal" width={18} />
              </NavLink>
            </Tooltip>
          </>
        ) : null}

        <div className="mt-auto flex flex-col items-center gap-1.5">
          {authEnabled ? (
            <Tooltip label="退出">
              <button type="button" className={iconBtn} onClick={onLogout} aria-label="退出">
                <Icon icon="lucide:log-out" width={17} />
              </button>
            </Tooltip>
          ) : null}
          <Tooltip label={theme === "dark" ? "切换到亮色" : "切换到暗色"}>
            <button
              type="button"
              className={iconBtn}
              onClick={onToggleTheme}
              aria-label={theme === "dark" ? "切换到亮色模式" : "切换到暗色模式"}
            >
              <Icon icon={theme === "dark" ? "lucide:sun" : "lucide:moon"} width={17} />
            </button>
          </Tooltip>
          {!inMobile ? (
            <Tooltip label="展开侧栏">
              <button
                type="button"
                className={cn(iconBtn, "text-muted-foreground hover:text-foreground")}
                onClick={onToggle}
                aria-label="展开侧栏"
              >
                <Icon icon="lucide:panel-right" width={17} />
              </button>
            </Tooltip>
          ) : null}
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {/* Logo + project info */}
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
        <NavLink
          to="/"
          end
          className="flex size-9 shrink-0 items-center justify-center rounded-md text-foreground transition-colors hover:bg-muted"
          aria-label="首页"
        >
          <Icon icon="unjs:automd" width={18} />
        </NavLink>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "size-1.5 rounded-full shrink-0",
                project?.phase === "ready" ? "bg-green" : "bg-quiet",
              )}
            />
            <span className="text-[10px] font-semibold uppercase tracking-[0.15em] text-muted-foreground truncate">
              {project ? project.platformId : "比赛管理"}
            </span>
          </div>
          <h2 className="mt-0.5 truncate text-sm font-semibold tracking-tight">
            {project?.name ?? "JYFF Agent"}
          </h2>
        </div>
      </div>

      {/* Nav items */}
      <nav className="flex shrink-0 flex-col gap-0.5 border-b border-border px-2 py-2">
        <SidebarNavLink to="/" end icon="lucide:blocks">
          比赛列表
        </SidebarNavLink>
        <SidebarNavLink to="/projects/new" icon="lucide:plus">
          创建比赛
        </SidebarNavLink>
        <SidebarNavLink to="/settings" icon="lucide:settings-2">
          全局配置
        </SidebarNavLink>
        <SidebarNavLink to="/father" icon="emojione-monotone:old-man">
          Clanker Father
        </SidebarNavLink>
      </nav>

      {/* Project-specific nav */}
      {projectId ? (
        <nav className="flex shrink-0 flex-col gap-0.5 border-b border-border px-2 py-2">
          <SidebarNavLink
            to={`/projects/${encodeURIComponent(projectId)}`}
            end
            icon="lucide:layout-dashboard"
          >
            比赛概览
          </SidebarNavLink>
          <SidebarNavLink
            to={`/projects/${encodeURIComponent(projectId)}/settings`}
            icon="lucide:sliders-horizontal"
          >
            比赛设置
          </SidebarNavLink>
        </nav>
      ) : null}

      {/* Project list - fills remaining space, scrollable */}
      <div className="flex min-h-0 flex-1 flex-col">
        {projects.length > 0 ? (
          <>
            <div className="flex shrink-0 items-baseline justify-between px-4 pb-2 pt-3">
              <span className="text-[11px] font-medium text-muted-foreground">快速切换</span>
              <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                {projects.length}
              </span>
            </div>
            <nav aria-label="切换比赛" className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
              <div className="flex flex-col gap-1">
                {projects.map((p) => (
                  <NavLink
                    key={p.id}
                    to={`/projects/${encodeURIComponent(p.id)}`}
                    className={({ isActive }) =>
                      cn(
                        "group flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring/30",
                        isActive
                          ? "bg-foreground/[0.07] text-foreground ring-1 ring-inset ring-foreground/10"
                          : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                      )
                    }
                  >
                    <span className="flex size-6 shrink-0 items-center justify-center rounded-md border border-border bg-muted/40 font-mono text-[10px] font-medium text-muted-foreground transition-colors group-aria-[current=page]:border-foreground/15 group-aria-[current=page]:bg-foreground/6 group-aria-[current=page]:text-foreground">
                      {p.name[0]?.toUpperCase()}
                    </span>
                    <span className="truncate font-medium">{p.name}</span>
                  </NavLink>
                ))}
              </div>
            </nav>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center px-4 py-5">
            <p className="text-center text-xs text-muted-foreground">
              暂无比赛，点击上方「创建比赛」开始
            </p>
          </div>
        )}
      </div>

      {/* Bottom bar */}
      <div className="flex shrink-0 items-center justify-between border-t border-border px-4 py-2.5">
        {authEnabled ? (
          <button
            type="button"
            className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground hover:bg-muted"
            onClick={onLogout}
          >
            <Icon icon="lucide:log-out" width={14} />
            退出
          </button>
        ) : (
          <span />
        )}
        <div className="flex items-center gap-2">
          <Tooltip label={theme === "dark" ? "切换到亮色" : "切换到暗色"}>
            <button
              type="button"
              className="flex size-8 items-center justify-center rounded-md text-foreground/90 transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              onClick={onToggleTheme}
              aria-label={theme === "dark" ? "切换到亮色模式" : "切换到暗色模式"}
            >
              <Icon icon={theme === "dark" ? "lucide:sun" : "lucide:moon"} width={14} />
            </button>
          </Tooltip>
          {!inMobile ? (
            <button
              type="button"
              className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              onClick={onToggle}
              aria-label="收起侧栏"
            >
              <Icon icon="lucide:panel-left" width={15} />
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}
