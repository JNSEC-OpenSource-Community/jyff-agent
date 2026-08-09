import type { BlackboardSummary, TldrRecord } from "@ctf-agent/core"
import { Icon } from "@iconify/react"
import { Badge } from "../../components/index.ts"
import { cn } from "../../lib/utils.ts"
import { TldrPanel } from "./TldrPanel.tsx"

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
}) {
  return (
    <div className="space-y-6">
      <TldrPanel
        projectId={projectId}
        challengeId={challengeId}
        tldr={tldr}
        onChanged={onChanged}
      />

      <div className="grid gap-4 sm:grid-cols-2">
        {(
          [
            {
              kind: "evidence" as const,
              title: "已确认事实",
              icon: "lucide:check-check",
              tone: "bg-green/10 text-green",
            },
            {
              kind: "opportunities" as const,
              title: "待验证机会",
              icon: "lucide:lightbulb",
              tone: "bg-warning/10 text-warning",
            },
          ] as const
        ).map(({ kind, title, icon, tone }) => {
          const items =
            kind === "evidence" ? blackboard.evidence : blackboard.opportunities
          return (
            <section
              key={kind}
              className="overflow-hidden rounded-xl border border-border bg-card"
            >
              <div className="flex items-center gap-2.5 border-b border-border px-4 py-3">
                <span
                  className={cn(
                    "flex size-6 items-center justify-center rounded-md text-[10px]",
                    tone,
                  )}
                >
                  <Icon icon={icon} width="14" />
                </span>
                <h3 className="flex-1 text-sm font-medium">{title}</h3>
                <Badge className="text-[10px]">{items.length}</Badge>
              </div>
              {items.length ? (
                <div className="max-h-80 overflow-y-auto">
                  {items.map((item) => (
                    <div
                      key={item.id}
                      className="flex gap-3 border-b border-border px-4 py-3 text-xs last:border-b-0"
                    >
                      <span className="shrink-0 font-mono font-semibold text-primary">
                        {kind === "evidence" ? "E" : "O"}-{item.id}
                      </span>
                      <p className="flex-1 text-muted-foreground">
                        {item.description}
                      </p>
                      {"status" in item ? (
                        <Badge
                          tone={item.status === "open" ? "warning" : "neutral"}
                          className="ml-auto shrink-0 text-[10px]"
                        >
                          {item.status}
                        </Badge>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="px-4 py-6 text-center text-xs text-muted-foreground">
                  暂无数据
                </p>
              )}
            </section>
          )
        })}
      </div>
    </div>
  )
}
