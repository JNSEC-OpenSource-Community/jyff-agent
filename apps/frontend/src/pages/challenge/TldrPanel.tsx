import type { TldrRecord } from "@ctf-agent/core"
import { Icon } from "@iconify/react"
import { useState } from "react"
import { MarkdownContent } from "../../components/content/MarkdownContent.tsx"
import { Button, ErrorNotice } from "../../components/index.ts"
import { apiMutation, projectApi } from "../../lib/api.ts"
import { errorMessage } from "../../lib/format.ts"
import { absoluteTime } from "../../lib/time.ts"
import { cn } from "../../lib/utils.ts"

export function TldrPanel({
  projectId,
  challengeId,
  tldr,
  onChanged,
}: {
  projectId: string
  challengeId: string
  tldr: TldrRecord | null
  onChanged: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  async function refresh() {
    setBusy(true)
    setError("")
    try {
      await apiMutation(
        projectApi(projectId, `/api/challenges/${encodeURIComponent(challengeId)}/tldr/refresh`),
        "POST",
      )
      await onChanged()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section
      className={cn(
        "overflow-hidden rounded-md border border-border bg-card transition-opacity",
        busy && "opacity-70",
      )}
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
        <span className="flex size-6 items-center justify-center rounded-sm bg-primary/10 text-primary">
          <Icon icon="lucide:file-text" width="14" />
        </span>
        <h3 className="flex-1 text-sm font-medium">TLDR 摘要</h3>
        <Button size="sm" variant="ghost" onClick={() => void refresh()} disabled={busy}>
          <Icon
            icon={busy ? "lucide:loader-circle" : tldr ? "lucide:rotate-ccw" : "lucide:sparkles"}
            className={busy ? "animate-spin" : ""}
            width="14"
          />
          {tldr ? "重新生成" : "生成"}
        </Button>
      </div>

      {error ? (
        <div className="px-3 pt-3">
          <ErrorNotice message={error} />
        </div>
      ) : null}

      {!tldr ? (
        <p className="px-3 py-5 text-center text-xs text-muted-foreground">尚未生成摘要</p>
      ) : tldr.error ? (
        <div className="p-3">
          <ErrorNotice message={`TLDR 生成失败：${tldr.error}`} />
        </div>
      ) : (
        <>
          <div className="p-3">
            <MarkdownContent>{tldr.content}</MarkdownContent>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <Icon icon="lucide:bot" width="12" />
              {tldr.model}
            </span>
            <span>{absoluteTime(tldr.updatedAt)}</span>
            <span className="font-mono tabular-nums">{tldr.inputTokens} input tokens</span>
            {tldr.cacheReadTokens + tldr.cacheWriteTokens > 0 ? (
              <span className="font-mono tabular-nums">
                缓存 {tldr.cacheReadTokens} 读 / {tldr.cacheWriteTokens} 写
              </span>
            ) : null}
          </div>
        </>
      )}
    </section>
  )
}
