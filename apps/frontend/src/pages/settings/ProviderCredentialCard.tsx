import { Icon } from "@iconify/react"
import { useEffect, useId, useState } from "react"
import {
  Badge,
  Button,
  ErrorNotice,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/index.ts"
import { apiMutation, apiRequest } from "../../lib/api.ts"
import { errorMessage } from "../../lib/format.ts"
import { cn } from "../../lib/utils.ts"
import type {
  ModelAuthLoginSessionView,
  ModelAuthProviderView,
} from "../../types.ts"

export function ProviderCredentialCard({
  provider,
  onRefresh,
  initialMethod,
  onCancel,
  editingConfigured = false,
}: {
  provider: ModelAuthProviderView
  onRefresh(): Promise<void>
  initialMethod?: string
  onCancel?(): void
  editingConfigured?: boolean
}) {
  const methodId = useId()
  const secretId = useId()
  const [method, setMethod] = useState(
    initialMethod ?? provider.methods[0]?.id ?? "",
  )
  const [secret, setSecret] = useState("")
  const [session, setSession] = useState<ModelAuthLoginSessionView | null>(null)
  const [promptValue, setPromptValue] = useState("")
  const [error, setError] = useState("")

  const sm = provider.methods.find((c) => c.id === method)

  useEffect(() => {
    if (!session || !["running", "awaiting_input"].includes(session.status))
      return
    const t = setInterval(() => {
      void apiRequest<ModelAuthLoginSessionView>(
        `/api/model-auth/login/${encodeURIComponent(session.id)}`,
      )
        .then(async (n) => {
          setSession(n)
          if (n.status === "success") await onRefresh()
        })
        .catch((e) => setError(errorMessage(e)))
    }, 1200)
    return () => clearInterval(t)
  }, [onRefresh, session])

  return (
    <div className="rounded-xl border border-border bg-muted/20 p-5">
      <div className="flex items-center gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted text-primary">
          <Icon icon="lucide:key-round" width="16" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{provider.name}</p>
          <p className="truncate text-[11px] text-muted-foreground">
            {provider.description}
          </p>
        </div>
        <Badge
          tone={provider.configured ? "positive" : "neutral"}
          className="shrink-0 text-[10px]"
        >
          {provider.configured ? "已认证" : "未连接"}
        </Badge>
      </div>

      {error ? <ErrorNotice message={error} className="mt-3" /> : null}

      {provider.configured && !editingConfigured ? (
        <div className="mt-4 flex items-center justify-between text-xs text-muted-foreground">
          <span>
            {provider.credentialType === "oauth" ? "OAuth" : "API Key"} 已保存
          </span>
          <Button
            size="sm"
            variant="danger"
            onClick={async () => {
              setError("")
              try {
                await apiMutation(
                  `/api/model-auth/providers/${encodeURIComponent(provider.id)}/logout`,
                  "POST",
                )
                setSession(null)
                await onRefresh()
              } catch (e) {
                setError(errorMessage(e))
              }
            }}
          >
            断开
          </Button>
        </div>
      ) : (
        <div className="mt-4 flex flex-1 flex-col justify-between gap-3">
          {provider.methods.length > 1 ? (
            <div>
              <label
                htmlFor={methodId}
                className="mb-1.5 block text-xs font-medium text-muted-foreground"
              >
                认证方式
              </label>
              <Select
                value={method}
                onValueChange={(v) => {
                  setMethod(v)
                  setSession(null)
                }}
              >
                <SelectTrigger id={methodId} className="w-full text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {provider.methods.map((m) => (
                    <SelectItem value={m.id} key={m.id}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
          {sm?.requiresSecret ? (
            <div>
              <label
                htmlFor={secretId}
                className="mb-1.5 block text-xs font-medium text-muted-foreground"
              >
                {provider.methods.length === 1 ? sm.label : "凭据"}
              </label>
              <Input
                id={secretId}
                type="password"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                placeholder={sm.description}
                className="h-8 text-xs"
              />
            </div>
          ) : null}
          <div className="flex justify-end gap-2">
            {provider.configured ? (
              <Button
                size="sm"
                variant="danger"
                onClick={async () => {
                  setError("")
                  try {
                    await apiMutation(
                      `/api/model-auth/providers/${encodeURIComponent(provider.id)}/logout`,
                      "POST",
                    )
                    setSession(null)
                    await onRefresh()
                  } catch (e) {
                    setError(errorMessage(e))
                  }
                }}
              >
                断开
              </Button>
            ) : null}
            {onCancel ? (
              <Button size="sm" variant="ghost" onClick={onCancel}>
                取消
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="secondary"
              onClick={async () => {
                setError("")
                try {
                  setSession(
                    await apiMutation<ModelAuthLoginSessionView>(
                      "/api/model-auth/login",
                      "POST",
                      {
                        provider: provider.id,
                        method,
                        ...(secret && { secret }),
                      },
                    ),
                  )
                } catch (e) {
                  setError(errorMessage(e))
                }
              }}
              disabled={!method || (sm?.requiresSecret === true && !secret)}
            >
              <Icon icon="lucide:link" width="13" />
              开始认证
            </Button>
          </div>
        </div>
      )}

      {session && session.status !== "success" ? (
        <div className="mt-4 space-y-3 border-t border-border pt-4">
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <Icon
              icon={
                session.status === "error"
                  ? "lucide:circle-x"
                  : "lucide:loader-circle"
              }
              className={cn(session.status === "running" && "animate-spin")}
              width="14"
            />
            {session.progress ??
              session.instructions ??
              session.error ??
              "等待认证"}
          </div>
          {session.authUrl ? (
            <a
              className="inline-flex items-center gap-1.5 text-[11px] text-info hover:underline"
              href={session.authUrl}
              target="_blank"
              rel="noreferrer"
            >
              浏览器打开 <Icon icon="lucide:external-link" width="12" />
            </a>
          ) : null}
          {session.deviceCode ? (
            <div className="rounded-lg border border-dashed border-border px-3 py-2 font-mono text-xs">
              <p className="text-muted-foreground">
                {session.deviceCode.verificationUri}
              </p>
              <p className="text-lg font-bold tracking-wider text-primary">
                {session.deviceCode.userCode}
              </p>
            </div>
          ) : null}
          {session.prompt ? (
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <label
                  htmlFor={`prompt-${session.id}`}
                  className="mb-1 block text-[11px] text-muted-foreground"
                >
                  {session.prompt.message}
                </label>
                {session.prompt.options ? (
                  <Select value={promptValue} onValueChange={setPromptValue}>
                    <SelectTrigger
                      id={`prompt-${session.id}`}
                      className="w-full text-xs"
                    >
                      <SelectValue placeholder="选择" />
                    </SelectTrigger>
                    <SelectContent>
                      {session.prompt.options.map((o) => (
                        <SelectItem value={o.id} key={o.id}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    id={`prompt-${session.id}`}
                    type={
                      session.prompt.type === "secret" ? "password" : "text"
                    }
                    value={promptValue}
                    placeholder={session.prompt.placeholder}
                    onChange={(e) => setPromptValue(e.target.value)}
                    className="h-8 text-xs"
                  />
                )}
              </div>
              <Button
                size="sm"
                onClick={async () => {
                  if (!session) return
                  setError("")
                  try {
                    setSession(
                      await apiMutation<ModelAuthLoginSessionView>(
                        `/api/model-auth/login/${encodeURIComponent(session.id)}/prompt`,
                        "POST",
                        { value: promptValue },
                      ),
                    )
                    setPromptValue("")
                  } catch (e) {
                    setError(errorMessage(e))
                  }
                }}
                disabled={!promptValue}
              >
                提交
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
