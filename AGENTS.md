# AGENTS.md

## 项目概览

这是基于 Pi 的批量 CTF 解题控制面，使用 TypeScript、pnpm workspace、Vitest、Biome、SQLite 和 Docker。WebUI 同时管理多个比赛 Project；全局层保存 Provider 凭据和模型池，每个 Project 独立保存平台连接、角色模型绑定、并发量、SQLite、workspace 与调度器。每个 Solver Run 使用独立 Docker sandbox 和 Pi JSONL session，并可派发共享该 sandbox 的 SubAgent。

开始改动前先读 `README.md` 和 `docs/architecture.md`，再按任务查对应包。不要把历史 TODO 或审计文档当成当前事实；代码、测试和 `docs/` 中的现行设计文档才是依据。

## 快速定位

```text
packages/platform/  平台契约与 CTFd、GZCTF 插件
packages/sandbox/   Docker sandbox、ExecutionEnv、RTK、solver Dockerfile
packages/prompts/   Solver、SubAgent、TLDR 和项目上下文的共享提示词
packages/agents/    BaseAgent、Pi session/skills、Solver/SubAgent 和工具
packages/core/      Project、调度器、RunStore、黑板、SubAgent manager
apps/backend/       Hono HTTP/SSE 服务、模型配置、WebUI 鉴权、Dockerfile
apps/frontend/      React 客户端（shadcn/ui + Tailwind v4，产物由 backend 托管）
docs/               当前架构与扩展协议
```

主要入口：

- `apps/backend/src/main.ts`：进程和 CLI；`apps/backend/src/server.ts`：应用装配（`createWebUiApp`/`startWebUi`）；`apps/backend/src/http/app.ts`：路由树组装；
- `apps/backend/src/http/routes/`：按域拆分的路由（system/projects/scheduler/challenges/runs/models）；`apps/backend/src/domain/`：模型池/凭据/runtime/调度器配置等领域服务；
- `apps/frontend/src/pages/`：页面（`challenge/` 与 `settings/` 为拆分后的子目录，挑战页含 TldrPanel/ConversationPanel 等）；`apps/frontend/src/hooks/`：SSE 订阅、对话、挑战详情等业务 hooks；`apps/frontend/src/lib/`：API 客户端与纯逻辑（conversation/challenge/format 等，配 `apps/frontend/test/` vitest 测试）；
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
- WebUI 基础组件遵循 shadcn/ui 的源码托管方式，放在 `apps/frontend/src/components/ui/`，配置入口为 `apps/frontend/components.json`；图标统一使用 Iconify，不提交裸 SVG React 组件。
- 修改行为时，在所属包的 `test/` 中补或更新 Vitest 测试；优先测试公开行为和失败边界，不复制实现细节。
- 行为或配置发生变化时同步更新 README、对应 `docs/` 和本文件中的不变量。
- 模型配置是全局 v3 模型池：凭据不进入 `model-config.json`，自定义 Provider 持有 API 类型和 Base URL；编辑自定义 Provider 时保持稳定 ID，未显式提交新 API Key 时保留原密钥。各 Project 在自己的 `runtime-config.json` 中为 Solver、TLDR 和 SubAgent role 绑定模型，并保存最大 Solver 并发量与最大远程环境数。传入 Agent 时必须保留完整 Pi `Models` registry。
- Clanker Father 的模型绑定保存在全局 `model-config.json`，不进入 Project runtime；Father Session 无参数创建并随机命名，插件身份由 Agent 确认。验证表单必须静态来自候选 schema v2 `extension.json.setup`，不得为展示表单在控制面进程导入未批准候选；候选只在 Docker Gate 中验证。配置按 schema fingerprint 复用，密钥写入 Secret Store且不进入 Agent 对话，安装始终需要用户批准。
- 远程环境必须经过 Project 级租约协调器：无附件远程题使用 required 优先级；带附件题先本地分析，调用 `ctf_instance_start` 后才进入 verification FIFO。required 只可抢占 verification，verification 不互相抢占；accepted 必须在 writeup 前释放，所有终态幂等清理，并只按 SQLite 租约回收本控制面遗留实例。
- 自定义 Provider 的模型发现由后端使用 Secret Store 中的密钥请求 `/models`，浏览器只能收到模型 ID；发现失败时模型池必须保留手工输入回退，不得回传上游错误正文或凭据。
- 多 Project 代码不得依赖“当前选中 Project”的隐式全局状态：HTTP API、SSE、Scheduler、RunStore、workspace 和平台 Secret 都必须按显式 Project ID 隔离。平台 Secret 写入全局 `secrets.json` 时必须使用 Project 命名空间。
- Project 的创建时间与归档状态由 `project-registry.json` 持久化；归档会暂停自动调度，但不打断正在运行的 Agent，最后一个活跃 Solver 结束后断开平台并保留只读本地 runtime。平台故障或归档时仍须允许读取 SQLite、历史对话、Writeup 与 workspace，但禁止启动或重试 Solver；不得退回浏览器本地状态。
- 重置所有 Solver 必须先关闭所属 Project 的 Scheduler、Solver、SubAgent、平台和 SQLite，再清除 `runs.sqlite*`、`runs/` 与 `challenges/` 并重连；不得删除 Project 注册、平台凭据、`project-config.json` 或 `runtime-config.json`。
- WebUI 使用 React Router 页面路由、Iconify 图标和基于 Radix/CVA 的 shadcn 风格组件。业务页面不使用裸 `<svg>`，不要重新引入巨型设置/详情弹窗；Solver 与 SubAgent 对话复用同一结构化 Pi session 组件。
- 题目 workspace 文件 API 只列出普通文件、不跟随 symlink，预览与下载必须同时通过相对路径与真实路径 containment 校验；列表保持 2,000 项上限。预览只允许扩展名白名单中的有效 UTF-8 代码/文档，大小上限 256 KiB。桌面侧栏折叠状态属于浏览器本地偏好，不写入 Project 配置。
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

后端路由改动后按域跑 `corepack pnpm exec vitest run apps/backend/test/<domain>.test.ts`；`apps/backend/test/helpers.ts` 提供 `createTestApp`/`jsonRequest`/`readSseUntil` 等内存装配助手（不占用端口）。

按改动范围先运行单包/单文件测试，提交前至少运行 `check`、`typecheck` 和相关测试。Dockerfile 改动还应运行 `docker build --check packages/sandbox/docker`；需要验证工具可执行性时再构建完整镜像。

## 文档索引

- `docs/architecture.md`：包边界、Solver 生命周期、持久化与中断恢复；
- `docs/platform-plugins.md`：CTFd/GZCTF 配置、认证和能力；
- `docs/blackboard-spec.md`：Evidence/Opportunity 协议；
- `docs/subagents.md`：worker 工具、角色 frontmatter 与派发约束。
