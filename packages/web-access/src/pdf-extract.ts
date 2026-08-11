/**
 * PDF Content Extractor
 *
 * Uses Gemini for structured PDF-to-Markdown conversion when configured,
 * with unpdf as the deterministic local fallback.
 */

import { mkdir, writeFile } from "node:fs/promises"
import { basename, join } from "node:path"
import { CredentialResolutionError } from "./credential-source.ts"
import { isGeminiApiAvailable } from "./gemini-api.ts"
import { extractPDFViaGemini } from "./gemini-pdf-extract.ts"
import { getRuntime } from "./runtime.ts"

export interface PDFExtractResult {
  title: string
  pages: number
  chars: number
  outputPath: string
}

export interface PDFExtractOptions {
  maxPages?: number
  outputDir?: string
  filename?: string
  signal?: AbortSignal
  geminiTimeoutMs?: number
}

export interface PDFConfig {
  maxSizeMB: number
}

export const DEFAULT_PDF_MAX_SIZE_MB = 20
export const MAX_PDF_MAX_SIZE_MB = 50
const DEFAULT_MAX_PAGES = 100
const PAGE_MARKER_PATTERN = /^<!-- Page (\d+) -->$/gm

export function loadPDFConfig(): PDFConfig {
  return { maxSizeMB: DEFAULT_PDF_MAX_SIZE_MB }
}

function resolveOutputDir(): string {
  const pdfDir = getRuntime().pdfDir
  if (!pdfDir) {
    throw new Error("PDF extraction disabled (no sandbox-visible workspace path).")
  }
  return pdfDir
}

async function getUnpdf() {
  if (typeof (Promise as PromiseConstructor & { try?: unknown }).try !== "function") {
    const { default: promiseTry } = await import("promise.try")
    promiseTry.shim()
  }

  const [unpdf, pdfjs] = await Promise.all([import("unpdf"), import("unpdf/pdfjs")])
  const { VerbosityLevel } = pdfjs as typeof pdfjs & {
    VerbosityLevel: { ERRORS: number }
  }

  return { getDocumentProxy: unpdf.getDocumentProxy, VerbosityLevel }
}

/**
 * Extract text from a PDF buffer and save it to a Markdown file.
 */
export async function extractPDFToMarkdown(
  buffer: ArrayBuffer,
  url: string,
  options: PDFExtractOptions = {},
): Promise<PDFExtractResult> {
  const { maxPages = DEFAULT_MAX_PAGES, outputDir, filename, signal, geminiTimeoutMs } = options
  const resolvedOutputDir = outputDir ?? resolveOutputDir()

  const safeMaxPages = Number.isFinite(maxPages)
    ? Math.max(1, Math.floor(maxPages))
    : DEFAULT_MAX_PAGES
  const urlTitle = extractTitleFromURL(url)

  try {
    if (isGeminiApiAvailable()) {
      const markdownBody = await extractPDFViaGemini(buffer, {
        maxPages: safeMaxPages,
        title: urlTitle,
        ...(signal ? { signal } : {}),
        ...(geminiTimeoutMs !== undefined ? { timeoutMs: geminiTimeoutMs } : {}),
      })
      return writeMarkdownResult({
        markdownBody,
        title: urlTitle,
        pages: countPageMarkers(markdownBody),
        outputDir: resolvedOutputDir,
        filename,
        url,
      })
    }
  } catch (err) {
    if (shouldRethrowGeminiError(err, signal)) throw err
  }

  const { getDocumentProxy, VerbosityLevel } = await getUnpdf()
  const pdf = await getDocumentProxy(new Uint8Array(buffer), {
    verbosity: VerbosityLevel.ERRORS,
  })
  const metadata = await pdf.getMetadata()
  const metadataInfo =
    metadata.info && typeof metadata.info === "object"
      ? (metadata.info as Record<string, unknown>)
      : null

  const metaTitle = typeof metadataInfo?.Title === "string" ? metadataInfo.Title : undefined
  const metaAuthor = typeof metadataInfo?.Author === "string" ? metadataInfo.Author : undefined
  const title = metaTitle?.trim() || urlTitle
  const pagesToExtract = Math.min(pdf.numPages, safeMaxPages)
  const truncated = pdf.numPages > safeMaxPages
  const pages: { pageNum: number; text: string }[] = []

  for (let i = 1; i <= pagesToExtract; i++) {
    const page = await pdf.getPage(i)
    const textContent = await page.getTextContent()
    const pageText = textContent.items
      .map((item: unknown) => {
        const textItem = item as { str?: string }
        return textItem.str || ""
      })
      .join(" ")
      .replace(/\s+/g, " ")
      .trim()

    if (pageText) {
      pages.push({ pageNum: i, text: pageText })
    }
  }

  const bodyLines: string[] = []
  for (let i = 0; i < pages.length; i++) {
    if (i > 0) {
      bodyLines.push("")
      bodyLines.push(`<!-- Page ${pages[i]!.pageNum} -->`)
      bodyLines.push("")
    }
    bodyLines.push(pages[i]!.text)
  }

  return writeMarkdownResult({
    markdownBody: bodyLines.join("\n"),
    title,
    pages: pdf.numPages,
    outputDir: resolvedOutputDir,
    filename,
    url,
    metaAuthor,
    truncated,
    pagesToExtract,
  })
}

