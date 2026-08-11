// @vitest-environment jsdom

import { describe, expect, it, vi } from "vite-plus/test"
import {
  applyTheme,
  readSidebarCollapsed,
  readTheme,
  SIDEBAR_COLLAPSED_STORAGE_KEY,
  THEME_STORAGE_KEY,
  writeSidebarCollapsed,
  writeTheme,
} from "../src/lib/preferences.ts"

describe("界面偏好", () => {
  it("持久化并恢复侧栏折叠状态", () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => values.set(key, value)),
    }

    writeSidebarCollapsed(true, storage)
    expect(storage.setItem).toHaveBeenCalledWith(SIDEBAR_COLLAPSED_STORAGE_KEY, "1")
    expect(readSidebarCollapsed(storage)).toBe(true)
    writeSidebarCollapsed(false, storage)
    expect(readSidebarCollapsed(storage)).toBe(false)
  })

  it("本地存储不可用时回退为展开状态", () => {
    const storage = {
      getItem: vi.fn(() => {
        throw new Error("storage disabled")
      }),
      setItem: vi.fn(() => {
        throw new Error("storage disabled")
      }),
    }

    expect(readSidebarCollapsed(storage)).toBe(false)
    expect(() => writeSidebarCollapsed(true, storage)).not.toThrow()
  })

  it("持久化主题并默认使用暗色", () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => values.set(key, value)),
    }

    expect(readTheme(storage)).toBe("dark")
    writeTheme("light", storage)
    expect(storage.setItem).toHaveBeenCalledWith(THEME_STORAGE_KEY, "light")
    expect(readTheme(storage)).toBe("light")
  })

  it("将主题同步到文档根节点", () => {
    applyTheme("dark")
    expect(document.documentElement.classList.contains("dark")).toBe(true)
    expect(document.documentElement.dataset.theme).toBe("dark")

    applyTheme("light")
    expect(document.documentElement.classList.contains("dark")).toBe(false)
    expect(document.documentElement.style.colorScheme).toBe("light")
  })
})
