export const SIDEBAR_COLLAPSED_STORAGE_KEY = "ctf-agent.sidebar-collapsed"
export const THEME_STORAGE_KEY = "ctf-agent.theme"

export type ColorTheme = "dark" | "light"

type PreferenceStorage = Pick<Storage, "getItem" | "setItem">

export function readSidebarCollapsed(
  storage: PreferenceStorage | undefined = browserStorage(),
): boolean {
  try {
    return storage?.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "1"
  } catch {
    return false
  }
}

export function writeSidebarCollapsed(
  collapsed: boolean,
  storage: PreferenceStorage | undefined = browserStorage(),
): void {
  try {
    storage?.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, collapsed ? "1" : "0")
  } catch {
    // 浏览器禁用本地存储时仍保留当前会话内状态。
  }
}

export function readTheme(storage: PreferenceStorage | undefined = browserStorage()): ColorTheme {
  try {
    return storage?.getItem(THEME_STORAGE_KEY) === "light" ? "light" : "dark"
  } catch {
    return "dark"
  }
}

export function writeTheme(
  theme: ColorTheme,
  storage: PreferenceStorage | undefined = browserStorage(),
): void {
  try {
    storage?.setItem(THEME_STORAGE_KEY, theme)
  } catch {
    // 浏览器禁用本地存储时仍保留当前会话内状态。
  }
}

export function applyTheme(theme: ColorTheme, root: HTMLElement | undefined = browserRoot()): void {
  if (!root) return
  root.classList.toggle("dark", theme === "dark")
  root.dataset.theme = theme
  root.style.colorScheme = theme
}

function browserStorage(): PreferenceStorage | undefined {
  return typeof window === "undefined" ? undefined : window.localStorage
}

function browserRoot(): HTMLElement | undefined {
  return typeof document === "undefined" ? undefined : document.documentElement
}
