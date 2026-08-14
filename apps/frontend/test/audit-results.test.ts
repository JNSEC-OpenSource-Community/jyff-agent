// @vitest-environment jsdom

import type { CodeAuditFindingsDocument } from "@ctf-agent/core"
import { render, screen } from "@testing-library/react"
import { createElement } from "react"
import { describe, expect, it } from "vite-plus/test"
import { AuditFindingsPanel } from "../src/pages/audit/AuditResultPanels.tsx"

const findings: CodeAuditFindingsDocument = {
  documentType: "codex-security.findings",
  schemaVersion: "1.0",
  scanId: "scan-1",
  findings: [
    {
      findingId: "finding-1",
      occurrenceId: "occurrence-1",
      ruleId: "auth.missing-check",
      identity: { anchor: "auth-entry" },
      fingerprints: { primary: "fingerprint-1" },
      title: "缺少授权",
      summary: "入口未检查权限",
      severity: { level: "high", score: 8.1 },
      confidence: { level: "high", rationale: "直接路径" },
      taxonomy: { category: "authorization", cwe: ["CWE-862"] },
      locations: [{ path: "src/auth.py", startLine: 10 }],
      codeEvidence: [
        {
          id: "evidence-1",
          label: "授权入口",
          path: "src/auth.py",
          startLine: 10,
          language: "python",
          code: "def check(user):\n    return user.name",
          explanation: "函数直接返回用户信息。",
        },
      ],
      remediation: "补充授权检查",
      provenance: { source: "local_plugin" },
    },
  ],
}

describe("audit result panels", () => {
  it("shows the finding evidence and its source code", () => {
    render(createElement(AuditFindingsPanel, { document: findings }))

    expect(screen.getByText("授权入口")).toBeTruthy()
    expect(document.querySelector("code")?.textContent).toContain("def check(user):")
    expect(screen.getByText("函数直接返回用户信息。")).toBeTruthy()
  })
})
