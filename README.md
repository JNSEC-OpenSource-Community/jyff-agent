# JYFF Agent

基于 Pi 的批量 CTF 解题 Clanker：WebUI 管理 Project、平台连接、模型池、Solver、SubAgent 与 Clanker Father。

## 快速开始

要求 Node.js 22.19+、pnpm 11、Docker Engine。首次安装：

```bash
corepack pnpm install
corepack pnpm build:sandbox
corepack pnpm dev
```

生产构建与校验：

```bash
corepack pnpm check
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build:webui
```

开发服务启动后打开终端输出的 WebUI 地址。首次使用顺序建议为：先在全局设置中添加 Provider 和模型，再创建 Project，最后填写平台连接信息。没有可用 Solver 模型时，Project 可以浏览本地记录，但不能启动调度。

常用环境变量包括 `CTF_AGENT_ROOT`（数据根目录）、`CTF_AGENT_HOST`、`CTF_AGENT_PORT` 和 Docker 镜像配置。生产环境应把数据根目录放在持久化磁盘，并定期备份 `.ctf-agent`；其中 `secrets.json` 必须按密钥文件处理。

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

后端入口是 `apps/backend/src/main.ts`，HTTP 路由在 `apps/backend/src/http/routes`，前端页面在 `apps/frontend/src/pages`。修改行为时优先在对应包的 `test/` 增加公开行为测试，不要直接依赖内部字段。

## 数据布局

```text
.ctf-agent/
├── project-registry.json       # Project 索引
├── model-config.json            # 全局模型池 v3
├── secrets.json                 # Secret Store（不提交）
└── projects/<sha256-prefix>/   # Project 独立目录
    ├── project-config.json
    ├── runtime-config.json
    ├── runs.sqlite
    ├── runs/<run-id>/           # Pi JSONL 与运行产物
    ├── challenges/              # 题目 workspace
    └── extensions/              # 已安装插件 revision
```

Project 注册表的 `directory` 只允许 `.` 或由项目 ID 派生的哈希目录。删除 Project 会删除其状态目录；“重置 Solver”只删除 runs、challenges 和 SQLite，不删除 Project 配置、模型或平台凭据。

## 文档

- [架构](docs/architecture.md)
- [平台插件](docs/platform-plugins.md)
- [黑板协议](docs/blackboard-spec.md)
- [SubAgent](docs/subagents.md)
- [Father 插件开发](packages/agents/skills/extension-authoring/SKILL.md)

## 故障排查

| 现象 | 检查项 |
| --- | --- |
| Docker create name conflict | `docker ps -a --filter name=ctf-solver`，确认残留容器后删除或改名 |
| Project 显示只读 | 查看平台连接、最近成功快照和后端日志；连接恢复后会自动恢复调度 |
| 模型不可用 | 检查模型池条目、Provider 凭据、API 类型和 `/models` 发现结果 |
| Father 验证失败 | 确认候选 hash 未变化、setup 表单已保存、Validation Gate 报告属于当前 session |
| WebUI 无事件 | 检查浏览器网络面板中的 SSE 连接和 Project ID 是否正确 |

代码提交前至少运行 `corepack pnpm check`、`corepack pnpm typecheck` 和受影响包的 Vitest；Dockerfile 修改还要运行 `docker build --check`。
