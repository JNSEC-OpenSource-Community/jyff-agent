import { useCallback, useEffect, useMemo, useState } from "react"
import { apiMutation, apiRequest, projectApi } from "../lib/api.ts"
import { errorMessage } from "../lib/format.ts"
import type { ChallengeDetails, DashboardRun, DashboardSubagent } from "../types.ts"
import { useSse } from "./useSse.ts"

export type ConversationTarget =
  | { type: "solver" }
  | {
      type: "subagent"
      subagent: DashboardSubagent
    }

/**
 * 题目工作区的状态逻辑：详情加载、SSE 自动刷新、
 * 派发/终止、选中的 Attempt 与 SubAgent。
 */
export function useChallengeDetails(
  projectId: string,
  challengeId: string,
): {
  details: ChallengeDetails | null
  error: string
  busy: boolean
  selectedRun: DashboardRun | undefined
  selectedSubagent: DashboardSubagent | undefined
  target: ConversationTarget
  selectRun: (runId: string) => void
  selectSubagent: (subagentId: string | null) => void
  challengeAction: (action: "dispatch" | "cancel") => Promise<void>
  reload: () => Promise<void>
} {
  const [details, setDetails] = useState<ChallengeDetails | null>(null)
  const [selectedRunId, setSelectedRunId] = useState("")
  const [selectedSubagentId, setSelectedSubagentId] = useState<string | null>(null)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    const next = await apiRequest<ChallengeDetails>(
      projectApi(projectId, `/api/challenges/${encodeURIComponent(challengeId)}`),
    )
    setDetails(next)
    setSelectedRunId((current) =>
      next.runs.some((run) => run.id === current) ? current : (next.runs[0]?.id ?? ""),
    )
  }, [challengeId, projectId])

  useEffect(() => {
    setDetails(null)
    setError("")
    void load().catch((cause) => setError(errorMessage(cause)))
  }, [load])

  useSse(projectApi(projectId, "/api/events"), {
    snapshot: () => {
      void load().catch((cause) => setError(errorMessage(cause)))
    },
  })

  const selectRun = useCallback((runId: string): void => {
    setSelectedRunId(runId)
    setSelectedSubagentId(null)
  }, [])

  const selectSubagent = useCallback(
    (subagentId: string | null): void => setSelectedSubagentId(subagentId),
    [],
  )

  const selectedRun = useMemo(
    () => details?.runs.find((run) => run.id === selectedRunId) ?? details?.runs[0],
    [details, selectedRunId],
  )
  const selectedSubagent = useMemo(
    () => selectedRun?.subagents.find((subagent) => subagent.id === selectedSubagentId),
    [selectedRun, selectedSubagentId],
  )
  const target: ConversationTarget = selectedSubagent
    ? { type: "subagent", subagent: selectedSubagent }
    : { type: "solver" }

  const challengeAction = useCallback(
    async (action: "dispatch" | "cancel"): Promise<void> => {
      setBusy(true)
      setError("")
      try {
        await apiMutation(
          projectApi(projectId, `/api/challenges/${encodeURIComponent(challengeId)}/${action}`),
          "POST",
          action === "dispatch" && details?.challenge.status === "blocked" ? { force: true } : {},
        )
        await load()
      } catch (cause) {
        setError(errorMessage(cause))
      } finally {
        setBusy(false)
      }
    },
    [challengeId, details?.challenge.status, load, projectId],
  )

  return {
    details,
    error,
    busy,
    selectedRun,
    selectedSubagent,
    target,
    selectRun,
    selectSubagent,
    challengeAction,
    reload: load,
  }
}
