import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import type { RunSessionExportMetadata } from "@ctf-agent/core"
import { getPackageDir, SessionManager } from "@earendil-works/pi-coding-agent"
import type { DashboardConversation } from "../types.ts"

interface PiHtmlExportModule {
  exportFromFile(inputPath: string, outputPath?: string): Promise<string>
  exportSessionToHtml(
    session: SessionManager,
    state: RunSessionExportMetadata | undefined,
    outputPath?: string,
  ): Promise<string>
}

let piHtmlExportModule: Promise<PiHtmlExportModule> | undefined

/**
 * Pi 的根包未导出 exportFromFile；固定依赖版本后直接复用其 HTML 导出实现，
 * 不启动 CLI 子进程。
 */
async function loadPiHtmlExporter(): Promise<PiHtmlExportModule> {
  piHtmlExportModule ??= import(
    pathToFileURL(
      join(getPackageDir(), "dist", "core", "export-html", "index.js"),
    ).href
  ) as Promise<PiHtmlExportModule>
  return await piHtmlExportModule
}

/** 将 Pi 原生 JSONL session 渲染为独立 HTML 文档。 */
export async function exportPiSessionHtml(
  sessionPath: string,
  metadata?: RunSessionExportMetadata,
): Promise<Buffer> {
  const outputDirectory = await mkdtemp(join(tmpdir(), "ctf-agent-export-"))
  const outputPath = join(outputDirectory, "session.html")
  try {
    const exporter = await loadPiHtmlExporter()
    if (metadata) {
      await exporter.exportSessionToHtml(
        SessionManager.open(sessionPath),
        metadata,
        outputPath,
      )
    } else {
      await exporter.exportFromFile(sessionPath, outputPath)
    }
    return await readFile(outputPath)
  } finally {
    await rm(outputDirectory, { recursive: true, force: true })
  }
}

/** 只有至少一条 assistant 消息时，HTML 才包含可供查看的 Agent 对话。 */
export async function piSessionHasConversation(
  sessionPath: string,
): Promise<boolean> {
  return SessionManager.open(sessionPath)
    .getEntries()
    .some(
      (entry) => entry.type === "message" && entry.message.role === "assistant",
    )
}

/** 读取当前 Pi 分支上的原生消息，供 WebUI 的 Solver/SubAgent 对话视图复用。 */
export function readPiSessionConversation(
  sessionPath: string,
): DashboardConversation {
  const messages = SessionManager.open(sessionPath)
    .getBranch()
    .filter((entry) => entry.type === "message")
    .map((entry) => ({
      entryId: entry.id,
      timestamp: entry.timestamp,
      message: entry.message,
    }))
  return { messages }
}
