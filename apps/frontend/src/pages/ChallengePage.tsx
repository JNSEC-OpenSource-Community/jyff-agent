import { Icon } from "@iconify/react"
import { useState } from "react"
import { useParams } from "react-router-dom"
import { MarkdownContent } from "../components/content/MarkdownContent.tsx"
import {
  Badge,
  Button,
  Card,
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
import { ConversationPanel } from "./challenge/ConversationPanel.tsx"
import { IntelligencePanel } from "./challenge/IntelligencePanel.tsx"

export function ChallengePage() {
  const [mobileDetailsOpen, setMobileDetailsOpen] = useState(false)
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
    challengeAction,
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
  const active = [
    "preparing",
    "running",
    "blocking",
    "writing_writeup",
  ].includes(c.status)
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
    : projectApi(
        projectId,
        `/api/challenges/${encodeURIComponent(challengeId)}/message`,
      )
  const exportUrl = selectedSubagent
    ? projectApi(
        projectId,
        `/api/runs/${encodeURIComponent(rid)}/subagents/${encodeURIComponent(selectedSubagent.id)}/export`,
      )
    : projectApi(projectId, `/api/runs/${encodeURIComponent(rid)}/export`)

  return (
    <div className="flex h-full min-w-0 overflow-hidden max-lg:flex-col">
      {/* ── Main content ── */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col p-4 max-lg:p-3">
        <Card className="flex min-h-0 flex-1 flex-col border-border p-0">
          {error ? (
            <ErrorNotice message={error} className="m-3 shrink-0" />
          ) : null}

          <Tabs
            defaultValue="conversation"
            className="flex min-h-0 flex-1 flex-col"
          >
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
              <TabsList>
                <TabsTrigger value="conversation">对话</TabsTrigger>
                <TabsTrigger value="intelligence">情报</TabsTrigger>
                <TabsTrigger value="attempts">Attempts</TabsTrigger>
                <TabsTrigger value="writeup">Writeup</TabsTrigger>
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
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="lg:hidden"
                onClick={() => setMobileDetailsOpen(true)}
              >
                <Icon icon="lucide:panel-bottom-open" width="14" />
                题目与 Agents
              </Button>
            </div>

            <TabsContent
              value="conversation"
              className="flex min-h-0 flex-1 flex-col"
            >
              {selectedRun ? (
                <ConversationPanel
                  target={target}
                  attempt={selectedRun.attempt}
                  hasConversation={
                    selectedSubagent
                      ? selectedSubagent.hasConversation
                      : selectedRun.hasConversation
                  }
                  conversationUrl={convoUrl}
                  sendUrl={sendUrl}
                  exportUrl={exportUrl}
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

            <TabsContent
              value="intelligence"
              className="flex-1 overflow-y-auto p-5"
            >
              <IntelligencePanel
                projectId={projectId}
                challengeId={challengeId}
                tldr={details.tldr}
                blackboard={details.blackboard}
                onChanged={reload}
              />
            </TabsContent>

            <TabsContent
              value="attempts"
              className="flex-1 overflow-y-auto p-5"
            >
              <AttemptHistory
                projectId={projectId}
                runs={details.runs}
                onChanged={reload}
              />
            </TabsContent>

            <TabsContent value="writeup" className="flex-1 overflow-y-auto p-5">
              {details.writeup.content ? (
                <div className="rounded-lg border border-border bg-muted/30 p-5">
                  <MarkdownContent>{details.writeup.content}</MarkdownContent>
                </div>
              ) : (
                <EmptyState
                  icon="lucide:file-pen-line"
                  title="尚无 Writeup"
                  description={
                    details.writeup.validation.errors.join("；") ||
                    "解出后生成。"
                  }
                />
              )}
            </TabsContent>
          </Tabs>
        </Card>
      </div>

      {/* ── Sidebar with header info ── */}
      <aside className="flex w-72 shrink-0 flex-col gap-4 overflow-y-auto border-l border-border p-4 max-lg:hidden">
        {/* Challenge header moved into sidebar */}
        <Card className="overflow-hidden p-0">
          <div className="border-b border-border px-4 py-3">
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">
              {c.category} · {c.score} PTS
            </p>
            <h1 className="hero-title mt-1 text-lg font-bold tracking-tight">
              {c.title}
            </h1>
            <p className="mt-1 text-xs text-muted-foreground">{c.progress}</p>
          </div>
          <div className="flex items-center justify-between px-4 py-2.5">
            <Badge tone={toneForStatus(c.status)} className="text-[10px]">
              {STATUS_LABELS[c.status] ?? c.status}
            </Badge>
            <Button
              variant={active ? "danger" : "primary"}
              disabled={busy}
              onClick={() =>
                void challengeAction(active ? "cancel" : "dispatch")
              }
              size="sm"
            >
              <Icon
                icon={active ? "lucide:square" : "lucide:play"}
                width="14"
              />
              {active ? "终止" : c.status === "blocked" ? "重新派发" : "派发"}
            </Button>
          </div>
        </Card>

        <AgentSidebar
          details={details}
          selectedRunId={rid}
          selectedSubagentId={selectedSubagent?.id ?? null}
          onSelectSubagent={selectSubagent}
        />
      </aside>

      <Sheet open={mobileDetailsOpen} onOpenChange={setMobileDetailsOpen}>
        <SheetContent side="bottom" className="p-0 lg:hidden">
          <SheetTitle className="sr-only">题目与 Agents</SheetTitle>
          <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-border" />
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 pt-3">
            <Card className="overflow-hidden p-0">
              <div className="border-b border-border px-4 py-3 pr-12">
                <p className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">
                  {c.category} · {c.score} PTS
                </p>
                <h1 className="hero-title mt-1 text-lg font-bold tracking-tight">
                  {c.title}
                </h1>
                <p className="mt-1 text-xs text-muted-foreground">
                  {c.progress}
                </p>
              </div>
              <div className="flex items-center justify-between px-4 py-2.5">
                <Badge tone={toneForStatus(c.status)} className="text-[10px]">
                  {STATUS_LABELS[c.status] ?? c.status}
                </Badge>
                <Button
                  variant={active ? "danger" : "primary"}
                  disabled={busy}
                  onClick={() =>
                    void challengeAction(active ? "cancel" : "dispatch")
                  }
                  size="sm"
                >
                  <Icon
                    icon={active ? "lucide:square" : "lucide:play"}
                    width="14"
                  />
                  {active
                    ? "终止"
                    : c.status === "blocked"
                      ? "重新派发"
                      : "派发"}
                </Button>
              </div>
            </Card>
            <AgentSidebar
              details={details}
              selectedRunId={rid}
              selectedSubagentId={selectedSubagent?.id ?? null}
              onSelectSubagent={(id) => {
                selectSubagent(id)
                setMobileDetailsOpen(false)
              }}
            />
          </div>
          <SheetCloseButton aria-label="关闭题目与 Agents" />
        </SheetContent>
      </Sheet>
    </div>
  )
}
