import type { WorkspaceArtifactEntry } from "@ctf-agent/core"
import { Icon } from "@iconify/react"
import { useEffect, useState } from "react"
import { MarkdownContent } from "../../components/content/MarkdownContent.tsx"
import { SyntaxHighlightedCode } from "../../components/content/SyntaxHighlightedCode.tsx"
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  ErrorNotice,
  Spinner,
} from "../../components/index.ts"
import { apiRequest } from "../../lib/api.ts"
import { errorMessage } from "../../lib/format.ts"

export interface WorkspaceFilePreviewDescriptor {
  kind: "markdown" | "code" | "text"
  language: string
}

export interface PreviewableWorkspaceFile extends WorkspaceArtifactEntry {
  preview: WorkspaceFilePreviewDescriptor | null
}

interface WorkspaceFilePreview extends WorkspaceFilePreviewDescriptor {
  path: string
  size: number
  content: string
}

export function WorkspaceFilePreviewDialog({
  file,
  previewUrl,
  downloadUrl,
  onClose,
}: {
  file: PreviewableWorkspaceFile | null
  previewUrl: string | null
  downloadUrl: string | null
  onClose(): void
}) {
  const [preview, setPreview] = useState<WorkspaceFilePreview | null>(null)
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!file?.preview) {
      setPreview(null)
      setError("")
      setLoading(false)
      return
    }
    let active = true
    setPreview(null)
    setError("")
    setLoading(true)
    if (!previewUrl) {
      setLoading(false)
      return
    }
    void apiRequest<WorkspaceFilePreview>(previewUrl)
      .then((next) => {
        if (active) setPreview(next)
      })
      .catch((cause) => {
        if (active) setError(errorMessage(cause))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [file, previewUrl])

  const name = file?.path.split("/").pop() ?? "文件预览"
  return (
    <Dialog open={file !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <header className="flex min-h-14 shrink-0 items-center gap-2 border-b border-border px-3 sm:px-4">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-primary">
            <Icon icon="lucide:file-search" width="16" />
          </span>
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate font-mono text-xs font-semibold sm:text-sm">
              {name}
            </DialogTitle>
            <DialogDescription className="truncate font-mono text-[10px] text-muted-foreground sm:text-[11px]">
              {file?.path ?? "选择要预览的文件"}
            </DialogDescription>
          </div>
          {downloadUrl ? (
            <Button size="icon" variant="ghost" className="size-9" asChild>
              <a href={downloadUrl} download={name} aria-label={`下载 ${name}`}>
                <Icon icon="lucide:download" width="16" />
              </a>
            </Button>
          ) : null}
          <DialogClose asChild>
            <Button
              size="icon"
              variant="ghost"
              className="size-9"
              aria-label="关闭预览"
            >
              <Icon icon="lucide:x" width="17" />
            </Button>
          </DialogClose>
        </header>

        <div className="min-h-0 flex-1 overflow-auto bg-background/45">
          {loading ? (
            <div className="flex h-full min-h-48 items-center justify-center">
              <Spinner label="加载文件预览" />
            </div>
          ) : error ? (
            <div className="p-4 sm:p-6">
              <ErrorNotice message={error} />
            </div>
          ) : preview?.kind === "markdown" ? (
            <MarkdownContent className="mx-auto max-w-4xl p-4 sm:p-6">
              {preview.content}
            </MarkdownContent>
          ) : preview?.kind === "code" ? (
            <pre className="min-h-full min-w-full w-max p-4 font-mono text-xs leading-6 sm:p-6">
              <SyntaxHighlightedCode
                code={preview.content}
                language={preview.language}
              />
            </pre>
          ) : preview ? (
            <pre className="min-h-full min-w-full w-max whitespace-pre p-4 font-mono text-xs leading-6 text-foreground/90 sm:p-6">
              {preview.content}
            </pre>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}
