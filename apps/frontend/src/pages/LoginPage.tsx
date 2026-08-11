import { Icon } from "@iconify/react"
import { type FormEvent, useState } from "react"
import { Navigate, useNavigate } from "react-router-dom"
import { useApp } from "../app/AppProvider.tsx"
import { Button, ErrorNotice, Input } from "../components/index.ts"
import { apiMutation } from "../lib/api.ts"

export function LoginPage() {
  const { auth, refreshAuth, refreshProjects } = useApp()
  const nav = useNavigate()
  const [u, setU] = useState("")
  const [p, setP] = useState("")
  const [err, setErr] = useState("")
  const [busy, setBusy] = useState(false)

  if (auth?.authenticated) return <Navigate to="/" replace />

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setErr("")
    try {
      await apiMutation("/api/auth/login", "POST", { username: u, password: p })
      await refreshAuth()
      await refreshProjects()
      void nav("/", { replace: true })
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-screen">
      {/* Brand panel */}
      <div className="relative hidden w-[44%] flex-col justify-between overflow-hidden border-r border-border bg-background p-14 lg:flex">
        <div className="login-grid absolute inset-0" />
        <div className="relative z-10 flex items-center gap-3 font-mono text-sm font-bold tracking-wide">
          <span className="text-primary">JYFF</span>
          <span className="text-foreground/50">AGENT</span>
        </div>
        <div className="relative z-10">
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-primary">CTF 控制台</p>
          <h1 className="mt-4 max-w-md text-4xl font-bold leading-tight tracking-tight lg:text-5xl">
            进入 JYFF Agent
          </h1>
          <p className="mt-4! max-w-sm text-sm leading-relaxed text-muted-foreground">
            连接比赛平台，管理题目与 Agent。
          </p>
        </div>
        <div
          className="relative z-10 flex items-center gap-10 font-mono text-[80px] font-extralight leading-none tracking-tighter text-foreground/3 lg:text-[96px]"
          aria-hidden
        >
          ∞<span className="text-primary/20">SL</span>OP
        </div>
      </div>

      {/* Login form */}
      <div className="flex flex-1 items-center justify-center p-6 sm:p-8">
        <form className="w-full max-w-sm space-y-5" onSubmit={(e) => void submit(e)}>
          <div className="flex items-center gap-4">
            <span className="flex size-10 items-center justify-center rounded-md border border-border bg-card text-foreground">
              <Icon icon="lucide:fingerprint" width="20" />
            </span>
            <div>
              <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
                Console
              </p>
              <h2 className="text-xl font-bold tracking-tight">登录</h2>
            </div>
          </div>

          {err ? <ErrorNotice message={err} /> : null}

          <div className="space-y-4">
            <div>
              <label
                htmlFor="username"
                className="mb-1.5 block text-xs font-medium text-muted-foreground"
              >
                用户名
              </label>
              <Input
                id="username"
                autoComplete="username"
                value={u}
                onChange={(e) => setU(e.target.value)}
              />
            </div>
            <div>
              <label
                htmlFor="password"
                className="mb-1.5 block text-xs font-medium text-muted-foreground"
              >
                密码
              </label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                value={p}
                onChange={(e) => setP(e.target.value)}
              />
            </div>
          </div>

          <Button type="submit" className="w-full" disabled={busy || !u || !p}>
            {busy ? (
              <Icon icon="lucide:loader-circle" className="animate-spin" width="15" />
            ) : (
              <Icon icon="lucide:log-in" width="15" />
            )}
            进入
          </Button>

          <p className="text-center text-xs text-muted-foreground lg:hidden">
            <span className="font-semibold text-primary">JYFF</span> Agent · CTF 控制台
          </p>
        </form>
      </div>
    </div>
  )
}
