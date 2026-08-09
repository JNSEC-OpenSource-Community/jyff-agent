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
    <div className="mx-auto w-full max-w-5xl">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Workspace 文件</h2>
          <p className="mt-1! text-xs text-muted-foreground">
            Solver 与 SubAgent 保留的附件、脚本和分析产物。
          </p>
        </div>
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
        <ul className="overflow-hidden rounded-xl border border-border bg-card/40">
          {listing.files.map((file) => (
            <WorkspaceFileRow
              key={file.path}
              file={file}
              downloadUrl={projectApi(
                projectId,
                `/api/challenges/${encodeURIComponent(challengeId)}/files/download?path=${encodeURIComponent(file.path)}`,
              )}
            />
          ))}
        </ul>
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

function WorkspaceFileRow({
  file,
  downloadUrl,
}: {
  file: WorkspaceArtifactEntry
  downloadUrl: string
}) {
  const segments = file.path.split("/")
  const name = segments.pop() ?? file.path
  const directory = segments.join("/")
  return (
    <li className="flex min-h-16 items-center gap-3 border-b border-border px-4 py-3 last:border-b-0 hover:bg-muted/25">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <Icon icon={fileIcon(name)} width="17" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate font-mono text-xs font-medium text-foreground">
          {name}
        </p>
        <p className="mt-0.5! truncate font-mono text-[11px] text-muted-foreground">
          {directory || "/"}
        </p>
      </div>
      <div className="hidden shrink-0 text-right text-[11px] text-muted-foreground sm:block">
        <p className="font-mono tabular-nums">{formatFileSize(file.size)}</p>
        <p>{absoluteTime(file.modifiedAt)}</p>
      </div>
      <Button size="icon" variant="ghost" asChild>
        <a href={downloadUrl} download={name} aria-label={`下载 ${file.path}`}>
          <Icon icon="lucide:download" width="15" />
        </a>
      </Button>
    </li>
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
