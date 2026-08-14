import type {
  CodeAuditCoverageDocument,
  CodeAuditCoverageOpenQuestion,
  CodeAuditFindingRecord,
  CodeAuditFindingsDocument,
  CodeAuditManifest,
} from "@ctf-agent/core"
import { Icon } from "@iconify/react"
import { Badge, Button, Card, EmptyState, Textarea } from "../../components/index.ts"
import { SyntaxHighlightedCode } from "../../components/content/SyntaxHighlightedCode.tsx"

export function AuditResultSummary({
  findings,
  coverage,
  manifest,
}: {
  findings: CodeAuditFindingsDocument | null
  coverage: CodeAuditCoverageDocument | null
  manifest: CodeAuditManifest | null
}): React.ReactElement | null {
  if (!findings && !coverage && !manifest) return null
  const records = findings?.findings ?? []
  const highRisk = records.filter((finding) =>
    ["critical", "high"].includes(finding.severity.level),
  ).length
  const followUps = (coverage?.deferred.length ?? 0) + (coverage?.openQuestions?.length ?? 0)
  return (
    <Card className="mb-5 overflow-hidden p-0">
      <div className="grid divide-y divide-border/60 sm:grid-cols-4 sm:divide-x sm:divide-y-0">
        <ResultMetric
          value={records.length}
          label="结构化发现"
          tone={records.length ? "danger" : "neutral"}
        />
        <ResultMetric
          value={highRisk}
          label="高风险及以上"
          tone={highRisk ? "danger" : "neutral"}
        />
        <ResultMetric
          value={coverage?.completeness ?? "—"}
          label="覆盖完整度"
          tone={coverage?.completeness === "complete" ? "positive" : "warning"}
        />
        <ResultMetric
          value={followUps}
          label="待继续研究"
          tone={followUps ? "warning" : "neutral"}
        />
      </div>
    </Card>
  )
}

function ResultMetric({
  value,
  label,
  tone,
}: {
  value: string | number
  label: string
  tone: "danger" | "positive" | "warning" | "neutral"
}): React.ReactElement {
  return (
    <div className="px-4 py-3">
      <strong
        className={`block font-mono text-lg font-semibold tabular-nums ${
          tone === "danger"
            ? "text-danger"
            : tone === "positive"
              ? "text-success"
              : tone === "warning"
                ? "text-warning"
                : "text-foreground"
        }`}
      >
        {value}
      </strong>
      <span className="mt-0.5 block text-[11px] text-muted-foreground">{label}</span>
    </div>
  )
}

export function AuditFindingsPanel({
  document,
}: {
  document: CodeAuditFindingsDocument | null
}): React.ReactElement {
  const findings = document?.findings ?? []
  if (!document) {
    return (
      <EmptyState
        icon="lucide:scan-search"
        title="没有可用的 findings.json"
        description="该运行没有生成可校验的结构化发现文件。原始产物仍可在文件页查看。"
      />
    )
  }
  if (!findings.length) {
    return (
      <EmptyState
        icon="lucide:circle-check"
        title="没有结构化发现"
        description="本轮 findings.json 没有保留可报告的问题。请结合覆盖范围确认审计是否完整。"
      />
    )
  }
  const cwes = [...new Set(findings.flatMap((finding) => finding.taxonomy?.cwe ?? []))]
  return (
    <div className="grid gap-4">
      <Card className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="field-label">finding inventory</p>
            <h2 className="mt-1 text-base font-semibold">{findings.length} 个结构化发现</h2>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            {cwes.map((cwe) => (
              <CweBadge cwe={cwe} key={cwe} />
            ))}
          </div>
        </div>
      </Card>
      <div className="grid gap-4">
        {findings.map((finding, index) => (
          <FindingCard
            finding={finding}
            index={index}
            key={finding.occurrenceId || finding.findingId}
          />
        ))}
      </div>
    </div>
  )
}

