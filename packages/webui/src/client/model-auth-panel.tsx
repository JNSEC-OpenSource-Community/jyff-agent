import { useCallback, useEffect, useRef, useState } from "react"
import type {
  ModelAuthenticationView,
  ModelAuthLoginSessionView,
  ModelAuthProviderView,
} from "../types.ts"
import { controlPost, errorMessage, getJson } from "./lib.ts"

interface ModelAuthPanelProps {
  disabled: boolean
  onSelectModel: (provider: string, modelId: string) => void
  onCredentialsChanged: () => Promise<void>
  toast: (message: string, error?: boolean) => void
}

export function ModelAuthPanel(props: ModelAuthPanelProps) {
  const [authentication, setAuthentication] =
    useState<ModelAuthenticationView | null>(null)
  const [session, setSession] = useState<ModelAuthLoginSessionView | null>(null)
  const [secrets, setSecrets] = useState<Record<string, string>>({})
  const [selectedModels, setSelectedModels] = useState<Record<string, string>>(
    {},
  )
  const [promptValue, setPromptValue] = useState("")
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState("")
  const fileInput = useRef<HTMLInputElement>(null)

  const refreshAuthentication = useCallback(async () => {
    const value = await getJson<ModelAuthenticationView>("/api/model-auth")
    setAuthentication(value)
    setSelectedModels((current) => {
      const next = { ...current }
      for (const provider of value.providers) {
        if (!provider.models.some((model) => model.id === next[provider.id])) {
          next[provider.id] = provider.models[0]?.id ?? ""
        }
      }
      return next
    })
  }, [])

  useEffect(() => {
    let live = true
    void getJson<ModelAuthenticationView>("/api/model-auth")
      .then((value) => {
        if (!live) return
        setAuthentication(value)
        setSelectedModels(
          Object.fromEntries(
            value.providers.map((provider) => [
              provider.id,
              provider.models[0]?.id ?? "",
            ]),
          ),
        )
      })
      .catch((error) => {
        if (live) setFailure(errorMessage(error))
      })
    return () => {
      live = false
    }
  }, [])

  const activeSessionId = session?.id
  const activeSessionStatus = session?.status
  useEffect(() => {
    const sessionId = activeSessionId
    const sessionStatus = activeSessionStatus
    if (
      !sessionId ||
      !sessionStatus ||
      !["running", "awaiting_input"].includes(sessionStatus)
    ) {
      return
    }
    let live = true
    const poll = async () => {
      try {
        const next = await getJson<ModelAuthLoginSessionView>(
          `/api/model-auth/login/${encodeURIComponent(sessionId)}`,
        )
        if (!live) return
        setSession(next)
        if (next.status === "success") {
          await refreshAuthentication()
          await props.onCredentialsChanged()
          props.toast("模型凭据已保存")
        }
      } catch (error) {
        if (live) setFailure(errorMessage(error))
      }
    }
    const timer = window.setInterval(() => void poll(), 900)
    void poll()
    return () => {
      live = false
      window.clearInterval(timer)
    }
  }, [
    activeSessionId,
    activeSessionStatus,
    props.onCredentialsChanged,
    props.toast,
    refreshAuthentication,
  ])

  async function startLogin(
    provider: ModelAuthProviderView,
    method: ModelAuthProviderView["methods"][number],
  ) {
    const secret = secrets[provider.id]?.trim()
    if (method.requiresSecret && !secret) {
      setFailure(`${provider.name} ${method.label} 需要输入凭据`)
      return
    }
    setBusy(true)
    setFailure("")
    try {
      const next = await controlPost<ModelAuthLoginSessionView>(
        "/api/model-auth/login",
        {
          provider: provider.id,
          method: method.id,
          ...(secret ? { secret } : {}),
        },
      )
      setSession(next)
      setSecrets((current) => ({ ...current, [provider.id]: "" }))
    } catch (error) {
      setFailure(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  async function submitPrompt(event: React.FormEvent) {
    event.preventDefault()
    if (!session || !promptValue.trim()) return
    setBusy(true)
    setFailure("")
    try {
      setSession(
        await controlPost<ModelAuthLoginSessionView>(
          `/api/model-auth/login/${encodeURIComponent(session.id)}/prompt`,
          { value: promptValue.trim() },
        ),
      )
      setPromptValue("")
    } catch (error) {
      setFailure(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  async function cancelLogin() {
    if (!session) return
    setBusy(true)
    try {
      setSession(
        await controlPost<ModelAuthLoginSessionView>(
          `/api/model-auth/login/${encodeURIComponent(session.id)}/cancel`,
        ),
      )
    } catch (error) {
      setFailure(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  async function logout(provider: ModelAuthProviderView) {
    setBusy(true)
    setFailure("")
    try {
      await controlPost(
        `/api/model-auth/providers/${encodeURIComponent(provider.id)}/logout`,
      )
      await refreshAuthentication()
      await props.onCredentialsChanged()
      props.toast(`${provider.name} 凭据已移除`)
    } catch (error) {
      setFailure(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  async function importJson(raw?: string) {
    setBusy(true)
    setFailure("")
    try {
      const result = raw
        ? await controlPost<{ imported: { imported: unknown[] } }>(
            "/api/model-auth/import",
            { json: raw },
          )
        : await controlPost<{ imported: { imported: unknown[] } }>(
            "/api/model-auth/import-file",
          )
      await refreshAuthentication()
      await props.onCredentialsChanged()
      props.toast(`已导入 ${result.imported.imported.length} 组模型凭据`)
    } catch (error) {
      setFailure(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  async function readUpload(file: File | undefined) {
    if (!file) return
    try {
      await importJson(await file.text())
    } finally {
      if (fileInput.current) fileInput.current.value = ""
    }
  }

  const locked = props.disabled || busy
  return (
    <section className="model-auth-panel" aria-busy={busy}>
      <header className="model-auth-heading">
        <div>
          <span>PROVIDER CREDENTIALS</span>
          <h3>Codex / Claude 凭据</h3>
        </div>
        <div className="model-auth-imports">
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(event) => void readUpload(event.target.files?.[0])}
          />
          <button
            className="outline-button"
            type="button"
            disabled={locked}
            onClick={() => fileInput.current?.click()}
          >
            上传 auth.json
          </button>
          <button
            className="outline-button"
            type="button"
            disabled={locked || !authentication?.importFileAvailable}
            onClick={() => void importJson()}
            title={authentication?.importPath}
          >
            读取 /auth.json
          </button>
        </div>
      </header>

      {authentication ? (
        <div className="model-auth-providers">
          {authentication.providers.map((provider) => (
            <article
              className={`model-auth-provider${provider.configured ? " is-configured" : ""}`}
              key={provider.id}
            >
              <header>
                <div>
                  <strong>{provider.name}</strong>
                  <small>{provider.description}</small>
                </div>
                <span className="model-auth-state">
                  {provider.configured
                    ? provider.credentialType === "oauth"
                      ? "OAUTH READY"
                      : "API KEY READY"
                    : "NOT CONNECTED"}
                </span>
              </header>
              {provider.methods.some((method) => method.requiresSecret) ? (
                <input
                  className="model-auth-secret"
                  type="password"
                  value={secrets[provider.id] ?? ""}
                  onChange={(event) =>
                    setSecrets((current) => ({
                      ...current,
                      [provider.id]: event.target.value,
                    }))
                  }
                  placeholder={`${provider.name} API Key / Token`}
                  autoComplete="new-password"
                  disabled={locked}
                />
              ) : null}
              <div className="model-auth-actions">
                {provider.methods.map((method) => (
                  <button
                    className="outline-button"
                    type="button"
                    key={method.id}
                    title={method.description}
                    disabled={locked}
                    onClick={() => void startLogin(provider, method)}
                  >
                    {method.label}
                  </button>
                ))}
                {provider.configured ? (
                  <button
                    className="model-auth-logout"
                    type="button"
                    disabled={locked}
                    onClick={() => void logout(provider)}
                  >
                    移除
                  </button>
                ) : null}
              </div>
              {provider.configured && provider.models.length > 0 ? (
                <div className="model-auth-model-picker">
                  <select
                    value={selectedModels[provider.id] ?? ""}
                    onChange={(event) =>
                      setSelectedModels((current) => ({
                        ...current,
                        [provider.id]: event.target.value,
                      }))
                    }
                    disabled={locked}
                  >
                    {provider.models.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.name} · {Math.round(model.contextWindow / 1_000)}
                        k
                      </option>
                    ))}
                  </select>
                  <button
                    className="model-auth-use"
                    type="button"
                    disabled={locked || !selectedModels[provider.id]}
                    onClick={() =>
                      props.onSelectModel(
                        provider.id,
                        selectedModels[provider.id] ?? "",
                      )
                    }
                  >
                    填入模型配置
                  </button>
                </div>
              ) : null}
            </article>
          ))}
        </div>
      ) : (
        <p className="model-auth-loading">正在读取本地凭据状态…</p>
      )}

      {session ? (
        <div className={`model-auth-session is-${session.status}`}>
          <header>
            <strong>LOGIN SESSION / {session.provider}</strong>
            <span>{session.status.replace("_", " ").toUpperCase()}</span>
          </header>
          {session.authUrl ? (
            <p>
              <a href={session.authUrl} target="_blank" rel="noreferrer">
                打开授权页面 ↗
              </a>
              {session.instructions ? ` · ${session.instructions}` : ""}
            </p>
          ) : null}
          {session.deviceCode ? (
            <div className="model-auth-device-code">
              <code>{session.deviceCode.userCode}</code>
              <a
                href={session.deviceCode.verificationUri}
                target="_blank"
                rel="noreferrer"
              >
                {session.deviceCode.verificationUri}
              </a>
            </div>
          ) : null}
          {session.progress ? <p>{session.progress}</p> : null}
          {session.error ? (
            <p className="model-auth-error">{session.error}</p>
          ) : null}
          {session.prompt ? (
            <form
              className="model-auth-prompt"
              onSubmit={(event) => void submitPrompt(event)}
            >
              <label htmlFor="model-auth-prompt-input">
                <span>{session.prompt.message}</span>
                {session.prompt.type === "select" ? (
                  <select
                    id="model-auth-prompt-input"
                    value={promptValue}
                    onChange={(event) => setPromptValue(event.target.value)}
                    disabled={locked}
                  >
                    <option value="">请选择</option>
                    {session.prompt.options?.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    id="model-auth-prompt-input"
                    type={
                      session.prompt.type === "secret" ? "password" : "text"
                    }
                    value={promptValue}
                    onChange={(event) => setPromptValue(event.target.value)}
                    placeholder={session.prompt.placeholder}
                    disabled={locked}
                  />
                )}
              </label>
              <button type="submit" disabled={locked || !promptValue.trim()}>
                提交
              </button>
            </form>
          ) : null}
          {["running", "awaiting_input"].includes(session.status) ? (
            <button
              className="model-auth-cancel"
              type="button"
              disabled={locked}
              onClick={() => void cancelLogin()}
            >
              取消登录
            </button>
          ) : null}
        </div>
      ) : null}
      {failure ? (
        <p className="model-form-error" role="alert">
          {failure}
        </p>
      ) : null}
      <p className="model-auth-local-note">
        凭据仅写入本机持久卷；浏览器只接收状态与模型清单，不会读取 token 原文。
      </p>
    </section>
  )
}
