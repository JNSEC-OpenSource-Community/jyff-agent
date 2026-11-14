import { Icon } from "@iconify/react"
import { useRef, useState } from "react"
import { useParams } from "react-router-dom"
import { MarkdownContent } from "../components/content/MarkdownContent.tsx"
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorNotice,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Sheet,
  SheetCloseButton,
  SheetContent,
  SheetTitle,
  Spinner,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "../components/index.ts"
import { useChallengeDetails } from "../hooks/useChallengeDetails.ts"
import { projectApi } from "../lib/api.ts"
import { toneForStatus } from "../lib/challenge.ts"
import { STATUS_LABELS } from "../lib/labels.ts"
import { AgentSidebar } from "./challenge/AgentSidebar.tsx"
import { AttemptHistory } from "./challenge/AttemptHistory.tsx"
import {
  ConversationPanel,
  type ConversationViewStateStore,
} from "./challenge/ConversationPanel.tsx"
import { IntelligencePanel } from "./challenge/IntelligencePanel.tsx"
import { WorkspaceFilesPanel } from "./challenge/WorkspaceFilesPanel.tsx"

export function ChallengePage() {
  const [mobileDetailsOpen, setMobileDetailsOpen] = useState(false)
  const [resetOpen, setResetOpen] = useState(false)
  const [forceDispatchOpen, setForceDispatchOpen] = useState(false)
  const conversationViewStates = useRef<ConversationViewStateStore>(new Map())
  const { projectId = "", challengeId = "" } = useParams()
  const {
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
    reload,
  } = useChallengeDetails(projectId, challengeId)

  if (!details) {
    if (error) {
      return (
        <div className="flex h-full items-center justify-center p-8">
          <ErrorNotice message={error} />
        </div>
      )
    }
    return <Spinner label="加载题目" />
  }

  const c = details.challenge
  const active = ["preparing", "running", "blocking", "writing_writeup"].includes(c.status)
  const forceDispatch = c.status === "solved"
  const dispatchLabel = active
    ? "终止"
    : forceDispatch
      ? "强制派发"
      : c.status === "blocked"
        ? "重新派发"
        : "派发"
  const dispatchIcon = active ? "lucide:square" : forceDispatch ? "lucide:rotate-cw" : "lucide:play"
  const runPrimaryAction = (): void => {
    if (active) {
      void challengeAction("cancel")
    } else if (forceDispatch) {
      setForceDispatchOpen(true)
    } else {
      void challengeAction("dispatch")
    }
  }
  const rid = selectedRun?.id ?? ""
  const convoUrl = selectedSubagent
    ? projectApi(
        projectId,
        `/api/runs/${encodeURIComponent(rid)}/subagents/${encodeURIComponent(selectedSubagent.id)}/conversation`,
      )
    : projectApi(projectId, `/api/runs/${encodeURIComponent(rid)}/conversation`)
  const sendUrl = selectedSubagent
    ? projectApi(
        projectId,
        `/api/runs/${encodeURIComponent(rid)}/subagents/${encodeURIComponent(selectedSubagent.id)}/steer`,
      )
    : projectApi(projectId, `/api/challenges/${encodeURIComponent(challengeId)}/message`)
  const streamUrl = selectedSubagent
    ? projectApi(
        projectId,
        `/api/runs/${encodeURIComponent(rid)}/subagents/${encodeURIComponent(selectedSubagent.id)}/events`,
      )
    : projectApi(projectId, `/api/runs/${encodeURIComponent(rid)}/events`)
  const exportUrl = selectedSubagent
    ? projectApi(
        projectId,
        `/api/runs/${encodeURIComponent(rid)}/subagents/${encodeURIComponent(selectedSubagent.id)}/export`,
      )
    : projectApi(projectId, `/api/runs/${encodeURIComponent(rid)}/export`)

  return (
    <div className="flex h-full min-w-0 overflow-hidden max-lg:flex-col">
      {/* ── Main content ── */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col p-3 max-lg:p-2">
        <Card className="flex min-h-0 flex-1 flex-col border-border p-0">
          {error ? <ErrorNotice message={error} className="m-3 shrink-0" /> : null}

          <Tabs defaultValue="conversation" className="flex min-h-0 flex-1 flex-col">
            <div className="hidden shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2 lg:flex">
              <TabsList>
                <TabsTrigger value="conversation">对话</TabsTrigger>
                <TabsTrigger value="intelligence">情报</TabsTrigger>
                <TabsTrigger value="attempts">尝试记录</TabsTrigger>
                <TabsTrigger value="files">文件</TabsTrigger>
                <TabsTrigger value="writeup">解题报告</TabsTrigger>
              </TabsList>
              {selectedRun ? (
                <Select value={selectedRun.id} onValueChange={selectRun}>
                  <SelectTrigger className="h-7 w-48 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {details.runs.map((r) => (
                      <SelectItem value={r.id} key={r.id}>
                        #{r.attempt} · {STATUS_LABELS[r.status] ?? r.status}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : null}
            </div>

            <div className="shrink-0 border-b border-border lg:hidden">
              <div className="flex h-12 items-center gap-2 pr-15 pl-2">
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  className="h-8 shrink-0 px-2.5"
                  onClick={() => setMobileDetailsOpen(true)}
                  aria-label="打开题目与 Agents"
                >
                  <Icon icon="lucide:panel-bottom-open" width="14" />
                  <span className="max-[460px]:hidden">题目与 Agents</span>
                </Button>
                {selectedRun ? (
                  <Select value={selectedRun.id} onValueChange={selectRun}>
                    <SelectTrigger className="h-8 min-w-0 flex-1 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {details.runs.map((r) => (
                        <SelectItem value={r.id} key={r.id}>
                          #{r.attempt} · {STATUS_LABELS[r.status] ?? r.status}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <span className="flex-1" />
                )}
              </div>
              <TabsList className="grid h-9 w-full grid-cols-5 gap-0 rounded-none border-x-0 border-b-0 bg-transparent p-0 px-2">
                <TabsTrigger value="conversation" className="px-1 text-xs">
                  对话
                </TabsTrigger>
                <TabsTrigger value="intelligence" className="px-1 text-xs">
                  情报
                </TabsTrigger>
                <TabsTrigger value="attempts" className="px-1 text-xs">
                  尝试记录
                </TabsTrigger>
                <TabsTrigger value="files" className="px-1 text-xs">
                  文件
                </TabsTrigger>
                <TabsTrigger value="writeup" className="px-1 text-xs">
                  解题报告
                </TabsTrigger>
              </TabsList>
            </div>

            <TabsContent value="conversation" className="flex min-h-0 flex-1 flex-col">
              {selectedRun ? (
                <ConversationPanel
                  key={`${rid}:${selectedSubagent?.id ?? "solver"}`}
                  target={target}
                  attempt={selectedRun.attempt}
                  runStatus={selectedRun.status}
                  hasConversation={
                    selectedSubagent
                      ? selectedSubagent.hasConversation
                      : selectedRun.hasConversation
                  }
                  conversationUrl={convoUrl}
                  streamUrl={streamUrl}
                  sendUrl={sendUrl}
                  bodyKey={selectedSubagent ? "message" : "text"}
                  exportUrl={exportUrl}
                  viewKey={`${rid}:${selectedSubagent?.id ?? "solver"}`}
                  viewStateStore={conversationViewStates.current}
                  onSelectSubagent={selectSubagent}
                  onChanged={reload}
                />
              ) : (
                <div className="flex flex-1 items-center justify-center">
                  <EmptyState
                    icon="lucide:bot"
                    title="尚无 Attempt"
                    description="派发 Solver 后对话实时出现。"
                  />
                </div>
              )}
            </TabsContent>

            <TabsContent value="intelligence" className="flex-1 overflow-y-auto p-4">
              <IntelligencePanel
                projectId={projectId}
                challengeId={challengeId}
                tldr={details.tldr}
                blackboard={details.blackboard}
                onChanged={reload}
              />
            </TabsContent>

            <TabsContent value="attempts" className="flex-1 overflow-y-auto p-4">
              <AttemptHistory projectId={projectId} runs={details.runs} onChanged={reload} />
            </TabsContent>

            <TabsContent value="files" className="flex-1 overflow-y-auto p-4">
              <WorkspaceFilesPanel projectId={projectId} challengeId={challengeId} />
            </TabsContent>

            <TabsContent value="writeup" className="flex-1 overflow-y-auto p-4">
              {details.writeup.content ? (
                <div className="rounded-md border border-border bg-muted/30 p-4">
                  <MarkdownContent>{details.writeup.content}</MarkdownContent>
                </div>
              ) : (
                <EmptyState
                  icon="lucide:file-pen-line"
                  title="尚无解题报告"
                  description={details.writeup.validation.errors.join("；") || "解出后生成。"}
                />
              )}
            </TabsContent>
          </Tabs>
        </Card>
      </div>

      {/* ── Sidebar with header info ── */}
      <aside className="flex w-72 shrink-0 flex-col gap-3 overflow-y-auto border-l border-border p-3 max-lg:hidden">
        {/* Challenge header moved into sidebar */}
        <Card className="overflow-hidden p-0">
          <div className="border-b border-border px-3 py-2.5">
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">
              {c.category}
            </p>
            <h1 className="hero-title mt-1 text-lg font-bold tracking-tight">{c.title}</h1>
            <p className="mt-1! text-xs text-muted-foreground">{c.score} PTS</p>
          </div>
          <div className="flex items-center justify-between px-3 py-2.5">
            <Badge tone={toneForStatus(c.status)}>{STATUS_LABELS[c.status] ?? c.status}</Badge>
            <div className="flex items-center gap-1.5">
              <Button
                variant="ghost"
                disabled={busy}
                title="清空该题的运行历史、对话与题目环境"
                onClick={() => setResetOpen(true)}
                size="sm"
              >
                <Icon icon="lucide:rotate-ccw" width="14" />
                重置
              </Button>
              <Button
                variant={active ? "danger" : "primary"}
                disabled={busy || (!active && !details.solverAvailable)}
                title={
                  !active && !details.solverAvailable
                    ? "平台故障或 Project 已归档，当前只能查看本地记录"
                    : forceDispatch
                      ? "创建新的 Attempt，重新验证已经解出的题目"
                      : undefined
                }
                onClick={runPrimaryAction}
                size="sm"
              >
                <Icon icon={dispatchIcon} width="14" />
                {dispatchLabel}
              </Button>
            </div>
          </div>
        </Card>

        <AgentSidebar
          details={details}
          selectedRunId={rid}
          selectedSubagentId={selectedSubagent?.id ?? null}
          onSelectSubagent={selectSubagent}
          onLoadMoreSubagents={() => void loadMoreSubagents()}
        />
      </aside>

      <Sheet open={mobileDetailsOpen} onOpenChange={setMobileDetailsOpen}>
        <SheetContent side="bottom" className="solver-details-sheet p-0 lg:hidden">
          <SheetTitle className="sr-only">题目与 Agents</SheetTitle>
          <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-border" />
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 pt-2">
            <Card className="overflow-hidden p-0">
              <div className="border-b border-border px-3 py-2.5 pr-12">
                <p className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">
                  {c.category} · {c.score} PTS
                </p>
                <h1 className="hero-title mt-1 text-lg font-bold tracking-tight">{c.title}</h1>
                <p className="mt-1! text-xs text-muted-foreground">{c.progress}</p>
              </div>
              <div className="flex items-center justify-between px-3 py-2.5">
                <Badge tone={toneForStatus(c.status)}>{STATUS_LABELS[c.status] ?? c.status}</Badge>
                <div className="flex items-center gap-1.5">
                  <Button
                    variant="ghost"
                    disabled={busy}
                    title="清空该题的运行历史、对话与题目环境"
                    onClick={() => setResetOpen(true)}
                    size="sm"
                  >
                    <Icon icon="lucide:rotate-ccw" width="14" />
                    重置
                  </Button>
                  <Button
                    variant={active ? "danger" : "primary"}
                    disabled={busy || (!active && !details.solverAvailable)}
                    title={
                      !active && !details.solverAvailable
                        ? "平台故障或 Project 已归档，当前只能查看本地记录"
                        : forceDispatch
                          ? "创建新的 Attempt，重新验证已经解出的题目"
                          : undefined
                    }
                    onClick={runPrimaryAction}
                    size="sm"
                  >
                    <Icon icon={dispatchIcon} width="14" />
                    {dispatchLabel}
                  </Button>
                </div>
              </div>
            </Card>
            <AgentSidebar
              details={details}
              selectedRunId={rid}
              selectedSubagentId={selectedSubagent?.id ?? null}
              onLoadMoreSubagents={() => void loadMoreSubagents()}
              onSelectSubagent={(id) => {
                selectSubagent(id)
                setMobileDetailsOpen(false)
              }}
            />
          </div>
          <SheetCloseButton aria-label="关闭题目与 Agents" />
        </SheetContent>
      </Sheet>

      <ConfirmDialog
        open={forceDispatchOpen}
        onOpenChange={setForceDispatchOpen}
        title="强制派发已解出的题目？"
        description="这会保留现有解题记录并创建新的 Attempt，用于重新验证题目。"
        confirmLabel="确认强制派发"
        busy={busy}
        busyLabel="正在派发…"
        onConfirm={() => {
          void challengeAction("dispatch", { force: true }).then(() => setForceDispatchOpen(false))
        }}
      />

      <ConfirmDialog
        open={resetOpen}
        onOpenChange={setResetOpen}
        title="重置该题？"
        description="此操作不可撤销。该题所有运行中的 Agent 会先停止，运行历史、对话、SubAgent、黑板、TLDR、Writeup、调度覆盖与题目 workspace 都会被永久清空，题目将回到「未尝试」状态；已审核的公告关联与用量统计不受影响。"
        confirmLabel="确认重置"
        busy={busy}
        busyLabel="正在重置…"
        onConfirm={() => {
          void resetChallenge().then(() => setResetOpen(false))
        }}
      />
    </div>
  )
}