function FindingCard({
  finding,
  index,
}: {
  finding: CodeAuditFindingRecord
  index: number
}): React.ReactElement {
  const location = finding.locations[0]
  const cwes = finding.taxonomy?.cwe ?? []
  return (
    <Card className="overflow-hidden p-0">
      <article>
        <header className="border-b border-border/60 px-4 py-4 sm:px-5">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-danger/10 font-mono text-[11px] font-semibold text-danger">
              {String(index + 1).padStart(2, "0")}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <h3 className="min-w-0 text-sm font-semibold text-wrap-balance">{finding.title}</h3>
                <Badge tone={findingTone(finding.severity.level)}>{finding.severity.level}</Badge>
              </div>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
                {finding.summary}
              </p>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 pl-9 font-mono text-[11px] text-muted-foreground">
            {location ? (
              <span>
                {location.path}:{location.startLine}
                {location.endLine && location.endLine !== location.startLine
                  ? `–${location.endLine}`
                  : ""}
              </span>
            ) : null}
            <span>{finding.ruleId}</span>
            {finding.taxonomy?.category ? <span>{finding.taxonomy.category}</span> : null}
          </div>
        </header>
        <div className="grid gap-5 p-4 sm:p-5 xl:grid-cols-[minmax(0,1fr)_18rem]">
          <div className="min-w-0 space-y-5">
            <FindingEvidence finding={finding} />
            <FindingLocations locations={finding.locations} />
            <TextSection title="修复建议" icon="lucide:wrench">
              <p className="whitespace-pre-wrap text-sm leading-6">{finding.remediation}</p>
            </TextSection>
            {finding.remediationTests?.length ? (
              <TextList
                title="修复验证"
                icon="lucide:test-tube-2"
                items={finding.remediationTests}
              />
            ) : null}
            {finding.preventiveControls?.length ? (
              <TextList
                title="预防控制"
                icon="lucide:shield-check"
                items={finding.preventiveControls}
              />
            ) : null}
          </div>
          <aside className="min-w-0 space-y-4">
            <FindingMetadata finding={finding} cwes={cwes} />
            {finding.rootCause ? (
              <StructuredSection title="根因" value={finding.rootCause} icon="lucide:git-branch" />
            ) : null}
            {finding.validation ? (
              <StructuredSection
                title="验证记录"
                value={finding.validation}
                icon="lucide:clipboard-check"
              />
            ) : null}
            {finding.attackPath ? (
              <StructuredSection title="攻击路径" value={finding.attackPath} icon="lucide:route" />
            ) : null}
            {finding.writeup ? (
              <StructuredSection title="报告引用" value={finding.writeup} icon="lucide:file-text" />
            ) : null}
            <details className="group rounded-md border border-border/60 bg-muted/20">
              <summary className="cursor-pointer list-none px-3 py-2.5 text-xs font-semibold text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40">
                <span className="inline-flex items-center gap-2">
                  <Icon icon="lucide:braces" width="14" aria-hidden="true" />
                  查看原始字段
                  <Icon
                    icon="lucide:chevron-down"
                    width="13"
                    className="transition-transform duration-200 group-open:rotate-180"
                    aria-hidden="true"
                  />
                </span>
              </summary>
              <pre className="max-h-80 overflow-auto border-t border-border/60 p-3 font-mono text-[10px] leading-5 text-muted-foreground">
                {prettyJson(finding)}
              </pre>
            </details>
          </aside>
        </div>
      </article>
    </Card>
  )
}

function FindingEvidence({
  finding,
}: {
  finding: CodeAuditFindingRecord
}): React.ReactElement | null {
  if (!finding.codeEvidence?.length) return null
  return (
    <TextSection title="代码引用" icon="lucide:code-2">
      <div className="grid gap-3">
        {finding.codeEvidence.map((evidence) => (
          <figure
            className="overflow-hidden rounded-md border border-border/60 bg-background"
            key={evidence.id}
          >
            <figcaption className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 bg-muted/30 px-3 py-2 font-mono text-[11px] text-muted-foreground">
              <span className="min-w-0 truncate">
                {evidence.path}:{evidence.startLine}
                {evidence.endLine && evidence.endLine !== evidence.startLine
                  ? `–${evidence.endLine}`
                  : ""}
              </span>
              <span>{evidence.role ?? evidence.label}</span>
            </figcaption>
            <pre className="max-h-80 overflow-auto p-3 font-mono text-[11px] leading-5 text-foreground">
              <SyntaxHighlightedCode code={evidence.code} language={evidence.language} />
            </pre>
            {evidence.explanation ? (
              <p className="border-t border-border/60 px-3 py-2 text-xs leading-5 text-muted-foreground">
                {evidence.explanation}
              </p>
            ) : null}
          </figure>
        ))}
      </div>
    </TextSection>
  )
}

