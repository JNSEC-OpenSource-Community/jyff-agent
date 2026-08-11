import { Icon } from "@iconify/react"
import { useCallback, useEffect, useState } from "react"
import { Button, EmptyState, ErrorNotice, Spinner } from "../../components/index.ts"
import { apiRequest, projectApi } from "../../lib/api.ts"
import { errorMessage } from "../../lib/format.ts"
import { absoluteTime } from "../../lib/time.ts"
import {
  type PreviewableWorkspaceFile,
  WorkspaceFilePreviewDialog,
} from "./WorkspaceFilePreviewDialog.tsx"

interface WorkspaceFileListing {
  files: PreviewableWorkspaceFile[]
  truncated: boolean
}

export function WorkspaceFilesPanel({
  projectId,
  challengeId,
}: {
  projectId: string
  challengeId: string
}) {
  const baseUrl = projectApi(projectId, `/api/challenges/${encodeURIComponent(challengeId)}/files`)
  return (
    <WorkspaceFilesBrowser
      listUrl={baseUrl}
      previewUrl={(path) => `${baseUrl}/preview?path=${encodeURIComponent(path)}`}
      downloadUrl={(path) => `${baseUrl}/download?path=${encodeURIComponent(path)}`}
      emptyDescription="派发 Solver 后，附件与生成的分析文件会显示在这里。"
    />
  )
}

export function WorkspaceFilesBrowser({
  listUrl,
  previewUrl,
  downloadUrl,
  emptyDescription,
}: {
  listUrl: string
  previewUrl: (path: string) => string
  downloadUrl: (path: string) => string
  emptyDescription: string
}) {
  const [listing, setListing] = useState<WorkspaceFileListing | null>(null)
  const [previewFile, setPreviewFile] = useState<PreviewableWorkspaceFile | null>(null)
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    setError("")
    try {
      setListing(await apiRequest<WorkspaceFileListing>(listUrl))
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setLoading(false)
    }
  }, [listUrl])

  useEffect(() => {
    void load()
  }, [load])

  if (loading && !listing) return <Spinner label="加载 workspace 文件" />

  return (
    <div className="w-full">
      {error ? <ErrorNotice message={error} className="mb-4" /> : null}
      {listing?.truncated ? (
        <div className="mb-3 rounded-lg border border-amber/30 bg-amber/10 px-3 py-2 text-xs text-amber">
          文件超过 2,000 项，仅显示前 2,000 项。
        </div>
      ) : null}
      {listing && listing.files.length > 0 ? (
        <WorkspaceFileTree
          files={listing.files}
          downloadUrl={downloadUrl}
          onPreview={setPreviewFile}
        />
      ) : !loading ? (
        <EmptyState
          icon="lucide:folder-open"
          title="Workspace 还是空的"
          description={emptyDescription}
        />
      ) : null}
      <WorkspaceFilePreviewDialog
        file={previewFile}
        previewUrl={previewFile ? previewUrl(previewFile.path) : null}
        downloadUrl={previewFile ? downloadUrl(previewFile.path) : null}
        onClose={() => setPreviewFile(null)}
      />
    </div>
  )
}

interface WorkspaceTreeDirectory {
  name: string
  path: string
  directories: Map<string, WorkspaceTreeDirectory>
  files: PreviewableWorkspaceFile[]
}

function WorkspaceFileTree({
  files,
  downloadUrl,
  onPreview,
}: {
  files: PreviewableWorkspaceFile[]
  downloadUrl: (path: string) => string
  onPreview: (file: PreviewableWorkspaceFile) => void
}) {
  const root = buildWorkspaceTree(files)
  return (
    <ul className="overflow-hidden bg-card/40">
      {sortedDirectories(root).map((directory) => (
        <WorkspaceDirectoryNode
          key={directory.path}
          directory={directory}
          downloadUrl={downloadUrl}
          onPreview={onPreview}
        />
      ))}
      {sortedFiles(root.files).map((file) => (
        <WorkspaceFileRow
          key={file.path}
          file={file}
          downloadUrl={downloadUrl(file.path)}
          onPreview={onPreview}
        />
      ))}
    </ul>
  )
}

