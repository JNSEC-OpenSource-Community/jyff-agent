import { Icon } from "@iconify/react"
import { Card, PageHeader } from "./ui.tsx"

export function GlobalSettingsPlaceholder(): React.ReactElement {
  return (
    <div className="page page-narrow">
      <PageHeader
        eyebrow="GLOBAL"
        title="全局配置"
        description="模型供应商、凭据与 WebUI 登录策略。"
      />
      <Card className="placeholder-card">
        <Icon icon="lucide:construction" width="24" />
        <p>配置编辑器正在接入。</p>
      </Card>
    </div>
  )
}

export function ProjectSettingsPlaceholder(): React.ReactElement {
  return (
    <div className="page page-narrow">
      <PageHeader
        eyebrow="PROJECT"
        title="项目配置"
        description="比赛连接、模型绑定与并发策略。"
      />
      <Card className="placeholder-card">
        <Icon icon="lucide:construction" width="24" />
        <p>项目配置编辑器正在接入。</p>
      </Card>
    </div>
  )
}
