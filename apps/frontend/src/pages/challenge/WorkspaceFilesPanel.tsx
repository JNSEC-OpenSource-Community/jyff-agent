import type {
  WorkspaceArtifactEntry,
  WorkspaceArtifactListing,
} from "@ctf-agent/core"
import { Icon } from "@iconify/react"
import { useCallback, useEffect, useState } from "react"
import {
  Button,
  EmptyState,
  ErrorNotice,
  Spinner,
} from "../../components/index.ts"
import { apiRequest, projectApi } from "../../lib/api.ts"
import { errorMessage } from "../../lib/format.ts"
import { absoluteTime } from "../../lib/time.ts"

export function WorkspaceFilesPanel({
  projectId,
  challengeId,
}: {
  projectId: string
  challengeId: string
}) {
  const [listing, setListing] = useState<WorkspaceArtifactListing | null>(null)
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    setError("")
    try {
      setListing(
        await apiRequest<WorkspaceArtifactListing>(
          projectApi(
            projectId,
            `/api/challenges/${encodeURIComponent(challengeId)}/files`,
          ),
        ),
      )
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setLoading(false)
    }
  }, [challengeId, projectId])

  useEffect(() => {
    void load()
  }, [load])

  if (loading && !listing) return <Spinner label="加载 workspace 文件" />

  return (
    <div className="w-full">
      <div className="mb-3 flex items-center justify-between gap-3">
        {listing ? (
          <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
            <Icon icon="lucide:files" width="14" />
            <span className="font-mono tabular-nums">
              {listing.files.length} 个文件
            </span>
          </span>
        ) : null}
        <Button
          size="sm"
          variant="secondary"
          disabled={loading}
          onClick={() => void load()}
        >
          <Icon
            icon={loading ? "lucide:loader-circle" : "lucide:refresh-cw"}
            width="13"
            className={loading ? "animate-spin" : undefined}
          />
          刷新
        </Button>
      </div>

      {error ? <ErrorNotice message={error} className="mb-4" /> : null}
      {listing?.truncated ? (
        <div className="mb-3 rounded-lg border border-amber/30 bg-amber/10 px-3 py-2 text-xs text-amber">
          文件超过 2,000 项，仅显示前 2,000 项。
        </div>
      ) : null}
      {listing && listing.files.length > 0 ? (
        <WorkspaceFileTree
          files={listing.files}
          projectId={projectId}
          challengeId={challengeId}
        />
      ) : !loading ? (
        <EmptyState
          icon="lucide:folder-open"
          title="Workspace 还是空的"
          description="派发 Solver 后，附件与生成的分析文件会显示在这里。"
        />
      ) : null}
    </div>
  )
}

interface WorkspaceTreeDirectory {
  name: string
  path: string
  directories: Map<string, WorkspaceTreeDirectory>
  files: WorkspaceArtifactEntry[]
}

function WorkspaceFileTree({
  files,
  projectId,
  challengeId,
}: {
  files: WorkspaceArtifactEntry[]
  projectId: string
  challengeId: string
}) {
  const root = buildWorkspaceTree(files)
  return (
    <ul className="overflow-hidden rounded-xl border border-border bg-card/40 py-1">
      {sortedDirectories(root).map((directory) => (
        <WorkspaceDirectoryNode
          key={directory.path}
          directory={directory}
          projectId={projectId}
          challengeId={challengeId}
        />
      ))}
      {sortedFiles(root.files).map((file) => (
        <WorkspaceFileRow
          key={file.path}
          file={file}
          downloadUrl={workspaceDownloadUrl(projectId, challengeId, file.path)}
        />
      ))}
    </ul>
  )
}

function WorkspaceDirectoryNode({
  directory,
  projectId,
  challengeId,
}: {
  directory: WorkspaceTreeDirectory
  projectId: string
  challengeId: string
}) {
  const fileCount = countDirectoryFiles(directory)
  const [open, setOpen] = useState(() => fileCount < 8)
  return (
    <li>
      <button
        type="button"
        className="grid min-h-12 w-full grid-cols-[14px_20px_minmax(0,1fr)_2rem] items-center gap-2 px-3 text-left text-xs text-foreground transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/30 sm:grid-cols-[14px_20px_minmax(0,1fr)_9rem_2rem]"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <Icon
          icon="lucide:chevron-right"
          width="14"
          className={
            open ? "rotate-90 transition-transform" : "transition-transform"
          }
        />
        <Icon
          icon={open ? "lucide:folder-open" : "lucide:folder"}
          width="16"
          className="justify-self-center text-primary/80"
        />
        <span className="min-w-0 truncate font-mono font-medium">
          {directory.name}
        </span>
        <span className="text-right font-mono text-[11px] tabular-nums text-muted-foreground/70">
          {fileCount}
        </span>
        <span className="hidden sm:block" />
      </button>
      {open ? (
        <ul className="ml-5 border-l border-border/70 pl-2">
          {sortedDirectories(directory).map((child) => (
            <WorkspaceDirectoryNode
              key={child.path}
              directory={child}
              projectId={projectId}
              challengeId={challengeId}
            />
          ))}
          {sortedFiles(directory.files).map((file) => (
            <WorkspaceFileRow
              key={file.path}
              file={file}
              downloadUrl={workspaceDownloadUrl(
                projectId,
                challengeId,
                file.path,
              )}
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
}: {
  file: WorkspaceArtifactEntry
  downloadUrl: string
}) {
  const name = file.path.split("/").pop() ?? file.path
  return (
    <li className="grid min-h-12 grid-cols-[14px_20px_minmax(0,1fr)_2rem] items-center gap-2 px-3 py-1.5 hover:bg-muted/25 sm:grid-cols-[14px_20px_minmax(0,1fr)_9rem_2rem]">
      <span />
      <span className="flex size-5 items-center justify-center text-muted-foreground">
        <Icon icon={fileIcon(name)} width="15" />
      </span>
      <p className="min-w-0 truncate font-mono text-xs font-medium text-foreground">
        {name}
      </p>
      <div className="hidden shrink-0 text-right text-[11px] text-muted-foreground sm:block">
        <p className="font-mono tabular-nums">{formatFileSize(file.size)}</p>
        <p>{absoluteTime(file.modifiedAt)}</p>
      </div>
      <Button size="icon" variant="ghost" className="size-8" asChild>
        <a href={downloadUrl} download={name} aria-label={`下载 ${file.path}`}>
          <Icon icon="lucide:download" width="15" />
        </a>
      </Button>
    </li>
  )
}

function buildWorkspaceTree(
  files: WorkspaceArtifactEntry[],
): WorkspaceTreeDirectory {
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

function sortedDirectories(
  directory: WorkspaceTreeDirectory,
): WorkspaceTreeDirectory[] {
  return [...directory.directories.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  )
}

function sortedFiles(
  files: WorkspaceArtifactEntry[],
): WorkspaceArtifactEntry[] {
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

function workspaceDownloadUrl(
  projectId: string,
  challengeId: string,
  filePath: string,
): string {
  return projectApi(
    projectId,
    `/api/challenges/${encodeURIComponent(challengeId)}/files/download?path=${encodeURIComponent(filePath)}`,
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
  if (["zip", "tar", "gz", "7z", "rar"].includes(extension ?? ""))
    return "lucide:file-archive"
  if (
    ["js", "ts", "py", "c", "cpp", "rs", "go", "sh"].includes(extension ?? "")
  )
    return "lucide:file-code-2"
  if (
    ["md", "txt", "log", "json", "yaml", "yml", "xml"].includes(extension ?? "")
  )
    return "lucide:file-text"
  return "lucide:file"
}
