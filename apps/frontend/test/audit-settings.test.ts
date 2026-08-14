import { describe, expect, it } from "vite-plus/test"
import { tabFromSearch } from "../src/pages/AuditDetailPage.tsx"
import {
  buildAuditTree,
  removePath,
  settingsTabFromSearch,
  togglePath,
} from "../src/pages/AuditSettingsPage.tsx"

describe("audit source tree", () => {
  it("builds expandable directories from the normalized archive file list", () => {
    const tree = buildAuditTree([
      ".gitignore",
      "README.md",
      "src/index.ts",
      "src/lib/parser.ts",
      "tests/parser.test.ts",
    ])

    expect(tree.map((node) => node.name)).toEqual(["src", "tests", ".gitignore", "README.md"])
    expect(tree.find((node) => node.name === "src")?.file).toBe(false)
    expect([...(tree.find((node) => node.name === "src")?.children.keys() ?? [])]).toEqual([
      "index.ts",
      "lib",
    ])
  })

  it("toggles a rule and can remove the same path from the opposite set", () => {
    expect(togglePath("src/**\ntests/**", "src/**")).toBe("tests/**")
    expect(togglePath("tests/**", "src/**")).toBe("tests/**\nsrc/**")
    expect(removePath("src/**\ntests/**", "src/**")).toBe("tests/**")
  })

  it("keeps overview and settings tabs deep-linkable", () => {
    expect(tabFromSearch("coverage")).toBe("coverage")
    expect(tabFromSearch("unknown")).toBe("overview")
    expect(settingsTabFromSearch("scope")).toBe("scope")
    expect(settingsTabFromSearch(null)).toBe("model")
  })
})
