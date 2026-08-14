import { Icon } from "@iconify/react"
import { useRef, useState } from "react"
import { Link, useNavigate } from "react-router-dom"
import { useApp } from "../app/AppProvider.tsx"
import { Button, Card, ErrorNotice, Input, Label, PageHeader } from "../components/index.ts"
import { apiMutation, apiRequest } from "../lib/api.ts"
import { errorMessage } from "../lib/format.ts"

export function NewAuditProjectPage(): React.ReactElement {
  const { refreshAuditProjects } = useApp()
  const navigate = useNavigate()
  const input = useRef<HTMLInputElement>(null)
  const [name, setName] = useState("")
  const [archive, setArchive] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  const create = async () => {
    if (!archive || !name.trim()) return
    setBusy(true)
    setError("")
    try {
      const uploaded = await apiRequest<{
        archiveName: string
        archiveSize: number
        archivePath: string
      }>("/api/audits/upload", {
        method: "POST",
        headers: { "X-Archive-Name": archive.name, "Content-Type": "application/octet-stream" },
        body: archive,
      })
      const result = await apiMutation<{ audit: { id: string } }>("/api/audits", "POST", {
        name: name.trim(),
        ...uploaded,
      })
      await refreshAuditProjects()
      void navigate(`/audits/${encodeURIComponent(result.audit.id)}`)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="page-container">
      <PageHeader
        eyebrow="添加审计项目"
        title="登记源码归档"
        description="上传后在项目页选择审计模型和代码范围；归档不会进入 CTF 比赛工作区。"
        actions={
          <Button asChild variant="outline" size="sm">
            <Link to="/audits">返回项目</Link>
          </Button>
        }
      />
      {error ? <ErrorNotice message={error} className="mb-6" /> : null}
      <Card className="mx-auto max-w-3xl overflow-hidden p-0">
        <div className="border-b border-border bg-muted px-4 py-3">
          <div className="flex items-center gap-3">
            <span className="flex size-7 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">
              1
            </span>
            <h2 className="font-semibold">项目与源码</h2>
          </div>
          <p className="mt-1 pl-10 text-sm text-muted-foreground">
            提交归档后，下一步在项目配置中限定文件范围和模型。
          </p>
        </div>
        <div className="grid gap-5 p-5 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="audit-name">项目名称</Label>
            <Input
              id="audit-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="支付服务"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="audit-archive">源码压缩包</Label>
            <Input
              ref={input}
              id="audit-archive"
              type="file"
              accept=".zip,.tar,.tgz,.gz"
              onChange={(event) => setArchive(event.target.files?.[0] ?? null)}
            />
          </div>
          {archive ? (
            <p className="sm:col-span-2 font-mono text-xs text-muted-foreground">
              {archive.name} · {(archive.size / 1024 / 1024).toFixed(1)} MiB
            </p>
          ) : null}
        </div>
        <div className="flex justify-end border-t border-border bg-muted px-5 py-3">
          <Button disabled={!name.trim() || !archive || busy} onClick={() => void create()}>
            {busy ? (
              <Icon icon="lucide:loader-circle" className="animate-spin" width={15} />
            ) : (
              <Icon icon="lucide:arrow-right" width={15} />
            )}
            创建并配置
          </Button>
        </div>
      </Card>
    </div>
  )
}
