import { Icon } from "@iconify/react"
import { useState } from "react"
import { NavLink, Outlet, useParams } from "react-router-dom"
import { useApp } from "../app/AppProvider.tsx"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  MobileSheet,
  Tooltip,
} from "../components/index.ts"
import {
  readSidebarCollapsed,
  writeSidebarCollapsed,
} from "../lib/preferences.ts"
import { cn } from "../lib/utils.ts"

const iconBtn =
  "group flex size-9 items-center justify-center rounded-md text-muted-foreground transition-all duration-200 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 active:translate-y-px"
const iconLink = cn(
  iconBtn,
  "aria-[current=page]:bg-primary/10 aria-[current=page]:text-primary aria-[current=page]:shadow-[0_0_0_1px_rgba(94,106,210,0.18)_inset]",
)

const navItem =
  "flex items-center gap-2.5 rounded-lg text-sm font-medium transition-all duration-200 px-2.5 py-2"
const navItemActive =
  "bg-primary/10 text-primary shadow-[0_0_0_1px_rgba(94,106,210,0.12)_inset]"
const navItemIdle =
  "text-muted-foreground hover:text-foreground hover:bg-muted/50"

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
      className={({ isActive }) =>
        cn(navItem, isActive ? navItemActive : navItemIdle)
      }
    >
      <Icon icon={icon} width={16} className="shrink-0" />
      {children}
    </NavLink>
  )
}

export function AppShell() {
  const { logout, auth } = useApp()
  const [collapsed, setCollapsed] = useState(readSidebarCollapsed)
  const [mobileOpen, setMobileOpen] = useState(false)
  const toggleSidebar = () => {
    setCollapsed((current) => {
      const next = !current
      writeSidebarCollapsed(next)
      return next
    })
  }

  return (
    <div className="flex h-dvh overflow-hidden">
      {/* ── Unified sidebar (wide) ── */}
      <aside
        className={cn(
          "hide-sidebar flex shrink-0 flex-col border-r border-border bg-sidebar transition-all duration-300",
          collapsed ? "w-[56px]" : "w-60",
        )}
      >
        <SidebarContent
          collapsed={collapsed}
          onToggle={toggleSidebar}
          onLogout={() => void logout()}
          authEnabled={auth?.enabled ?? false}
        />
      </aside>

      {/* ── Mobile drawer ── */}
      <MobileSheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SidebarContent
          collapsed={false}
          onToggle={() => setMobileOpen(false)}
          onLogout={() => void logout()}
          authEnabled={auth?.enabled ?? false}
          inMobile={true}
        />
      </MobileSheet>

      {/* ── Main ── */}
      <main className="main-mobile relative min-w-0 flex-1 overflow-y-auto">
        <button
          type="button"
          className="show-mobile-menu fixed right-3 top-3 z-40 hidden size-9 items-center justify-center rounded-lg border border-border bg-card text-muted-foreground shadow-sm"
          onClick={() => setMobileOpen(true)}
          aria-label="菜单"
        >
          <Icon icon="lucide:menu" width={19} />
        </button>
        <Outlet />
      </main>
    </div>
  )
}

function SidebarContent({
  collapsed,
  onToggle,
  onLogout,
  authEnabled,
  inMobile = false,
}: {
  collapsed: boolean
  onToggle(): void
  onLogout(): void
  authEnabled: boolean
  inMobile?: boolean
}) {
  const { projectId } = useParams()
  const { projects } = useApp()
  const project = projects.find((p) => p.id === projectId)

  if (collapsed) {
    return (
      <div className="flex h-full flex-col items-center gap-1.5 px-2 py-4">
        {/* Logo */}
        <NavLink
          to="/"
          end
          className="mb-3 flex size-9 items-center justify-center rounded-xl text-primary transition-colors hover:bg-primary/5"
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
              <NavLink
                to={`/projects/${encodeURIComponent(projectId)}`}
                end
                className={iconLink}
              >
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
              <button
                type="button"
                className={iconBtn}
                onClick={onLogout}
                aria-label="退出"
              >
                <Icon icon="lucide:log-out" width={17} />
              </button>
            </Tooltip>
          ) : null}
          {!inMobile ? (
            <Tooltip label="展开侧栏">
              <button
                type="button"
                className={cn(
                  iconBtn,
                  "text-muted-foreground/50 hover:text-muted-foreground",
                )}
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
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-5 py-4">
        <NavLink
          to="/"
          end
          className="flex size-8 shrink-0 items-center justify-center rounded-xl text-primary transition-colors hover:bg-primary/5"
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
              {project ? project.platformId : "Workspace"}
            </span>
          </div>
          <h2 className="mt-0.5 truncate text-sm font-semibold tracking-tight">
            {project?.name ?? "JYFF Agent"}
          </h2>
        </div>
      </div>

      {/* Nav items */}
      <nav className="flex shrink-0 flex-col gap-0.5 border-b border-border px-2.5 py-2">
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
        <nav className="flex shrink-0 flex-col gap-0.5 border-b border-border px-2.5 py-2">
          <SidebarNavLink
            to={`/projects/${encodeURIComponent(projectId)}`}
            end
            icon="lucide:layout-dashboard"
          >
            作战面板
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
          <Collapsible defaultOpen className="flex min-h-0 flex-1 flex-col">
            <CollapsibleTrigger className="group flex shrink-0 items-center justify-between px-5 py-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground">
              全部比赛
              <span className="flex items-center gap-1.5">
                <span className="font-mono tabular-nums text-[10px]">
                  {projects.length}
                </span>
                <Icon
                  icon="lucide:chevron-down"
                  width={11}
                  className="transition-transform duration-200 group-data-[state=open]:rotate-180"
                />
              </span>
            </CollapsibleTrigger>
            <CollapsibleContent className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-2">
              <div className="flex flex-col gap-0.5">
                {projects.map((p) => (
                  <NavLink
                    key={p.id}
                    to={`/projects/${encodeURIComponent(p.id)}`}
                    className={({ isActive }) =>
                      cn(
                        "flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm transition-colors duration-200",
                        isActive
                          ? "bg-primary/10 text-primary"
                          : "text-muted-foreground hover:text-foreground hover:bg-muted/50",
                      )
                    }
                  >
                    <span className="flex size-6 shrink-0 items-center justify-center rounded-md border border-border bg-muted/50 text-[10px] font-semibold text-primary font-mono">
                      {p.name[0]?.toUpperCase()}
                    </span>
                    <span className="truncate">{p.name}</span>
                  </NavLink>
                ))}
              </div>
            </CollapsibleContent>
          </Collapsible>
        ) : (
          <div className="flex flex-1 items-center justify-center px-5 py-6">
            <p className="text-center text-xs text-muted-foreground">
              暂无比赛，点击上方「创建比赛」开始
            </p>
          </div>
        )}
      </div>

      {/* Bottom bar */}
      <div className="flex shrink-0 items-center justify-between border-t border-border px-5 py-3">
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
          {!inMobile ? (
            <button
              type="button"
              className="flex size-7 items-center justify-center rounded-md text-muted-foreground/50 transition-colors hover:bg-muted hover:text-muted-foreground"
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
