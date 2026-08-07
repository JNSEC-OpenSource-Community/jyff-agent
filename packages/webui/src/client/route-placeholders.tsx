import { Icon } from "@iconify/react"
import { useParams } from "react-router-dom"
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

export function ChallengePlaceholder(): React.ReactElement {
  const { challengeId } = useParams()
  return (
    <div className="page">
      <PageHeader
        eyebrow="CHALLENGE"
        title={challengeId ?? "题目"}
        description="Solver 与 SubAgent 对话工作区。"
      />
      <Card className="placeholder-card">
        <Icon icon="lucide:messages-square" width="24" />
        <p>对话视图正在接入。</p>
      </Card>
    </div>
  )
}