function WorkspaceDirectoryNode({
  directory,
  downloadUrl,
  onPreview,
}: {
  directory: WorkspaceTreeDirectory
  downloadUrl: (path: string) => string
  onPreview: (file: PreviewableWorkspaceFile) => void
}) {
  const fileCount = countDirectoryFiles(directory)
  const [open, setOpen] = useState(() => fileCount < 8)
  return (
    <li>
      <button
        type="button"
        className="grid min-h-12 w-full grid-cols-[14px_20px_minmax(0,1fr)_4.25rem] items-center gap-2 px-3 text-left text-xs text-foreground transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/30 sm:grid-cols-[14px_20px_minmax(0,1fr)_9rem_4.25rem]"
        aria-expanded={open}
        aria-label={`${open ? "折叠" : "展开"} ${directory.path}`}
        onClick={() => setOpen((current) => !current)}
      >
        <Icon
          icon="lucide:chevron-right"
          width="14"
          className={open ? "rotate-90 transition-transform" : "transition-transform"}
        />
        <Icon
          icon={open ? "lucide:folder-open" : "lucide:folder"}
          width="16"
          className="justify-self-center text-primary/80"
        />
        <span className="min-w-0 truncate font-mono text-xs font-medium text-foreground">
          {directory.name}
        </span>
        <span className="hidden sm:block" />
      </button>
      {open ? (
        <ul className="ml-5 border-l border-border/70 pl-2">
          {sortedDirectories(directory).map((child) => (
            <WorkspaceDirectoryNode
              key={child.path}
              directory={child}
              downloadUrl={downloadUrl}
              onPreview={onPreview}
            />
          ))}
          {sortedFiles(directory.files).map((file) => (
            <WorkspaceFileRow
              key={file.path}
              file={file}
              downloadUrl={downloadUrl(file.path)}
              onPreview={onPreview}
            />
          ))}
        </ul>
      ) : null}
    </li>
  )
}

function WorkspaceFileRow({
  file,
  downloadUrl,
  onPreview,
}: {
  file: PreviewableWorkspaceFile
  downloadUrl: string
  onPreview: (file: PreviewableWorkspaceFile) => void
}) {
  const name = file.path.split("/").pop() ?? file.path
  return (
    <li className="grid min-h-12 grid-cols-[14px_20px_minmax(0,1fr)_4.25rem] items-center gap-2 px-3 py-1.5 hover:bg-muted/25 sm:grid-cols-[14px_20px_minmax(0,1fr)_9rem_4.25rem]">
      <span />
      <span className="flex size-5 items-center justify-center text-muted-foreground">
        <Icon icon={fileIcon(name)} width="15" />
      </span>
      {file.preview ? (
        <button
          type="button"
          className="min-w-0 truncate text-left font-mono text-xs font-medium text-foreground transition-colors hover:text-primary focus-visible:outline-none focus-visible:underline"
          onClick={() => onPreview(file)}
        >
          {name}
        </button>
      ) : (
        <p className="min-w-0 truncate font-mono text-xs font-medium text-foreground">{name}</p>
      )}
      <div className="hidden shrink-0 text-right text-[11px] text-muted-foreground sm:block">
        <p className="font-mono tabular-nums">{formatFileSize(file.size)}</p>
        <p>{absoluteTime(file.modifiedAt)}</p>
      </div>
      <div className="flex justify-end gap-0.5">
        {file.preview ? (
          <Button
            size="icon"
            variant="ghost"
            className="size-8"
            aria-label={`预览 ${file.path}`}
            onClick={() => onPreview(file)}
          >
            <Icon icon="lucide:eye" width="15" />
          </Button>
        ) : null}
        <Button size="icon" variant="ghost" className="size-8" asChild>
          <a href={downloadUrl} download={name} aria-label={`下载 ${file.path}`}>
            <Icon icon="lucide:download" width="15" />
          </a>
        </Button>
      </div>
    </li>
  )
}

function buildWorkspaceTree(files: PreviewableWorkspaceFile[]): WorkspaceTreeDirectory {
  const root: WorkspaceTreeDirectory = {
    name: "",
    path: "",
    directories: new Map(),
    files: [],
  }
  for (const file of files) {
    const segments = file.path.split("/").filter(Boolean)
    const fileName = segments.pop()
    if (!fileName) continue
    let directory = root
    for (const segment of segments) {
      const path = directory.path ? `${directory.path}/${segment}` : segment
      let child = directory.directories.get(segment)
      if (!child) {
        child = { name: segment, path, directories: new Map(), files: [] }
        directory.directories.set(segment, child)
      }
      directory = child
    }
    directory.files.push(file)
  }
  return root
}

function sortedDirectories(directory: WorkspaceTreeDirectory): WorkspaceTreeDirectory[] {
  return [...directory.directories.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  )
}

function sortedFiles(files: PreviewableWorkspaceFile[]): PreviewableWorkspaceFile[] {
  return [...files].sort((left, right) => left.path.localeCompare(right.path))
}

function countDirectoryFiles(directory: WorkspaceTreeDirectory): number {
  return (
    directory.files.length +
    [...directory.directories.values()].reduce(
      (total, child) => total + countDirectoryFiles(child),
      0,
    )
  )
}

function formatFileSize(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KiB`
  if (bytes < 1_073_741_824) return `${(bytes / 1_048_576).toFixed(1)} MiB`
  return `${(bytes / 1_073_741_824).toFixed(1)} GiB`
}

function fileIcon(name: string): string {
  const extension = name.split(".").pop()?.toLowerCase()
  if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(extension ?? ""))
    return "lucide:file-image"
  if (["zip", "tar", "gz", "7z", "rar"].includes(extension ?? "")) return "lucide:file-archive"
  if (["js", "ts", "py", "c", "cpp", "rs", "go", "sh"].includes(extension ?? ""))
    return "lucide:file-code-2"
  if (["md", "txt", "log", "json", "yaml", "yml", "xml"].includes(extension ?? ""))
    return "lucide:file-text"
  return "lucide:file"
}
