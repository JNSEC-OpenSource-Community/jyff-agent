# CTF Agent

基于 Pi 的批量 CTF 解题控制面：WebUI 管理 Project、平台连接、模型池、Solver、SubAgent 与 Clanker Father。

## 快速开始

要求 Node.js 22.19+、pnpm 11、Docker Engine。首次安装：

```bash
corepack pnpm install
corepack pnpm dev
```

生产构建与校验：

```bash
corepack pnpm check
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build:webui
```

## 目录

| 目录 | 职责 |
| --- | --- |
| `apps/backend` | Hono API、SSE、鉴权、模型与 Father 服务 |
| `apps/frontend` | React Router WebUI |
| `packages/core` | Project、调度器、RunStore、控制面 |
| `packages/agents` | Pi Agent、Solver、SubAgent、Father 工具 |
| `packages/platform` | CTFd、GZCTF 与插件契约 |
| `packages/sandbox` | Docker sandbox 与执行环境 |
| `packages/prompts` | 角色提示词 |
| `packages/web-access` | 搜索、页面读取与正文提取 |

## 当前配置

- 全局模型池唯一格式为 `model-config.json` v3；凭据只进 Secret Store。
- Project 状态位于 `.ctf-agent/project-registry.json` 与哈希子目录。
- Project 的 `runtime-config.json` 绑定 Solver、TLDR、SubAgent 和最大并发。
- 平台 Secret 必须使用 Project 命名空间。
- 插件唯一接受 extension schema v2：`extension.json` + TypeScript/JavaScript 入口。

不再读取旧版模型文件、旧 Project 根配置、未命名空间 Secret 或旧插件 schema。

## 运行流程

1. 创建 Project，配置平台和全局模型。
2. 调度器创建 Solver Run；每个 Run 使用独立 Docker sandbox 和 Pi JSONL session。
3. Solver 可派发共享 sandbox 的 SubAgent，结果通过结构化消息回传。
4. TLDR 读取 workspace 与只读工具生成摘要，不创建额外容器。
5. 平台故障时保留最后成功快照，Project 进入只读降级；恢复后继续调度。

## Clanker Father

Father 在独立 session 中修复平台适配或创建插件。session 自动命名并保留历史。候选插件必须声明 schema v2 `setup`，在 Docker Validation Gate 中验证；验证配置由 WebUI 表单收集，凭据通过一次性授权请求注入，不写入对话。安装前必须人工批准，成功后可下载完整 workspace 或单个入口文件。

## 安全边界

- Agent 只能操作其 sandbox/workspace；控制面源码不直接暴露给 Solver。
- 插件候选在批准前不导入主进程，验证使用短生命周期容器。
- 文件 API 做路径 containment、普通文件、UTF-8、大小和数量限制。
- 删除 Project、安装插件、提供测试凭据等动作需要明确用户操作。

## 文档

- [架构](docs/architecture.md)
- [平台插件](docs/platform-plugins.md)
- [黑板协议](docs/blackboard-spec.md)
- [SubAgent](docs/subagents.md)
- [Father 插件开发](packages/agents/skills/extension-authoring/SKILL.md)
