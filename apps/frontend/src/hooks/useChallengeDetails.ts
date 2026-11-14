import { useCallback, useEffect, useMemo, useRef, useState } from "react"
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
  loadMoreSubagents: () => Promise<void>
  challengeAction: (action: "dispatch" | "cancel", options?: { force?: boolean }) => Promise<void>
  resetChallenge: () => Promise<void>
  reload: () => Promise<void>
} {
  const [details, setDetails] = useState<ChallengeDetails | null>(null)
  const [selectedRunId, setSelectedRunId] = useState("")
  const [selectedSubagentId, setSelectedSubagentId] = useState<string | null>(null)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const scope = `${projectId}\u0000${challengeId}`
  const currentScope = useRef(scope)
  const loadedScope = useRef("")
  currentScope.current = scope

  const load = useCallback(async (): Promise<void> => {
    const next = await apiRequest<ChallengeDetails>(
      projectApi(projectId, `/api/challenges/${encodeURIComponent(challengeId)}`),
    )
    if (currentScope.current !== scope) return
    const sameScope = loadedScope.current === scope
    loadedScope.current = scope
    setDetails((current) => {
      if (!sameScope || !current || current.challenge.id !== next.challenge.id) return next
      return {
        ...next,
        runs: next.runs.map((run) => {
          const previous = current.runs.find((candidate) => candidate.id === run.id)
          if (!previous) return run
          const currentIds = new Set(run.subagents.map((agent) => agent.id))
          const extra = previous.subagents.filter((agent) => !currentIds.has(agent.id))
          if (extra.length === 0) return run
          const subagents = [...run.subagents, ...extra]
          const total = Math.max(
            run.subagents.length + (run.subagentOmittedCount ?? 0),
            previous.subagents.length + (previous.subagentOmittedCount ?? 0),
          )
          const omitted = Math.max(0, total - subagents.length)
          return {
            ...run,
            subagents,
            subagentOmittedCount: omitted,
            subagentNextCursor:
              omitted > 0 ? (previous.subagentNextCursor ?? run.subagentNextCursor) : null,
          }
        }),
      }
    })
    setSelectedRunId((current) =>
      next.runs.some((run) => run.id === current) ? current : (next.runs[0]?.id ?? ""),
    )
  }, [challengeId, projectId, scope])

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
  const loadMoreSubagents = useCallback(async (): Promise<void> => {
    if (!selectedRun || !(selectedRun.subagentOmittedCount && selectedRun.subagentOmittedCount > 0))
      return
    const runId = selectedRun.id
    const cursor = selectedRun.subagentNextCursor
    try {
      const page = await apiRequest<{
        agents: DashboardSubagent[]
        omittedCount: number
        nextCursor: string | null
      }>(
        projectApi(
          projectId,
          `/api/runs/${encodeURIComponent(runId)}/subagents${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
        ),
      )
      if (currentScope.current !== scope) return
      setDetails((current) =>
        current
          ? {
              ...current,
              runs: current.runs.map((run) => {
                if (run.id !== runId) return run
                const ids = new Set(run.subagents.map((agent) => agent.id))
                return {
                  ...run,
                  subagents: [
                    ...run.subagents,
                    ...page.agents.filter((agent) => !ids.has(agent.id)),
                  ],
                  subagentOmittedCount: page.omittedCount,
                  subagentNextCursor: page.nextCursor,
                }
              }),
            }
          : current,
      )
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }, [projectId, scope, selectedRun])
  const target: ConversationTarget = selectedSubagent
    ? { type: "subagent", subagent: selectedSubagent }
    : { type: "solver" }

  const challengeAction = useCallback(
    async (action: "dispatch" | "cancel", options: { force?: boolean } = {}): Promise<void> => {
      setBusy(true)
      setError("")
      try {
        const force =
          action === "dispatch" &&
          (options.force === true || details?.challenge.status === "blocked")
        await apiMutation(
          projectApi(projectId, `/api/challenges/${encodeURIComponent(challengeId)}/${action}`),
          "POST",
          force ? { force: true } : {},
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

  const resetChallenge = useCallback(async (): Promise<void> => {
    setBusy(true)
    setError("")
    try {
      await apiMutation(
        projectApi(projectId, `/api/challenges/${encodeURIComponent(challengeId)}/reset`),
        "POST",
        {},
      )
      await load()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }, [challengeId, load, projectId])

  return {
    details,
    error,
    busy,
    selectedRun,
    selectedSubagent,
    target,
    selectRun,
    selectSubagent,
    loadMoreSubagents,
    challengeAction,
    resetChallenge,
    reload: load,
  }
}
