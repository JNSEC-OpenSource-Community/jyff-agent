import { Icon } from "@iconify/react"
import { useParams } from "react-router-dom"
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  PageHeader,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
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

/** 单题工作区：对话 / 情报 / Attempts / Writeup 四个页签 + Agent 侧栏。 */
export function ChallengePage(): React.ReactElement {
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
    return error ? (
      <div className="page">
        <ErrorNotice message={error} />
      </div>
    ) : (
      <Spinner label="正在读取题目工作区" />
    )
  }

  const challenge = details.challenge
  const active = [
    "preparing",
    "running",
    "blocking",
    "writing_writeup",
  ].includes(challenge.status)
  const runId = selectedRun?.id ?? ""
  const conversationUrl = selectedSubagent
    ? projectApi(
        projectId,
        `/api/runs/${encodeURIComponent(runId)}/subagents/${encodeURIComponent(selectedSubagent.id)}/conversation`,
      )
    : projectApi(
        projectId,
        `/api/runs/${encodeURIComponent(runId)}/conversation`,
      )
  const sendUrl = selectedSubagent
    ? projectApi(
        projectId,
        `/api/runs/${encodeURIComponent(runId)}/subagents/${encodeURIComponent(selectedSubagent.id)}/steer`,
      )
    : projectApi(
        projectId,
        `/api/challenges/${encodeURIComponent(challengeId)}/message`,
      )
  const exportUrl = selectedSubagent
    ? projectApi(
        projectId,
        `/api/runs/${encodeURIComponent(runId)}/subagents/${encodeURIComponent(selectedSubagent.id)}/export`,
      )
    : projectApi(projectId, `/api/runs/${encodeURIComponent(runId)}/export`)

  return (
    <div className="page challenge-page">
      <PageHeader
        eyebrow={`${challenge.category} · ${challenge.score} PTS`}
        title={challenge.title}
        description={challenge.progress}
        actions={
          <>
            <Badge tone={toneForStatus(challenge.status)}>
              {STATUS_LABELS[challenge.status] ?? challenge.status}
            </Badge>
            <Button
              variant={active ? "danger" : "primary"}
              disabled={busy}
              onClick={() =>
                void challengeAction(active ? "cancel" : "dispatch")
              }
            >
              <Icon
                icon={active ? "lucide:square" : "lucide:play"}
                width="16"
              />
              {active
                ? "终止当前运行"
                : challenge.status === "blocked"
                  ? "强制重新派发"
                  : "派发 Solver"}
            </Button>
          </>
        }
      />
      {error ? <ErrorNotice message={error} /> : null}
      <div className="flex min-h-0 flex-1 flex-col gap-4 lg:flex-row">
        <Card className="min-h-0 flex-1 p-0 lg:flex lg:flex-col">
          <Tabs
            defaultValue="conversation"
            className="flex min-h-0 flex-1 flex-col"
          >
            <div className="border-border/60 flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2">
              <TabsList>
                <TabsTrigger value="conversation">对话</TabsTrigger>
                <TabsTrigger value="intelligence">情报</TabsTrigger>
                <TabsTrigger value="attempts">Attempts</TabsTrigger>
                <TabsTrigger value="writeup">Writeup</TabsTrigger>
              </TabsList>
              {selectedRun ? (
                <Select value={selectedRun.id} onValueChange={selectRun}>
                  <SelectTrigger className="w-56 h-8">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {details.runs.map((run) => (
                      <SelectItem value={run.id} key={run.id}>
                        Attempt {run.attempt} ·{" "}
                        {STATUS_LABELS[run.status] ?? run.status}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : null}
            </div>
            <TabsContent value="conversation" className="min-h-0 flex-1">
              {selectedRun ? (
                <ConversationPanel
                  target={target}
                  attempt={selectedRun.attempt}
                  hasConversation={
                    selectedSubagent
                      ? selectedSubagent.hasConversation
                      : selectedRun.hasConversation
                  }
                  conversationUrl={conversationUrl}
                  sendUrl={sendUrl}
                  exportUrl={exportUrl}
                  onChanged={reload}
                />
              ) : (
                <EmptyState
                  icon="lucide:bot"
                  title="尚无 Attempt"
                  description="派发 Solver 后，对话会在这里实时出现。"
                />
              )}
            </TabsContent>
            <TabsContent
              value="intelligence"
              className="flex-1 overflow-y-auto p-4"
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
              className="flex-1 overflow-y-auto p-4"
            >
              <AttemptHistory
                projectId={projectId}
                runs={details.runs}
                onChanged={reload}
              />
            </TabsContent>
            <TabsContent value="writeup" className="flex-1 overflow-y-auto p-4">
              {details.writeup.content ? (
                <pre className="border-border/60 bg-muted/20 rounded-lg border p-4 text-sm whitespace-pre-wrap">
                  {details.writeup.content}
                </pre>
              ) : (
                <EmptyState
                  icon="lucide:file-pen-line"
                  title="Writeup 尚未生成"
                  description={
                    details.writeup.validation.errors.join("；") ||
                    "Solver 解出题目后会生成结构化 Writeup。"
                  }
                />
              )}
            </TabsContent>
          </Tabs>
        </Card>
        <AgentSidebar
          details={details}
          selectedRunId={selectedRun?.id ?? ""}
          selectedSubagentId={selectedSubagent?.id ?? null}
          onSelectSubagent={selectSubagent}
        />
      </div>
    </div>
  )
}