function FindingLocations({
  locations,
}: {
  locations: CodeAuditFindingRecord["locations"]
}): React.ReactElement | null {
  if (!locations.length) return null
  return (
    <TextSection title="受影响位置" icon="lucide:map-pin">
      <ul className="grid gap-1.5">
        {locations.map((location, index) => (
          <li
            className="flex min-w-0 items-center gap-2 text-xs"
            key={`${location.path}:${location.startLine}:${index}`}
          >
            <Icon
              icon="lucide:arrow-up-right"
              width="13"
              className="shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            <code className="min-w-0 truncate">
              {location.path}:{location.startLine}
              {location.endLine && location.endLine !== location.startLine
                ? `–${location.endLine}`
                : ""}
            </code>
            {location.role ? <span className="text-muted-foreground">{location.role}</span> : null}
          </li>
        ))}
      </ul>
    </TextSection>
  )
}

function FindingMetadata({
  finding,
  cwes,
}: {
  finding: CodeAuditFindingRecord
  cwes: string[]
}): React.ReactElement {
  return (
    <div className="rounded-md border border-border/60 bg-muted/20 p-3">
      <div className="grid gap-3 text-xs">
        <MetaRow label="置信度" value={finding.confidence.level} />
        <MetaRow label="置信度依据" value={finding.confidence.rationale} />
        {finding.severity.score !== undefined ? (
          <MetaRow
            label={finding.severity.scoringSystem ?? "评分"}
            value={`${finding.severity.score}${finding.severity.vector ? ` · ${finding.severity.vector}` : ""}`}
          />
        ) : null}
        {finding.severity.rationale ? (
          <MetaRow label="严重性依据" value={finding.severity.rationale} />
        ) : null}
        {finding.severity.changeConditions ? (
          <MetaRow label="变化条件" value={finding.severity.changeConditions} />
        ) : null}
        <MetaRow label="Occurrence" value={finding.occurrenceId} mono />
        <MetaRow label="Rule" value={finding.ruleId} mono />
        {finding.fingerprints.primary ? (
          <MetaRow label="Fingerprint" value={textValue(finding.fingerprints.primary)} mono />
        ) : null}
        {finding.identity.anchor ? (
          <MetaRow label="识别锚点" value={textValue(finding.identity.anchor)} mono />
        ) : null}
        <div>
          <span className="field-label">CWE</span>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {cwes.length ? cwes.map((cwe) => <CweBadge cwe={cwe} key={cwe} />) : <span>—</span>}
          </div>
        </div>
        {finding.provenance.source ? (
          <MetaRow label="来源" value={textValue(finding.provenance.source)} />
        ) : null}
      </div>
    </div>
  )
}

function MetaRow({
  label,
  value,
  mono = false,
}: {
  label: string
  value: string
  mono?: boolean
}): React.ReactElement {
  return (
    <div className="min-w-0">
      <span className="field-label">{label}</span>
      <p
        className={`mt-1 break-words leading-5 text-foreground/85 ${mono ? "font-mono text-[10px]" : ""}`}
      >
        {value || "—"}
      </p>
    </div>
  )
}

function CweBadge({ cwe }: { cwe: string }): React.ReactElement {
  const match = /^CWE-(\d+)$/iu.exec(cwe)
  const content = <span className="font-mono text-[10px]">{cwe}</span>
  return match ? (
    <a
      className="inline-flex items-center gap-1 rounded-sm border border-border bg-muted px-1.5 py-0.5 text-muted-foreground transition-colors hover:border-hover-border hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
      href={`https://cwe.mitre.org/data/definitions/${match[1]}.html`}
      target="_blank"
      rel="noreferrer"
      title={`在 MITRE 查看 ${cwe}`}
    >
      {content}
      <Icon icon="lucide:external-link" width="11" aria-hidden="true" />
    </a>
  ) : (
    <span className="inline-flex rounded-sm border border-border bg-muted px-1.5 py-0.5 text-muted-foreground">
      {content}
    </span>
  )
}

