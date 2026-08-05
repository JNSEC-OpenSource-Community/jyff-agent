# AGENTS.md

## 项目概览

这是基于 Pi 的批量 CTF 解题控制面，使用 TypeScript、pnpm workspace、Vitest、Biome、SQLite 和 Docker。WebUI 管理模型/比赛配置与调度；每个 Solver Run 使用独立 Docker sandbox 和 Pi JSONL session，并可派发共享该 sandbox 的 SubAgent。

开始改动前先读 `README.md` 和 `docs/architecture.md`，再按任务查对应包。不要把历史 TODO 或审计文档当成当前事实；代码、测试和 `docs/` 中的现行设计文档才是依据。

## 快速定位

```text
packages/platform/  平台契约与 CTFd、GZCTF 插件
packages/sandbox/   Docker sandbox、ExecutionEnv、RTK、solver Dockerfile
packages/agents/    BaseAgent、Pi session/skills、Solver/SubAgent 和工具
packages/core/      Project、调度器、RunStore、黑板、SubAgent manager
packages/webui/     进程入口、HTTP/SSE、模型配置、React 客户端
docs/               当前架构与扩展协议
```

主要入口：

- `packages/webui/src/main.ts`：进程和 CLI；
- `packages/core/src/project/project.ts`：单个 Solver Run 的装配；
- `packages/core/src/orchestration/contest-scheduler.ts`：生产调度；
- `packages/core/src/persistence/run-store.ts`：SQLite 权威状态；
- `packages/agents/src/base-agent/`：Pi runtime/session/thinking；
- `packages/agents/src/subagent/registry.ts`：SubAgent 角色；
- `packages/sandbox/docker/Dockerfile`：solver 工具镜像。

## 必须保持的边界

- 依赖方向保持 `webui → core → agents/platform/sandbox`；`agents` 不得依赖 `core`、Project 或 SQLite。
- 平台层暴露绑定单题的 `ChallengeCapability`；不要让 Solver 用任意 challenge ID 操作其他题。
- 完整对话只保存在 Pi JSONL session；SQLite 保存 Run/事件/调度/SubAgent 摘要/黑板，不复制 transcript。
- Agent 的 shell 和文件工具必须经 `DockerExecutionEnv`，不能在宿主机执行。容器内路径目前不做 `/workspace` scope 限制。
- 题目元数据通过结构化 `<challenge_context>` 初始消息提供，附件在 Solver 创建时自动下载；不要重新增加 ChallengeReadTools。
- Solver 默认 thinkingLevel 为 `medium`，使用 Pi 的 `clampThinkingLevel` 做模型映射。SubAgent thinkingLevel 只在角色 registry/frontmatter 中配置，不从 Solver 继承。
- Session 未提交 Flag 就结束时，关闭旧 Solver/SubAgent 并创建全新 Run/session；中断计数超过阈值后保持 `blocked`，只能由人工强制派发重置。
- SubAgent 不提交 Flag、不管理远端实例、不直接写黑板。派发 prompt 必须符合 `packages/core/prompts/project.ts` 的占位协议。

## 开发规范

- 使用 Node.js 22.19+、仓库锁定的 pnpm 11；不要绕过 workspace 依赖。
- TypeScript 保持 strict、ESM 和显式 `.ts` 相对导入风格；公共类型从包 `src/index.ts` 导出。
- 用 Biome 格式化/检查。尽量做小而集中的改动，不在同一提交混入无关重构。
- 修改行为时，在所属包的 `test/` 中补或更新 Vitest 测试；优先测试公开行为和失败边界，不复制实现细节。
- 修改 RunStore schema 时保留 `CREATE TABLE IF NOT EXISTS` 和旧数据库迁移，跨表状态变更使用事务。
- 修改 React 源码后运行 WebUI build；`packages/webui/src/client/app.js` 是构建产物，不要手工编辑。
- 修改 Dockerfile 中下载的第三方二进制/字典时固定版本并校验 checksum，同时更新 `packages/sandbox/docker/THIRD_PARTY_TOOLS.md`。
- 行为或配置发生变化时同步更新 README、对应 `docs/` 和本文件中的不变量。

## 验证命令

```bash
corepack pnpm install
corepack pnpm check
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build:webui
```

按改动范围先运行单包/单文件测试，提交前至少运行 `check`、`typecheck` 和相关测试。Dockerfile 改动还应运行 `docker build --check packages/sandbox/docker`；需要验证工具可执行性时再构建完整镜像。

## 文档索引

- `docs/architecture.md`：包边界、Solver 生命周期、持久化与中断恢复；
- `docs/platform-plugins.md`：CTFd/GZCTF 配置、认证和能力；
- `docs/blackboard-spec.md`：Evidence/Opportunity 协议；
- `docs/subagents.md`：worker 工具、角色 frontmatter 与派发约束。
