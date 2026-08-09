export const SIDEBAR_COLLAPSED_STORAGE_KEY = "ctf-agent.sidebar-collapsed"

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

function browserStorage(): PreferenceStorage | undefined {
  return typeof window === "undefined" ? undefined : window.localStorage
}