async function writeMarkdownResult(options: {
  markdownBody: string
  title: string
  pages: number
  outputDir: string
  filename?: string
  url: string
  metaAuthor?: string
  truncated?: boolean
  pagesToExtract?: number
}): Promise<PDFExtractResult> {
  const lines: string[] = []
  lines.push(`# ${options.title}`)
  lines.push("")
  lines.push(`> Source: ${options.url}`)
  lines.push(
    `> Pages: ${options.pages}${options.truncated ? ` (extracted first ${options.pagesToExtract})` : ""}`,
  )
  if (options.metaAuthor) lines.push(`> Author: ${options.metaAuthor}`)
  lines.push("")
  lines.push("---")
  lines.push("")
  if (options.markdownBody) lines.push(options.markdownBody)

  if (options.truncated) {
    lines.push("")
    lines.push("---")
    lines.push("")
    lines.push(
      `*[Truncated: Only first ${options.pagesToExtract} of ${options.pages} pages extracted]*`,
    )
  }

  const content = lines.join("\n")
  const outputFilename = options.filename || `${sanitizeFilename(options.title)}.md`
  const outputPath = join(options.outputDir, outputFilename)

  await mkdir(options.outputDir, { recursive: true })
  await writeFile(outputPath, content, "utf-8")

  return {
    title: options.title,
    pages: options.pages,
    chars: content.length,
    outputPath,
  }
}

function countPageMarkers(markdown: string): number {
  return [...markdown.matchAll(PAGE_MARKER_PATTERN)].length
}

function shouldRethrowGeminiError(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true
  if (err instanceof CredentialResolutionError) return true
  const message = err instanceof Error ? err.message : String(err)
  return message.startsWith("Failed to parse ")
}

/**
 * Extract a reasonable title from URL
 */
function extractTitleFromURL(url: string): string {
  try {
    const urlObj = new URL(url)
    const pathname = urlObj.pathname

    let filename = basename(pathname, ".pdf")

    if (urlObj.hostname.includes("arxiv.org")) {
      const match = pathname.match(/\/(?:pdf|abs)\/(\d+\.\d+)/)
      if (match) {
        filename = `arxiv-${match[1]}`
      }
    }

    filename = filename.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim()

    return filename || "document"
  } catch {
    return "document"
  }
}

/**
 * Sanitize string for use as filename
 */
function sanitizeFilename(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .slice(0, 100)
      .replace(/^-|-$/g, "") || "document"
  )
}

/**
 * Check if URL or content-type indicates a PDF
 */
export function isPDF(url: string, contentType?: string): boolean {
  if (contentType?.includes("application/pdf")) {
    return true
  }
  try {
    const urlObj = new URL(url)
    return urlObj.pathname.toLowerCase().endsWith(".pdf")
  } catch {
    return false
  }
}
