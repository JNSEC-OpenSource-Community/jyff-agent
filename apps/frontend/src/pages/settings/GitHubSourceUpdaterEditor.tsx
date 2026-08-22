import { Icon } from "@iconify/react"
import { useEffect, useMemo, useState } from "react"
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  ErrorNotice,
  Input,
  Label,
  Spinner,
  Switch,
} from "../../components/index.ts"
import { apiMutation } from "../../lib/api.ts"
import { errorMessage } from "../../lib/format.ts"
import type {
  SourceUpdateOperationView,
  SourceUpdateRelation,
  SourceUpdaterView,
} from "../../types.ts"

export function GitHubSourceUpdaterEditor({
  config,
  authenticationEnabled,
  onSaved,
}: {
  config: SourceUpdaterView
  authenticationEnabled: boolean
  onSaved: () => void | Promise<void>
}) {
  const [enabled, setEnabled] = useState(config.configuration.enabled)
  const [automaticCheck, setAutomaticCheck] = useState(config.configuration.automaticCheck)
  const [intervalMinutes, setIntervalMinutes] = useState(
    String(config.configuration.intervalMinutes),
  )
  const [automaticApply, setAutomaticApply] = useState(config.configuration.automaticApply)
  const [applyPolicy, setApplyPolicy] = useState(config.configuration.applyPolicy)
  const [channelKind, setChannelKind] = useState(config.configuration.channel.kind)
  const [branch, setBranch] = useState(
    config.configuration.channel.kind === "branch" ? config.configuration.channel.ref : "main",
  )
  const [token, setToken] = useState("")
  const [busy, setBusy] = useState<
    "save" | "token" | "check" | "prepare" | "apply" | "rollback" | null
  >(null)
  const [error, setError] = useState("")
  const [confirmAction, setConfirmAction] = useState<"apply" | "rollback" | null>(null)

  useEffect(() => {
    setEnabled(config.configuration.enabled)
    setAutomaticCheck(config.configuration.automaticCheck)
    setIntervalMinutes(String(config.configuration.intervalMinutes))
    setAutomaticApply(config.configuration.automaticApply)
    setApplyPolicy(config.configuration.applyPolicy)
    setChannelKind(config.configuration.channel.kind)
    setBranch(
      config.configuration.channel.kind === "branch" ? config.configuration.channel.ref : "main",
    )
  }, [config.configuration])

  const channel = useMemo(
    () =>
      channelKind === "release"
        ? { kind: "release" as const }
        : { kind: "branch" as const, ref: branch },
    [branch, channelKind],
  )
  const changed =
    enabled !== config.configuration.enabled ||
    automaticCheck !== config.configuration.automaticCheck ||
    Number(intervalMinutes) !== config.configuration.intervalMinutes ||
    automaticApply !== config.configuration.automaticApply ||
    applyPolicy !== config.configuration.applyPolicy ||
    JSON.stringify(channel) !== JSON.stringify(config.configuration.channel)
  const operation = config.operation
  const candidate = config.candidate
  const canPrepare = Boolean(
    authenticationEnabled &&
    !config.current.dirty &&
    candidate?.relation === "ahead" &&
    config.executor.canPrepare,
  )
  const canApply = Boolean(
    authenticationEnabled &&
    (operation?.status === "prepared" || operation?.status === "waiting_for_idle") &&
    config.executor.canApply,
  )
  const isRunning =
    busy !== null ||
    ["checking", "preparing", "applying", "verifying"].includes(operation?.status ?? "")

  async function saveConfiguration() {
    setBusy("save")
    setError("")
    try {
      await apiMutation("/api/global-config/source-updater", "POST", {
        enabled,
        automaticCheck,
        intervalMinutes: Number(intervalMinutes),
        automaticApply,
        applyPolicy,
        channel,
      })
      await onSaved()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(null)
    }
  }

  async function saveToken() {
    setBusy("token")
    setError("")
    try {
      await apiMutation("/api/global-config/source-updater/github-token", "POST", {
        token: token.trim() || null,
      })
      setToken("")
      await onSaved()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(null)
    }
  }

  async function clearToken() {
    setBusy("token")
    setError("")
    try {
      await apiMutation("/api/global-config/source-updater/github-token", "POST", { token: null })
      await onSaved()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(null)
    }
  }

  async function checkNow() {
    setBusy("check")
    setError("")
    try {
      await apiMutation<SourceUpdateOperationView>(
        "/api/global-config/source-updater/check",
        "POST",
        {},
      )
      await onSaved()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(null)
    }
  }

  async function prepare() {
    if (!candidate) return
    setBusy("prepare")
    setError("")
    try {
      await apiMutation<SourceUpdateOperationView>(
        "/api/global-config/source-updater/prepare",
        "POST",
        { expectedTargetRevision: candidate.revision },
      )
      await onSaved()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(null)
    }
  }

  async function apply() {
    if (
      !operation ||
      (operation.status !== "prepared" && operation.status !== "waiting_for_idle") ||
      !candidate
    )
      return
    setBusy("apply")
    setError("")
    try {
      await apiMutation<SourceUpdateOperationView>(
        "/api/global-config/source-updater/apply",
        "POST",
        {
          operationId: operation.id,
          expectedCurrentRevision: config.current.revision,
          expectedTargetRevision: candidate.revision,
        },
      )
      await onSaved()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(null)
      setConfirmAction(null)
    }
  }

  async function rollback() {
    if (!operation) return
    setBusy("rollback")
    setError("")
    try {
      await apiMutation<SourceUpdateOperationView>(
        "/api/global-config/source-updater/rollback",
        "POST",
        { operationId: operation.id },
      )
      await onSaved()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(null)
      setConfirmAction(null)
    }
  }

  return (
    <div>
      {error ? <ErrorNotice message={error} className="mb-4" /> : null}

      <section className="flex items-start gap-3 pb-4">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-foreground text-background">
          <Icon icon="mdi:github" width="19" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold">GitHub 源码更新</h3>
          <p className="mt-1! text-xs leading-5 text-muted-foreground">
            检查受信仓库的新版本，并通过 Update Worker 安全准备和切换源码。
          </p>
        </div>
        <Switch
          checked={enabled}
          onCheckedChange={setEnabled}
          aria-label="启用 GitHub 源码更新插件"
        />
      </section>

      {enabled ? (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Card className="p-4">
              <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                当前版本
              </p>
              <p className="mt-2 font-mono text-lg font-semibold">
                {config.current.version ? `v${config.current.version}` : "开发版本"}
              </p>
              <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
                {shortRevision(config.current.revision)}
                {config.current.dirty ? " · 工作区有修改" : ""}
              </p>
              <p className="mt-2 text-[11px] text-muted-foreground">
                {config.current.repository} · {config.current.source}
              </p>
            </Card>
            <Card className="p-4">
              <div className="flex items-start justify-between gap-3">
                <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                  GitHub 候选
                </p>
                <RelationBadge relation={candidate?.relation} />
              </div>
              {candidate ? (
                <>
                  <p className="mt-2 font-mono text-lg font-semibold">
                    {candidate.version ? `v${candidate.version}` : candidate.ref}
                  </p>
                  <p className="mt-1 font-mono text-xs text-muted-foreground">
                    {shortRevision(candidate.revision)}
                    {candidate.aheadBy !== null ? ` · +${candidate.aheadBy} commits` : ""}
                  </p>
                  <a
                    href={candidate.htmlUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-2 inline-flex items-center gap-1 text-[11px] text-primary underline-offset-4 hover:underline"
                  >
                    查看 GitHub <Icon icon="lucide:arrow-up-right" width="12" aria-hidden="true" />
                  </a>
                </>
              ) : (
                <p className="mt-3 text-sm text-muted-foreground">还没有检查结果。</p>
              )}
            </Card>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={isRunning}
              onClick={() => void checkNow()}
            >
              {busy === "check" ? (
                <Spinner className="size-3.5" />
              ) : (
                <Icon icon="lucide:refresh-cw" width="14" />
              )}
              检查更新
            </Button>
            <Button size="sm" disabled={!canPrepare || isRunning} onClick={() => void prepare()}>
              {busy === "prepare" ? (
                <Spinner className="size-3.5" />
              ) : (
                <Icon icon="lucide:download" width="14" />
              )}
              准备更新
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={!canApply || isRunning}
              onClick={() => setConfirmAction("apply")}
            >
              <Icon icon="lucide:rocket" width="14" />
              应用并重启
            </Button>
            {operation?.status === "succeeded" ||
            operation?.status === "failed" ||
            operation?.status === "rollback_failed" ? (
              <Button
                size="sm"
                variant="danger"
                disabled={isRunning}
                onClick={() => setConfirmAction("rollback")}
              >
                <Icon icon="lucide:undo-2" width="14" />
                回滚
              </Button>
            ) : null}
          </div>

          <div className="surface-elevated overflow-hidden">
            <div className="grid gap-4 p-4 sm:grid-cols-2">
              <div className="space-y-1">
                <Label>受信仓库</Label>
                <Input
                  value={config.configuration.repository}
                  readOnly
                  className="h-8 font-mono text-xs"
                />
                <p className="text-[11px] text-muted-foreground">
                  仓库由服务端 allowlist 固定，不能从 WebUI 改成任意地址。
                </p>
              </div>
              <div className="space-y-1">
                <Label>更新通道</Label>
                <select
                  value={channelKind}
                  onChange={(event) => {
                    const next = event.target.value as "release" | "branch"
                    setChannelKind(next)
                    if (next === "branch") setAutomaticApply(false)
                  }}
                  className="h-8 w-full rounded-md border border-border bg-background px-2 text-xs outline-none focus:ring-2 focus:ring-ring"
                >
                  <option value="branch">Branch（开发通道）</option>
                  <option value="release">Release（稳定通道）</option>
                </select>
                {channelKind === "branch" ? (
                  <Input
                    aria-label="GitHub 分支"
                    value={branch}
                    onChange={(event) => setBranch(event.target.value)}
                    className="mt-2 h-8 font-mono text-xs"
                    placeholder="main"
                  />
                ) : null}
              </div>
              <label className="flex items-center justify-between gap-3 border-t border-border pt-3 text-xs sm:col-span-2">
                <span>
                  <span className="block font-medium">自动检查</span>
                  <span className="mt-1 block text-[11px] text-muted-foreground">
                    使用 ETag 低频轮询 GitHub，不会自动重启。
                  </span>
                </span>
                <Switch
                  checked={automaticCheck}
                  onCheckedChange={setAutomaticCheck}
                  aria-label="自动检查 GitHub 更新"
                />
              </label>
              {automaticCheck ? (
                <div className="space-y-1">
                  <Label>检查间隔（分钟）</Label>
                  <Input
                    type="number"
                    min={15}
                    max={1440}
                    value={intervalMinutes}
                    onChange={(event) => setIntervalMinutes(event.target.value)}
                    className="h-8 text-xs"
                  />
                </div>
              ) : null}
              <label className="flex items-center justify-between gap-3 border-t border-border pt-3 text-xs">
                <span>
                  <span className="block font-medium">自动应用</span>
                  <span className="mt-1 block text-[11px] text-muted-foreground">
                    {channelKind === "release"
                      ? "仅在配置了执行器且系统空闲时执行。"
                      : "开发分支只允许手动准备，自动应用需要 Release 通道。"}
                  </span>
                </span>
                <Switch
                  checked={automaticApply}
                  disabled={channelKind !== "release"}
                  onCheckedChange={setAutomaticApply}
                  aria-label="自动应用源码更新"
                />
              </label>
              {automaticApply ? (
                <div className="space-y-1">
                  <Label>应用策略</Label>
                  <select
                    value={applyPolicy}
                    onChange={(event) => setApplyPolicy(event.target.value as typeof applyPolicy)}
                    className="h-8 w-full rounded-md border border-border bg-background px-2 text-xs outline-none focus:ring-2 focus:ring-ring"
                  >
                    <option value="when-idle">系统空闲时</option>
                    <option value="maintenance-window">维护窗口（即将支持）</option>
                  </select>
                </div>
              ) : null}
            </div>

            <div className="flex flex-wrap items-end justify-between gap-3 border-t border-border px-4 py-3">
              <div className="text-[11px] text-muted-foreground">
                {config.executor.connected ? (
                  <span className="inline-flex items-center gap-1.5 text-positive">
                    <span className="size-1.5 rounded-full bg-positive" /> Update Worker 已连接
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 text-warning">
                    <span className="size-1.5 rounded-full bg-warning" />
                    {config.executor.reason ?? "Update Worker 未连接"}
                  </span>
                )}
                {config.lastCheckedAt ? (
                  <span className="ml-3">上次检查：{formatTime(config.lastCheckedAt)}</span>
                ) : null}
              </div>
              {changed ? (
                <Button size="sm" disabled={busy !== null} onClick={() => void saveConfiguration()}>
                  {busy === "save" ? (
                    <Spinner className="size-3.5" />
                  ) : (
                    <Icon icon="lucide:save" width="14" />
                  )}
                  保存更新策略
                </Button>
              ) : null}
            </div>
          </div>

          {!authenticationEnabled ? (
            <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
              <Icon
                icon="lucide:shield-alert"
                width="15"
                className="mt-0.5 shrink-0"
                aria-hidden="true"
              />
              <span>源码准备、应用和回滚需要先启用 WebUI 登录保护。</span>
            </div>
          ) : null}

          <div className="surface-elevated p-4">
            <div className="flex items-start gap-3">
              <Icon
                icon="lucide:key-round"
                width="16"
                className="mt-0.5 text-muted-foreground"
                aria-hidden="true"
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-xs font-medium">GitHub Token</p>
                  <Badge tone={config.configuration.githubTokenConfigured ? "positive" : "neutral"}>
                    {config.configuration.githubTokenConfigured ? "已配置" : "公共仓库可不配置"}
                  </Badge>
                </div>
                <p className="mt-1 text-[11px] leading-5 text-muted-foreground">
                  Token 只保存到后端 SecretStore；私有仓库建议使用仅 Metadata/Contents read 的
                  fine-grained Token。
                </p>
                <div className="mt-3 flex max-w-xl gap-2">
                  <Input
                    type="password"
                    value={token}
                    onChange={(event) => setToken(event.target.value)}
                    placeholder={
                      config.configuration.githubTokenConfigured
                        ? "留空则不修改"
                        : "GitHub fine-grained token"
                    }
                    className="h-8 text-xs"
                  />
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={!token.trim() || busy !== null}
                    onClick={() => void saveToken()}
                  >
                    {busy === "token" ? <Spinner className="size-3.5" /> : null}
                    保存 Token
                  </Button>
                  {config.configuration.githubTokenConfigured ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy !== null}
                      onClick={() => void clearToken()}
                    >
                      清除
                    </Button>
                  ) : null}
                </div>
              </div>
            </div>
          </div>

          {operation ? (
            <div className="border-l-2 border-primary/50 pl-3 text-xs">
              <p className="font-medium">{operation.message}</p>
              <p className="mt-1 text-muted-foreground">
                {operation.kind} · {operation.status} · {formatTime(operation.updatedAt)}
              </p>
              {operation.error ? <p className="mt-1 text-danger">{operation.error.code}</p> : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {changed && !enabled ? (
        <div className="flex justify-end border-t border-border pt-4">
          <Button size="sm" disabled={busy !== null} onClick={() => void saveConfiguration()}>
            {busy === "save" ? (
              <Spinner className="size-3.5" />
            ) : (
              <Icon icon="lucide:save" width="14" />
            )}
            保存更新策略
          </Button>
        </div>
      ) : null}

      <ConfirmDialog
        open={confirmAction === "apply"}
        onOpenChange={(open) => !open && setConfirmAction(null)}
        title="应用 GitHub 源码更新？"
        description={`服务将切换到 ${shortRevision(candidate?.revision)}，并重启 WebUI。应用前请确认没有正在运行的 Solver、Father 或 Audit。`}
        confirmLabel="确认应用并重启"
        busy={busy === "apply"}
        busyLabel="正在应用…"
        onConfirm={() => void apply()}
      />
      <ConfirmDialog
        open={confirmAction === "rollback"}
        onOpenChange={(open) => !open && setConfirmAction(null)}
        title="回滚源码版本？"
        description="更新执行器将尝试恢复上一个可用版本。当前运行会短暂重启。"
        confirmLabel="确认回滚"
        busy={busy === "rollback"}
        busyLabel="正在回滚…"
        onConfirm={() => void rollback()}
      />
    </div>
  )
}

function shortRevision(value: string | null | undefined): string {
  return value ? value.slice(0, 12) : "unknown"
}

function formatTime(value: string): string {
  const timestamp = Date.parse(value)
  return Number.isNaN(timestamp)
    ? value
    : new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short" }).format(timestamp)
}

function RelationBadge({ relation }: { relation?: SourceUpdateRelation }) {
  if (!relation) return <Badge tone="neutral">未检查</Badge>
  if (relation === "ahead") return <Badge tone="positive">有更新</Badge>
  if (relation === "identical") return <Badge tone="positive">已是最新</Badge>
  if (relation === "diverged") return <Badge tone="danger">版本分叉</Badge>
  if (relation === "behind") return <Badge tone="warning">候选较旧</Badge>
  return <Badge tone="warning">无法判断</Badge>
}