function TextSection({
  title,
  icon,
  children,
}: {
  title: string
  icon: string
  children: React.ReactNode
}): React.ReactElement {
  return (
    <section>
      <h4 className="mb-2 flex items-center gap-2 text-xs font-semibold text-muted-foreground">
        <Icon icon={icon} width="14" aria-hidden="true" />
        {title}
      </h4>
      {children}
    </section>
  )
}

function TextList({
  title,
  icon,
  items,
}: {
  title: string
  icon: string
  items: string[]
}): React.ReactElement {
  return (
    <TextSection title={title} icon={icon}>
      <ul className="grid gap-2 text-sm leading-6">
        {items.map((item, index) => (
          <li className="flex items-start gap-2" key={`${item}:${index}`}>
            <span
              className="mt-2 size-1.5 shrink-0 rounded-full bg-primary/60"
              aria-hidden="true"
            />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </TextSection>
  )
}

function StructuredSection({
  title,
  icon,
  value,
}: {
  title: string
  icon: string
  value: unknown
}): React.ReactElement {
  return (
    <details className="group rounded-md border border-border/60 bg-muted/20">
      <summary className="cursor-pointer list-none px-3 py-2.5 text-xs font-semibold text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40">
        <span className="inline-flex items-center gap-2">
          <Icon icon={icon} width="14" aria-hidden="true" />
          {title}
          <Icon
            icon="lucide:chevron-down"
            width="13"
            className="transition-transform duration-200 group-open:rotate-180"
            aria-hidden="true"
          />
        </span>
      </summary>
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words border-t border-border/60 p-3 font-mono text-[10px] leading-5 text-muted-foreground">
        {typeof value === "string" ? value : prettyJson(value)}
      </pre>
    </details>
  )
}

export function AuditCoveragePanel({
  coverage,
  onUsePrompt,
}: {
  coverage: CodeAuditCoverageDocument | null
  onUsePrompt?: (prompt: string) => void
}): React.ReactElement {
  if (!coverage) {
    return (
      <EmptyState
        icon="lucide:scan-line"
        title="没有可用的 coverage.json"
        description="该运行没有生成可校验的覆盖范围文件。请打开输出文件查看原始产物。"
      />
    )
  }
  const questions = coverage.openQuestions ?? []
  return (
    <div className="grid gap-4">
      <Card className="p-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="field-label">coverage receipt</p>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <h2 className="text-base font-semibold">覆盖范围与未决事项</h2>
              <Badge tone={coverageTone(coverage.completeness)}>{coverage.completeness}</Badge>
            </div>
          </div>
          <dl className="grid grid-cols-2 gap-x-5 gap-y-2 text-right text-xs sm:grid-cols-4">
            <CoverageStat label="模式" value={coverage.mode} />
            <CoverageStat label="清单策略" value={coverage.inventoryStrategy} />
            <CoverageStat label="已审表面" value={coverage.surfaces.length} />
            <CoverageStat label="延后项" value={coverage.deferred.length} />
          </dl>
        </div>
      </Card>
      <ScopeReceipt coverage={coverage} />
      <CoverageSurfaces surfaces={coverage.surfaces} />
      {coverage.explicitExclusions.length ? (
        <CoverageList
          title="明确排除"
          icon="lucide:eye-off"
          items={coverage.explicitExclusions.map((item) => `${item.pattern} · ${item.reason}`)}
        />
      ) : null}
      {coverage.deferred.length ? (
        <CoverageList
          title="延后处理"
          icon="lucide:clock-3"
          items={coverage.deferred.map((item) => {
            const paths = item.paths?.length ? ` · ${item.paths.join(", ")}` : ""
            const surfaces = item.surfaceIds?.length
              ? ` · surfaces: ${item.surfaceIds.join(", ")}`
              : ""
            return `${item.id} · ${item.reason}${paths}${surfaces}`
          })}
        />
      ) : null}
      <OpenQuestions questions={questions} onUsePrompt={onUsePrompt} />
      <details className="group rounded-md border border-border/60 bg-muted/20">
        <summary className="cursor-pointer list-none px-4 py-3 text-xs font-semibold text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40">
          <span className="inline-flex items-center gap-2">
            <Icon icon="lucide:braces" width="14" aria-hidden="true" />
            查看 coverage.json 原始字段
            <Icon
              icon="lucide:chevron-down"
              width="13"
              className="transition-transform duration-200 group-open:rotate-180"
              aria-hidden="true"
            />
          </span>
        </summary>
        <pre className="max-h-96 overflow-auto border-t border-border/60 p-4 font-mono text-[10px] leading-5 text-muted-foreground">
          {prettyJson(coverage)}
        </pre>
      </details>
    </div>
  )
}

function ScopeReceipt({ coverage }: { coverage: CodeAuditCoverageDocument }): React.ReactElement {
  return (
    <Card className="p-4">
      <h3 className="flex items-center gap-2 text-xs font-semibold text-muted-foreground">
        <Icon icon="lucide:scan-search" width="14" aria-hidden="true" />
        实际审计范围
      </h3>
      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        <PathGroup label="包含" paths={coverage.includePaths} empty="完整仓库" />
        <PathGroup label="排除" paths={coverage.excludePaths} empty="无" />
      </div>
    </Card>
  )
}

function PathGroup({
  label,
  paths,
  empty,
}: {
  label: string
  paths: string[]
  empty: string
}): React.ReactElement {
  return (
    <div>
      <span className="field-label">{label}</span>
      {paths.length ? (
        <ul className="mt-1.5 grid gap-1">
          {paths.map((path) => (
            <li className="break-all font-mono text-xs text-foreground/80" key={path}>
              {path}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1.5 text-xs text-muted-foreground">{empty}</p>
      )}
    </div>
  )
}

function CoverageSurfaces({
  surfaces,
}: {
  surfaces: CodeAuditCoverageDocument["surfaces"]
}): React.ReactElement {
  if (!surfaces.length)
    return (
      <EmptyState
        icon="lucide:layers-3"
        title="没有覆盖表面"
        description="coverage.json 未记录审计表面。"
      />
    )
  return (
    <Card className="overflow-hidden p-0">
      <div className="border-b border-border/60 px-4 py-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <Icon icon="lucide:layers-3" width="15" aria-hidden="true" />
          审计表面
        </h3>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[42rem] border-collapse text-left text-xs">
          <thead className="bg-muted/30 text-muted-foreground">
            <tr>
              <th className="px-4 py-2.5 font-medium">表面</th>
              <th className="px-4 py-2.5 font-medium">结论</th>
              <th className="px-4 py-2.5 font-medium">风险区域</th>
              <th className="px-4 py-2.5 font-medium">备注</th>
              <th className="px-4 py-2.5 font-medium">凭据</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/60">
            {surfaces.map((surface) => (
              <tr className="align-top" key={surface.id}>
                <td className="px-4 py-3">
                  <strong className="font-medium">{surface.label}</strong>
                  <code className="mt-1 block break-all text-[10px] text-muted-foreground">
                    {surface.id}
                  </code>
                </td>
                <td className="px-4 py-3">
                  <Badge tone={surfaceTone(surface.disposition)}>{surface.disposition}</Badge>
                </td>
                <td className="px-4 py-3 text-muted-foreground">{surface.riskArea ?? "—"}</td>
                <td className="max-w-xs whitespace-pre-wrap px-4 py-3 leading-5 text-muted-foreground">
                  {surface.notes ?? "—"}
                </td>
                <td className="px-4 py-3 font-mono text-[10px] text-muted-foreground">
                  {surface.receiptRefs.length ? surface.receiptRefs.join(", ") : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

function CoverageList({
  title,
  icon,
  items,
}: {
  title: string
  icon: string
  items: string[]
}): React.ReactElement {
  return (
    <Card className="p-4">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <Icon icon={icon} width="15" aria-hidden="true" />
        {title}
      </h3>
      <ul className="mt-3 grid gap-2 text-sm leading-6">
        {items.map((item, index) => (
          <li className="flex items-start gap-2" key={`${item}:${index}`}>
            <span
              className="mt-2 size-1.5 shrink-0 rounded-full bg-muted-foreground/60"
              aria-hidden="true"
            />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </Card>
  )
}

function OpenQuestions({
  questions,
  onUsePrompt,
}: {
  questions: Array<CodeAuditCoverageOpenQuestion | string>
  onUsePrompt?: (prompt: string) => void
}): React.ReactElement {
  if (!questions.length) {
    return (
      <Card className="border-success/25 bg-success/5 p-4">
        <p className="flex items-center gap-2 text-sm font-medium text-success">
          <Icon icon="lucide:circle-check" width="15" aria-hidden="true" />
          coverage.json 没有记录未决问题
        </p>
      </Card>
    )
  }
  return (
    <Card className="border-warning/30 bg-warning/5 p-4">
      <div className="flex items-start gap-3">
        <Icon
          icon="lucide:circle-help"
          width="17"
          className="mt-0.5 shrink-0 text-warning"
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold">开放问题</h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            选择一个方向填入 follow-up prompt，或在下方输入自己的研究问题。
          </p>
          <ul className="mt-3 grid gap-2">
            {questions.map((entry, index) => {
              const question = typeof entry === "string" ? entry : entry.question
              const prompt =
                typeof entry === "string" ? entry : entry.followUpPrompt || entry.question
              return (
                <li
                  className="flex flex-col gap-2 rounded-md border border-border/60 bg-background/50 p-3 sm:flex-row sm:items-start sm:justify-between"
                  key={`${question}:${index}`}
                >
                  <span className="min-w-0 text-sm leading-6">{question}</span>
                  {onUsePrompt ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="shrink-0"
                      onClick={() => onUsePrompt(prompt)}
                    >
                      <Icon icon="lucide:corner-down-left" width="14" aria-hidden="true" />
                      使用这个方向
                    </Button>
                  ) : null}
                </li>
              )
            })}
          </ul>
        </div>
      </div>
    </Card>
  )
}

export function AuditFollowUpComposer({
  draft,
  onChange,
  onSubmit,
  disabled = false,
}: {
  draft: string
  onChange: (value: string) => void
  onSubmit: () => void
  disabled?: boolean
}): React.ReactElement {
  return (
    <Card className="overflow-hidden border-primary/20 p-0">
      <div className="border-b border-border/60 bg-muted/20 px-4 py-3 sm:px-5">
        <div className="flex items-center gap-2">
          <span className="flex size-6 items-center justify-center rounded-md bg-primary/10 text-primary">
            <Icon icon="lucide:corner-down-left" width="14" aria-hidden="true" />
          </span>
          <div>
            <h3 className="text-sm font-semibold">继续研究</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              基于当前项目创建一轮新的隔离审计，并在扫描后执行这条提示。
            </p>
          </div>
        </div>
      </div>
      <div className="grid gap-3 p-4 sm:p-5">
        <label className="field-label" htmlFor="audit-follow-up-prompt">
          研究方向
        </label>
        <Textarea
          id="audit-follow-up-prompt"
          name="audit-follow-up-prompt"
          value={draft}
          onChange={(event) => onChange(event.target.value)}
          maxLength={32_000}
          spellCheck
          placeholder="例如：继续检查认证边界，重点确认未授权用户能否通过这个入口到达敏感操作…"
          className="min-h-28 resize-y text-sm leading-6"
          disabled={disabled}
        />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
            {draft.length.toLocaleString()} / 32,000
          </span>
          <Button type="button" onClick={onSubmit} disabled={disabled || !draft.trim()}>
            {disabled ? (
              <Icon
                icon="lucide:loader-circle"
                width="15"
                className="animate-spin"
                aria-hidden="true"
              />
            ) : (
              <Icon icon="lucide:play" width="15" aria-hidden="true" />
            )}
            {disabled ? "启动中…" : "开始 follow-up"}
          </Button>
        </div>
      </div>
    </Card>
  )
}

export function AuditManifestPanel({
  manifest,
}: {
  manifest: CodeAuditManifest | null
}): React.ReactElement | null {
  if (!manifest) return null
  const scan = manifest.scan
  const target = scan.target
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="field-label">scan manifest</p>
          <h3 className="mt-1 text-sm font-semibold">扫描记录</h3>
        </div>
        <code className="max-w-full break-all font-mono text-[10px] text-muted-foreground">
          {scan.id}
        </code>
      </div>
      <dl className="mt-4 grid gap-x-6 gap-y-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
        <ManifestValue label="目标类型" value={target.kind} />
        <ManifestValue label="目标名称" value={target.displayName} />
        <ManifestValue label="生产者" value={textValue(scan.producer.name)} />
        <ManifestValue label="版本" value={textValue(scan.producer.version)} />
        <ManifestValue label="开始" value={formatTime(scan.startedAt)} />
        <ManifestValue label="完成" value={formatTime(scan.completedAt)} />
        <ManifestValue label="封存" value={formatTime(scan.sealedAt)} />
        <ManifestValue label="修订" value={target.revision ?? target.headRevision ?? "—"} mono />
      </dl>
      {scan.scope.summary ? (
        <p className="my-4 border-t border-border/60 pt-3 text-xs leading-5 text-muted-foreground">
          {textValue(scan.scope.summary)}
        </p>
      ) : null}
      {scan.threatModel ? (
        <StructuredSection title="威胁模型" value={scan.threatModel} icon="lucide:shield-alert" />
      ) : null}
      {scan.scope.limitations ? (
        <StructuredSection
          title="范围限制"
          value={scan.scope.limitations}
          icon="lucide:triangle-alert"
        />
      ) : null}
      {scan.artifacts.length ? (
        <details className="group mt-4 border-t border-border/60 pt-3">
          <summary className="cursor-pointer list-none text-xs font-semibold text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40">
            包含 {scan.artifacts.length} 个封存产物
          </summary>
          <ul className="mt-2 grid gap-1.5">
            {scan.artifacts.map((artifact) => (
              <li
                className="flex min-w-0 flex-wrap gap-x-3 gap-y-1 font-mono text-[10px] text-muted-foreground"
                key={`${artifact.path}:${artifact.sha256}`}
              >
                <span className="min-w-0 break-all text-foreground/80">{artifact.path}</span>
                <span>{artifact.mediaType}</span>
                <span className="break-all">{artifact.sha256}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </Card>
  )
}

function ManifestValue({
  label,
  value,
  mono = false,
}: {
  label: string
  value: string
  mono?: boolean
}): React.ReactElement {
  return (
    <div className="min-w-0">
      <dt className="field-label">{label}</dt>
      <dd className={`mt-1 break-all text-foreground/85 ${mono ? "font-mono text-[10px]" : ""}`}>
        {value || "—"}
      </dd>
    </div>
  )
}

function CoverageStat({
  label,
  value,
}: {
  label: string
  value: string | number
}): React.ReactElement {
  return (
    <div>
      <dt className="field-label">{label}</dt>
      <dd className="mt-1 font-mono text-foreground/85">{value || "—"}</dd>
    </div>
  )
}

function findingTone(
  level: CodeAuditFindingRecord["severity"]["level"],
): "danger" | "warning" | "info" | "neutral" {
  return level === "critical" || level === "high"
    ? "danger"
    : level === "medium"
      ? "warning"
      : level === "low"
        ? "info"
        : "neutral"
}

function coverageTone(
  value: CodeAuditCoverageDocument["completeness"],
): "positive" | "warning" | "neutral" {
  return value === "complete" ? "positive" : value === "partial" ? "warning" : "neutral"
}

function surfaceTone(
  value: CodeAuditCoverageDocument["surfaces"][number]["disposition"],
): "positive" | "warning" | "danger" | "neutral" {
  return value === "reported"
    ? "danger"
    : value === "needs_follow_up"
      ? "warning"
      : value === "no_issue_found"
        ? "positive"
        : "neutral"
}

function textValue(value: unknown): string {
  if (typeof value === "string") return value
  if (value === null || value === undefined) return "—"
  return prettyJson(value)
}

function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "—"
  } catch {
    return String(value)
  }
}

function formatTime(value: string | undefined): string {
  if (!value) return "—"
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return value
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    date,
  )
}
