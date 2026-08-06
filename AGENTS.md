# AGENTS.md

## 项目概览

这是基于 Pi 的批量 CTF 解题控制面，使用 TypeScript、pnpm workspace、Vitest、Biome、SQLite 和 Docker。WebUI 管理模型/比赛配置与调度；每个 Solver Run 使用独立 Docker sandbox 和 Pi JSONL session，并可派发共享该 sandbox 的 SubAgent。

开始改动前先读 `README.md` 和 `docs/architecture.md`，再按任务查对应包。不要把历史 TODO 或审计文档当成当前事实；代码、测试和 `docs/` 中的现行设计文档才是依据。

## 快速定位

```text
packages/platform/  平台契约与 CTFd、GZCTF 插件
packages/sandbox/   Docker sandbox、ExecutionEnv、RTK、solver Dockerfile
packages/prompts/   Solver、SubAgent、TLDR 和项目上下文的共享提示词
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

## 开发规范

- 使用中文编写必要的注释
- 使用 Node.js 22.19+、仓库锁定的 pnpm 11；不要绕过 workspace 依赖。
- TypeScript 保持 strict、ESM 和显式 `.ts` 相对导入风格；公共类型从包 `src/index.ts` 导出。
- 用 Biome 格式化/检查。尽量做小而集中的改动，不在同一提交混入无关重构。
- 修改行为时，在所属包的 `test/` 中补或更新 Vitest 测试；优先测试公开行为和失败边界，不复制实现细节。
- 行为或配置发生变化时同步更新 README、对应 `docs/` 和本文件中的不变量。
- 多进行 git commit，commit message 遵循 gitmoji + conventional 混合规范，如 `✨ feat(solver): add a new feature`, `🐛 fix(core): fix something`

## 单元测试最佳实践

编写单元测试时必须遵循以下规则：

1. **充分利用 mock 和 stub**：用 mock 复制被依赖对象的可观察行为，用 stub 提供文件系统、数据库、网络和组件等外部依赖的确定性响应，使被测单元保持深度隔离。
2. **研究极端使用模式**：主动覆盖参数边界、空值、最大值、越界访问、重复操作和资源耗尽等不易察觉的边缘情况；发现设计缺陷时，即使代码当前仍可运行，也应重构而不是固化缺陷。
3. **保持测试简短、简单且快速**：测试代码应具备与生产代码相同的可读性和清晰度；每个测试只验证一个小而明确的模块行为，并保持足够快，以便频繁执行。
4. **注意命名规范**：测试名称必须简洁地描述被测主题、条件和预期结果，不得使用 `Test-1` 等无法表达测试目的的名称。
5. **覆盖所有可能发生的情况**：同时覆盖有效输入的正面场景、意外或无效输入的负面场景，以及关键边缘情况和边界条件。
6. **恢复测试环境**：每个测试结束后必须删除临时文件、恢复全局变量与 mock、关闭数据库连接和其他资源，保证后续测试从干净环境开始。
7. **保持测试与代码功能相适应**：测试应独立验证可观察的代码功能和底层业务规则，避免为了测试而增加或断言与真实行为无关的专用实现细节。

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
