import { Icon } from "@iconify/react"
import { useEffect, useState } from "react"
import {
  Badge,
  Button,
  Card,
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
import type {
  ModelAuthLoginSessionView,
  ModelAuthProviderView,
} from "../../types.ts"

export function ProviderCredentialCard({
  provider,
  onRefresh,
}: {
  provider: ModelAuthProviderView
  onRefresh(): Promise<void>
}): React.ReactElement {
  const [method, setMethod] = useState(provider.methods[0]?.id ?? "")
  const [secret, setSecret] = useState("")
  const [session, setSession] = useState<ModelAuthLoginSessionView | null>(null)
  const [promptValue, setPromptValue] = useState("")
  const [error, setError] = useState("")
  const selectedMethod = provider.methods.find(
    (candidate) => candidate.id === method,
  )

  useEffect(() => {
    if (!session || !["running", "awaiting_input"].includes(session.status))
      return
    const timer = window.setInterval(() => {
      void apiRequest<ModelAuthLoginSessionView>(
        `/api/model-auth/login/${encodeURIComponent(session.id)}`,
      )
        .then(async (next) => {
          setSession(next)
          if (next.status === "success") await onRefresh()
        })
        .catch((cause) => setError(errorMessage(cause)))
    }, 1_200)
    return () => window.clearInterval(timer)
  }, [onRefresh, session])

  async function connect(): Promise<void> {
    setError("")
    try {
      setSession(
        await apiMutation<ModelAuthLoginSessionView>(
          "/api/model-auth/login",
          "POST",
          { provider: provider.id, method, ...(secret ? { secret } : {}) },
        ),
      )
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  async function submitPrompt(): Promise<void> {
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
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  async function disconnect(): Promise<void> {
    setError("")
    try {
      await apiMutation(
        `/api/model-auth/providers/${encodeURIComponent(provider.id)}/logout`,
        "POST",
      )
      setSession(null)
      await onRefresh()
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  return (
    <Card className="provider-card">
      <div className="provider-heading">
        <span className="provider-icon">
          <Icon icon="lucide:key-round" width="17" />
        </span>
        <div>
          <strong>{provider.name}</strong>
          <small>{provider.description}</small>
        </div>
        <Badge tone={provider.configured ? "positive" : "neutral"}>
          {provider.configured ? "已认证" : "未连接"}
        </Badge>
      </div>
      {error ? <ErrorNotice message={error} /> : null}
      {provider.configured ? (
        <div className="provider-actions">
          <span>
            {provider.credentialType === "oauth" ? "OAuth 会话" : "API Key"}{" "}
            已保存
          </span>
          <Button size="sm" variant="danger" onClick={() => void disconnect()}>
            断开
          </Button>
        </div>
      ) : (
        <div className="provider-connect">
          <div className="field">
            <span>认证方式</span>
            <Select
              value={method}
              onValueChange={(next) => {
                setMethod(next as typeof method)
                setSession(null)
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {provider.methods.map((candidate) => (
                  <SelectItem value={candidate.id} key={candidate.id}>
                    {candidate.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {selectedMethod?.requiresSecret ? (
            <div className="field">
              <span>凭据</span>
              <Input
                type="password"
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
                placeholder={selectedMethod.description}
              />
            </div>
          ) : null}
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void connect()}
            disabled={
              !method || (selectedMethod?.requiresSecret === true && !secret)
            }
          >
            <Icon icon="lucide:link" width="14" />
            开始认证
          </Button>
        </div>
      )}
      {session && session.status !== "success" ? (
        <div className="auth-session">
          <div className="auth-session-status">
            <Icon
              icon={
                session.status === "error"
                  ? "lucide:circle-x"
                  : "lucide:loader-circle"
              }
              className={session.status === "running" ? "animate-spin" : ""}
              width="15"
            />
            {session.progress ??
              session.instructions ??
              session.error ??
              "等待认证"}
          </div>
          {session.authUrl ? (
            <a
              className="auth-link"
              href={session.authUrl}
              target="_blank"
              rel="noreferrer"
            >
              在浏览器中继续 <Icon icon="lucide:external-link" width="13" />
            </a>
          ) : null}
          {session.deviceCode ? (
            <div className="device-code">
              <span>{session.deviceCode.verificationUri}</span>
              <strong>{session.deviceCode.userCode}</strong>
            </div>
          ) : null}
          {session.prompt ? (
            <div className="auth-prompt">
              <div className="field">
                <span>{session.prompt.message}</span>
                {session.prompt.options ? (
                  <Select value={promptValue} onValueChange={setPromptValue}>
                    <SelectTrigger id={`auth-prompt-${session.id}`}>
                      <SelectValue placeholder="请选择" />
                    </SelectTrigger>
                    <SelectContent>
                      {session.prompt.options.map((option) => (
                        <SelectItem value={option.id} key={option.id}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    id={`auth-prompt-${session.id}`}
                    type={
                      session.prompt.type === "secret" ? "password" : "text"
                    }
                    value={promptValue}
                    placeholder={session.prompt.placeholder}
                    onChange={(event) => setPromptValue(event.target.value)}
                  />
                )}
              </div>
              <Button
                size="sm"
                onClick={() => void submitPrompt()}
                disabled={!promptValue}
              >
                提交
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </Card>
  )
}
