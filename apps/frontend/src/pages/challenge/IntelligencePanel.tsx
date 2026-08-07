import type { BlackboardSummary, TldrRecord } from "@ctf-agent/core"
import { Icon } from "@iconify/react"
import { Badge } from "../../components/index.ts"
import { TldrPanel } from "./TldrPanel.tsx"

/** 黑板情报：TLDR 摘要 + 已确认证据 + 待验证机会。 */
export function IntelligencePanel({
  projectId,
  challengeId,
  tldr,
  blackboard,
  onChanged,
}: {
  projectId: string
  challengeId: string
  tldr: TldrRecord | null
  blackboard: BlackboardSummary
  onChanged(): Promise<void>
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-2">
        <div className="section-heading">
          <Icon icon="lucide:file-text" width="17" />
          <h3>TLDR 摘要</h3>
        </div>
        <TldrPanel
          projectId={projectId}
          challengeId={challengeId}
          tldr={tldr}
          onChanged={onChanged}
        />
      </section>
      <div className="intelligence-grid">
        <section>
          <div className="section-heading">
            <Icon icon="lucide:check-check" width="17" />
            <h3>已确认事实</h3>
            <Badge>{blackboard.evidence.length}</Badge>
          </div>
          {blackboard.evidence.length ? (
            blackboard.evidence.map((item) => (
              <article key={item.id}>
                <span>E-{item.id}</span>
                <p>{item.description}</p>
              </article>
            ))
          ) : (
            <p className="text-muted-foreground text-sm">黑板暂无证据。</p>
          )}
        </section>
        <section>
          <div className="section-heading">
            <Icon icon="lucide:lightbulb" width="17" />
            <h3>待验证机会</h3>
            <Badge>{blackboard.opportunities.length}</Badge>
          </div>
          {blackboard.opportunities.length ? (
            blackboard.opportunities.map((item) => (
              <article key={item.id}>
                <span>O-{item.id}</span>
                <p>{item.description}</p>
                <Badge tone={item.status === "open" ? "warning" : "neutral"}>
                  {item.status}
                </Badge>
              </article>
            ))
          ) : (
            <p className="text-muted-foreground text-sm">黑板暂无机会项。</p>
          )}
        </section>
      </div>
    </div>
  )
}
