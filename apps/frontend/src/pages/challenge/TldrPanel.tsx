import type { TldrRecord } from "@ctf-agent/core"
import { Icon } from "@iconify/react"
import { useState } from "react"
import {
  Button,
  EmptyState,
  ErrorNotice,
  Spinner,
} from "../../components/index.ts"
import { apiMutation, projectApi } from "../../lib/api.ts"
import { errorMessage } from "../../lib/format.ts"
import { absoluteTime } from "../../lib/time.ts"

/**
 * TLDR 情报面板：展示已生成的 TLDR 摘要，支持手动重新生成。
 * 接线 GET /tldr（数据随 ChallengeDetails 下发）与 POST /tldr/refresh。
 */
export function TldrPanel({
  projectId,
  challengeId,
  tldr,
  onChanged,
}: {
  projectId: string
  challengeId: string
  tldr: TldrRecord | null
  onChanged(): Promise<void>
}): React.ReactElement {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  async function refresh(): Promise<void> {
    setBusy(true)
    setError("")
    try {
      await apiMutation(
        projectApi(
          projectId,
          `/api/challenges/${encodeURIComponent(challengeId)}/tldr/refresh`,
        ),
        "POST",
      )
      await onChanged()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  if (error) return <ErrorNotice message={error} />

  if (!tldr) {
    return (
      <EmptyState
        icon="lucide:file-text"
        title="尚未生成 TLDR"
        description="TLDR 由独立 Agent 在后台生成，浓缩题目目标与已知情报。"
        action={
          <Button size="sm" onClick={() => void refresh()} disabled={busy}>
            <Icon
              icon={busy ? "lucide:loader-circle" : "lucide:sparkles"}
              className={busy ? "animate-spin" : ""}
              width="14"
            />
            生成 TLDR
          </Button>
        }
      />
    )
  }

  if (tldr.error) {
    return (
      <div className="flex flex-col gap-2">
        <ErrorNotice message={`TLDR 生成失败：${tldr.error}`} />
        <div>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void refresh()}
            disabled={busy}
          >
            <Icon
              icon={busy ? "lucide:loader-circle" : "lucide:rotate-ccw"}
              className={busy ? "animate-spin" : ""}
              width="14"
            />
            重试
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span className="inline-flex items-center gap-1">
          <Icon icon="lucide:bot" width="13" />
          {tldr.model}
        </span>
        <span>{absoluteTime(tldr.updatedAt)}</span>
        <span>{tldr.inputTokens} input tokens</span>
        {tldr.cacheReadTokens + tldr.cacheWriteTokens > 0 ? (
          <span>
            缓存 {tldr.cacheReadTokens} 读 / {tldr.cacheWriteTokens} 写
          </span>
        ) : null}
      </div>
      <div className="border-border/60 bg-muted/20 rounded-lg border p-4">
        <p className="text-foreground/90 text-sm leading-relaxed whitespace-pre-wrap">
          {tldr.content}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          onClick={() => void refresh()}
          disabled={busy}
        >
          <Icon
            icon={busy ? "lucide:loader-circle" : "lucide:rotate-ccw"}
            className={busy ? "animate-spin" : ""}
            width="14"
          />
          重新生成
        </Button>
        {busy ? <Spinner label="生成中" /> : null}
      </div>
    </div>
  )
}
