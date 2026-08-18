import { useState } from "react"
import { Button, ErrorNotice, Input, Label, Spinner, Switch } from "../../components/index.ts"
import { apiMutation } from "../../lib/api.ts"
import { errorMessage } from "../../lib/format.ts"
import type { ShellPoopConfigurationUpdate, ShellPoopConfigurationView } from "../../types.ts"

export function ShellPoopEditor({
  config,
  onSaved,
}: {
  config: ShellPoopConfigurationView
  onSaved: () => void
}) {
  const [enabled, setEnabled] = useState(config.enabled)
  const [baseUrl, setBaseUrl] = useState(config.baseUrl)
  const [timeoutMs, setTimeoutMs] = useState(config.timeoutMs?.toString() ?? "15000")
  const [err, setErr] = useState("")
  const [busy, setBusy] = useState(false)

  async function saveConfiguration() {
    setBusy(true)
    setErr("")
    try {
      const payload: ShellPoopConfigurationUpdate = {
        enabled,
        baseUrl,
        ...(timeoutMs.trim()
          ? { timeoutMs: Number(timeoutMs) > 0 ? Number(timeoutMs) : undefined }
          : {}),
      }
      await apiMutation("/api/global-config/shellpoop", "POST", payload)
      onSaved()
    } catch (e) {
      setErr(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      {err ? <ErrorNotice message={err} /> : null}

      <section className="flex items-center gap-3 pb-4">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold">ShellPoop（反弹 Shell）</h3>
          <p className="mt-1! text-xs text-muted-foreground">
            为 Agent 提供创建、交互与清理反弹 shell 的能力。需先启动 ShellPoop 服务 （
            <span className="font-mono">uv run shellpoop</span>），并保证目标主机能连回其 advertise
            host:port。
          </p>
        </div>
        <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="启用 shellpoop 插件" />
      </section>

      {enabled ? (
        <section className="border-t border-border py-4">
          <div className="grid max-w-xl gap-3">
            <div className="space-y-1">
              <Label>ShellPoop 服务地址（baseUrl）</Label>
              <Input
                type="text"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="http://127.0.0.1:8000"
                className="h-8 w-full font-mono text-xs"
              />
              <p className="text-[11px] text-muted-foreground">
                本地开发：http://127.0.0.1:8000；容器化部署：http://shellpoop:8000
              </p>
            </div>
            <div className="space-y-1">
              <Label>请求超时（毫秒）</Label>
              <Input
                type="number"
                min={1}
                value={timeoutMs}
                onChange={(e) => setTimeoutMs(e.target.value)}
                className="h-8 w-full text-xs"
              />
            </div>
          </div>
        </section>
      ) : null}

      <div className="flex justify-end border-t border-border pt-4">
        <Button variant="primary" onClick={() => void saveConfiguration()} disabled={busy}>
          {busy ? <Spinner className="size-4" /> : null}
          保存
        </Button>
      </div>
    </div>
  )
}
