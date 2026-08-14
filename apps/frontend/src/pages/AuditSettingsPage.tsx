import type { CodeAuditProject } from "@ctf-agent/core"
import { Icon } from "@iconify/react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom"
import { useApp } from "../app/AppProvider.tsx"
import {
  Button,
  Card,
  Combobox,
  ConfirmDialog,
  EmptyState,
  ErrorNotice,
  PageHeader,
  Spinner,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from "../components/index.ts"
import { apiMutation, apiRequest } from "../lib/api.ts"
import { errorMessage } from "../lib/format.ts"

type Detail = {
  audit: CodeAuditProject
  models: Array<{ id: string; name: string; provider: string }>
}
type TreeNode = { name: string; path: string; children: Map<string, TreeNode>; file: boolean }
type SettingsTab = "model" | "scope" | "project"
const SETTINGS_TABS: Array<{ value: SettingsTab; label: string }> = [
  { value: "model", label: "模型" },
  { value: "scope", label: "源码范围" },
  { value: "project", label: "项目管理" },
]

export function AuditSettingsPage(): React.ReactElement {
  const { auditId = "" } = useParams()
  const navigate = useNavigate()
  const { refreshAuditProjects } = useApp()
  const [searchParams, setSearchParams] = useSearchParams()
  const [detail, setDetail] = useState<Detail | null>(null)
  const [files, setFiles] = useState<string[]>([])
  const [includePaths, setIncludePaths] = useState("")
  const [excludePaths, setExcludePaths] = useState("")
  const [auditModelId, setAuditModelId] = useState("")
  const [error, setError] = useState("")
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const activeTab = settingsTabFromSearch(searchParams.get("tab"))

  const load = useCallback(async () => {
    try {
      const next = await apiRequest<Detail>(`/api/audits/${encodeURIComponent(auditId)}`)
      setDetail(next)
      setIncludePaths(next.audit.includePaths.join("\n"))
      setExcludePaths(next.audit.excludePaths.join("\n"))
      setAuditModelId(next.audit.auditModelId)
      const list = await apiRequest<{ files: string[] }>(
        `/api/audits/${encodeURIComponent(auditId)}/files`,
      )
      setFiles(list.files)
      setError("")
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }, [auditId])
  useEffect(() => {
    void load()
  }, [load])
  const tree = useMemo(() => buildAuditTree(files), [files])
  const updateIncludePaths = (value: string) => {
    setIncludePaths(value)
    setExcludePaths((current) => removePaths(current, lines(value)))
  }
  const updateExcludePaths = (value: string) => {
    setExcludePaths(value)
    setIncludePaths((current) => removePaths(current, lines(value)))
  }
  const toggleIncludePath = (path: string) => {
    setIncludePaths((current) => togglePath(current, path))
    setExcludePaths((current) => removePath(current, path))
  }
  const toggleExcludePath = (path: string) => {
    setExcludePaths((current) => togglePath(current, path))
    setIncludePaths((current) => removePath(current, path))
  }
  if (!detail && !error)
    return (
      <div className="page-container">
        <Spinner label="加载审计设置" />
      </div>
    )
  if (error && !detail)
    return (
      <div className="page-container">
        <ErrorNotice message={error} />
      </div>
    )
  if (!detail)
    return (
      <div className="page-container">
        <EmptyState
          icon="lucide:file-question"
          title="找不到审计项目"
          description="该项目可能已删除。"
        />
      </div>
    )

  const save = async () => {
    setSaving(true)
    setError("")
    try {
      await apiMutation(`/api/audits/${encodeURIComponent(auditId)}`, "PATCH", {
        includePaths: lines(includePaths),
        excludePaths: lines(excludePaths),
        auditModelId,
      })
      await refreshAuditProjects()
      await load()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setSaving(false)
    }
  }
  const del = async () => {
    setDeleting(true)
    try {
      await apiMutation(`/api/audits/${encodeURIComponent(auditId)}`, "DELETE")
      await refreshAuditProjects()
      void navigate("/audits")
    } catch (cause) {
      setError(errorMessage(cause))
      setDeleting(false)
    }
  }

  return (
    <div className="page-container">
      <PageHeader
        eyebrow="审计设置"
        title={detail.audit.name}
        description="把常用选择留在对应的页面，保存后再开始下一轮审计。"
        actions={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button asChild variant="outline" size="sm">
              <Link to={`/audits/${encodeURIComponent(auditId)}`}>返回概览</Link>
            </Button>
            <Button size="sm" disabled={saving || !auditModelId} onClick={() => void save()}>
              {saving ? (
                <Icon
                  icon="lucide:loader-circle"
                  width={15}
                  className="animate-spin"
                  aria-hidden="true"
                />
              ) : (
                <Icon icon="lucide:save" width={15} aria-hidden="true" />
              )}
              {saving ? "保存中…" : "保存设置"}
            </Button>
          </div>
        }
      />
      {error ? <ErrorNotice message={error} className="mb-5" /> : null}

      <Tabs
        value={activeTab}
        onValueChange={(value) => {
          const next = new URLSearchParams(searchParams)
          next.set("tab", value)
          setSearchParams(next, { replace: true })
        }}
      >
        <TabsList className="mb-5 w-full justify-start overflow-x-auto rounded-md border-border/60 bg-muted/50 p-1 sm:w-fit">
          {SETTINGS_TABS.map((tab) => (
            <TabsTrigger className="min-w-28 flex-1 sm:flex-none" value={tab.value} key={tab.value}>
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="model">
          <Card className="overflow-hidden p-0">
            <CardHead title="审计模型" description="仅显示已配置的 Responses 兼容模型。" />
            <div className="p-5">
              <Combobox
                value={auditModelId}
                onChange={setAuditModelId}
                options={detail.models.map((model) => ({
                  value: model.id,
                  label: model.name,
                  description: model.provider,
                }))}
                placeholder="选择审计模型"
                emptyText="没有可用模型"
              />
              <p className="mt-3 max-w-2xl text-xs leading-5 text-muted-foreground">
                模型只决定下一轮审计使用的推理服务，不会改变已经完成的结果。
              </p>
            </div>
          </Card>
        </TabsContent>

        <TabsContent value="scope">
          <Card className="overflow-hidden p-0">
            <CardHead
              title="源码范围"
              description="选择目录或文件加入规则；包含与排除互斥，再次点击已选规则即可取消。"
            />
            <div className="grid gap-5 p-5 xl:grid-cols-[minmax(0,1fr)_22rem]">
              <div className="min-w-0">
                <FileTree
                  nodes={tree}
                  includePaths={includePaths}
                  excludePaths={excludePaths}
                  onInclude={toggleIncludePath}
                  onExclude={toggleExcludePath}
                />
              </div>
              <div className="grid content-start gap-4">
                <RangeBox
                  id="audit-include-paths"
                  label="包含规则"
                  value={includePaths}
                  onChange={updateIncludePaths}
                  placeholder={"apps/**\npackages/core/**"}
                />
                <RangeBox
                  id="audit-exclude-paths"
                  label="排除规则"
                  value={excludePaths}
                  onChange={updateExcludePaths}
                  placeholder={"node_modules/**\ndist/**"}
                />
              </div>
            </div>
          </Card>
        </TabsContent>

        <TabsContent value="project">
          <Card className="border-danger/30 p-0">
            <div className="flex flex-wrap items-center justify-between gap-4 p-5">
              <div>
                <h2 className="font-semibold">删除审计项目</h2>
                <p className="mt-1 max-w-xl text-sm leading-6 text-muted-foreground">
                  删除归档记录、所有 Run、发现和报告。此操作不能撤销，运行中的审计必须先取消。
                </p>
              </div>
              <Button
                variant="outline"
                className="border-danger/40 text-danger hover:bg-danger/10"
                onClick={() => setDeleting(true)}
              >
                <Icon icon="lucide:trash-2" width={15} aria-hidden="true" />
                删除项目
              </Button>
            </div>
          </Card>
        </TabsContent>
      </Tabs>

      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`删除 ${detail.audit.name}？`}
        description="永久删除此审计项目的归档记录、配置、运行、报告和发现。运行中的审计必须先取消。"
        confirmLabel="删除审计项目"
        busy={deleting}
        onConfirm={() => void del()}
      />
    </div>
  )
}

function CardHead({
  title,
  description,
}: {
  title: string
  description: string
}): React.ReactElement {
  return (
    <div className="border-b border-border/60 bg-muted/40 px-5 py-4">
      <h2 className="font-semibold">{title}</h2>
      <p className="mt-1 text-sm leading-6 text-muted-foreground">{description}</p>
    </div>
  )
}

function RangeBox({
  id,
  label,
  value,
  onChange,
  placeholder,
}: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  placeholder: string
}): React.ReactElement {
  return (
    <div>
      <label className="mb-1.5 block text-sm font-medium" htmlFor={id}>
        {label}
      </label>
      <Textarea
        id={id}
        name={id}
        className="min-h-35 font-mono text-xs leading-5"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        spellCheck={false}
      />
    </div>
  )
}

function FileTree({
  nodes,
  includePaths,
  excludePaths,
  onInclude,
  onExclude,
}: {
  nodes: TreeNode[]
  includePaths: string
  excludePaths: string
  onInclude: (path: string) => void
  onExclude: (path: string) => void
}): React.ReactElement {
  if (!nodes.length)
    return (
      <div className="rounded-md border border-dashed border-border px-4 py-8 text-sm text-muted-foreground">
        无法从归档读取文件树。
      </div>
    )
  return (
    <div className="overflow-hidden rounded-md border border-border/60">
      <div className="border-b border-border/60 bg-muted/40 px-4 py-2 text-xs text-muted-foreground">
        源码文件树 · 选择目录会添加 <code>/**</code> 规则，包含与排除互斥
      </div>
      <div className="max-h-140 overflow-auto py-1">
        {nodes.map((node) => (
          <TreeRow
            key={node.path}
            node={node}
            depth={0}
            includePaths={includePaths}
            excludePaths={excludePaths}
            onInclude={onInclude}
            onExclude={onExclude}
          />
        ))}
      </div>
    </div>
  )
}

function TreeRow({
  node,
  depth,
  includePaths,
  excludePaths,
  onInclude,
  onExclude,
}: {
  node: TreeNode
  depth: number
  includePaths: string
  excludePaths: string
  onInclude: (path: string) => void
  onExclude: (path: string) => void
}): React.ReactElement {
  const [open, setOpen] = useState(depth < 1)
  const rule = node.file ? node.path : `${node.path}/**`
  const selected = lines(includePaths).includes(rule)
  const excluded = lines(excludePaths).includes(rule)
  return (
    <>
      <div
        className="flex items-center gap-2 py-1.5 pr-2 hover:bg-muted/50"
        style={{ paddingLeft: `${12 + depth * 18}px` }}
      >
        {!node.file ? (
          <button
            type="button"
            onClick={() => setOpen(!open)}
            className="rounded-sm text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            aria-label={open ? `折叠 ${node.name}` : `展开 ${node.name}`}
          >
            <Icon
              icon={open ? "lucide:chevron-down" : "lucide:chevron-right"}
              width={14}
              aria-hidden="true"
            />
          </button>
        ) : null}
        <Icon
          icon={node.file ? "lucide:file" : "lucide:folder"}
          width={14}
          className="text-primary/70"
          aria-hidden="true"
        />
        <code className="min-w-0 flex-1 truncate text-xs">{node.name}</code>
        <Button
          type="button"
          size="sm"
          variant={selected ? "secondary" : "ghost"}
          aria-pressed={selected}
          onClick={() => onInclude(rule)}
        >
          包含
        </Button>
        <Button
          type="button"
          size="sm"
          variant={excluded ? "secondary" : "ghost"}
          aria-pressed={excluded}
          onClick={() => onExclude(rule)}
        >
          排除
        </Button>
      </div>
      {!node.file && open
        ? [...node.children.values()]
            .sort((a, b) => Number(a.file) - Number(b.file) || a.name.localeCompare(b.name))
            .map((child) => (
              <TreeRow
                key={child.path}
                node={child}
                depth={depth + 1}
                includePaths={includePaths}
                excludePaths={excludePaths}
                onInclude={onInclude}
                onExclude={onExclude}
              />
            ))
        : null}
    </>
  )
}

export function buildAuditTree(files: string[]): TreeNode[] {
  const root = new Map<string, TreeNode>()
  for (const file of files) {
    let children = root
    let path = ""
    const segments = file.split("/").filter(Boolean)
    for (const [index, name] of segments.entries()) {
      path = path ? `${path}/${name}` : name
      let node = children.get(name)
      if (!node) {
        node = { name, path, children: new Map(), file: index === segments.length - 1 }
        children.set(name, node)
      }
      children = node.children
    }
  }
  return [...root.values()].sort(
    (a, b) => Number(a.file) - Number(b.file) || a.name.localeCompare(b.name),
  )
}

function lines(value: string): string[] {
  return value
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean)
}

export function togglePath(value: string, path: string): string {
  const current = lines(value)
  return (
    current.includes(path) ? current.filter((item) => item !== path) : [...current, path]
  ).join("\n")
}

export function removePath(value: string, path: string): string {
  return lines(value)
    .filter((item) => item !== path)
    .join("\n")
}

function removePaths(value: string, paths: string[]): string {
  const blocked = new Set(paths)
  return lines(value)
    .filter((item) => !blocked.has(item))
    .join("\n")
}

export function settingsTabFromSearch(value: string | null): SettingsTab {
  return SETTINGS_TABS.some((tab) => tab.value === value) ? (value as SettingsTab) : "model"
}
