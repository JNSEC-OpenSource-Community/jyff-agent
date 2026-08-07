import { Icon } from "@iconify/react"
import { type FormEvent, useState } from "react"
import { Navigate, useNavigate } from "react-router-dom"
import { useApp } from "../app/AppProvider.tsx"
import { Button, ErrorNotice } from "../components/index.ts"
import { apiMutation } from "../lib/api.ts"

export function LoginPage(): React.ReactElement {
  const { auth, refreshAuth } = useApp()
  const navigate = useNavigate()
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)

  if (auth?.authenticated) return <Navigate to="/" replace />

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    setBusy(true)
    setError("")
    try {
      await apiMutation("/api/auth/login", "POST", { username, password })
      await refreshAuth()
      navigate("/", { replace: true })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="login-page">
      <section className="login-visual">
        <div className="login-brand">
          <span>CTF</span>
          <strong>AGENT</strong>
        </div>
        <div className="login-signal" aria-hidden="true">
          <span>01</span>
          <span>14</span>
          <span>∞</span>
        </div>
        <div>
          <p className="eyebrow">AUTONOMOUS OPERATIONS</p>
          <h1>
            让 Agent 进入赛场，
            <br />
            让证据留在系统。
          </h1>
          <p>多项目调度、隔离 Sandbox、可追溯对话与协作黑板。</p>
        </div>
      </section>
      <section className="login-form-wrap">
        <form className="login-form" onSubmit={(event) => void submit(event)}>
          <div className="login-form-heading">
            <span className="login-lock">
              <Icon icon="lucide:fingerprint" width="22" />
            </span>
            <div>
              <p className="eyebrow">RESTRICTED CONSOLE</p>
              <h2>登录控制台</h2>
            </div>
          </div>
          {error ? <ErrorNotice message={error} /> : null}
          <label className="field">
            <span>用户名</span>
            <input
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
          </label>
          <label className="field">
            <span>密码</span>
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <Button type="submit" disabled={busy || !username || !password}>
            {busy ? (
              <Icon icon="lucide:loader-circle" className="spin" width="17" />
            ) : (
              <Icon icon="lucide:log-in" width="17" />
            )}
            进入工作区
          </Button>
        </form>
      </section>
    </main>
  )
}
