# 系统架构与实现

本文描述当前代码实现，而不是理想中的插件平台或分布式调度系统。主要入口、边界和状态均以 `apps/` 与 `packages/` 中的 TypeScript 为准。

## 1. 分层与职责

```text
React WebUI
    │ HTTP / SSE
    ▼
Hono API ── authenticationGate、schema、routes
    ▼
ControlPlane ── Project registry、SecretStore、连接生命周期
    ▼
Project ── PlatformProject、RunStore、workspace、Agent 组装
    ▼
ContestScheduler / ContestRunner
    ▼
CtfSolverAgent ── ChallengeCapability、DockerExecutionEnv
    ├── CtfSubagentManager ── SubAgent fleet
    ├── blackboard tools ── RunStore SQLite
    └── web-access ── backend 宿主网络
```

| 层           | 代码位置                                          | 责任和可见结果                                                                    |
| ------------ | ------------------------------------------------- | --------------------------------------------------------------------------------- |
| WebUI        | `apps/frontend/src/main.tsx`、`src/pages/`        | 登录、Project、队列、题目对话、SubAgent、Father 和设置页面；通过 API/SSE 更新状态 |
| HTTP/SSE     | `apps/backend/src/http/app.ts`、`routes/`、`sse/` | 认证、输入校验、Project 作用域、快照、流式事件和静态资源                          |
| ControlPlane | `packages/core/src/control-plane/`                | 读取 Project 注册表，创建/断开 Project，维护选择项、归档、降级和 SecretStore      |
| Project      | `packages/core/src/project/project.ts`            | 隔离单个比赛的平台连接、RunStore、workspace、远程环境、黑板、TLDR 和 Agent        |
| 调度         | `packages/core/src/orchestration/`                | 自动队列、并发、重试、阻塞、恢复和 Writeup 收尾                                   |
| Agent        | `packages/agents/src/`                            | Pi session、Solver、SubAgent、Father、技能和工具装配                              |
| 平台         | `packages/platform/src/`                          | CTFd/GZCTF 适配器、统一能力契约、插件注册和验证器                                 |
| 执行环境     | `packages/sandbox/src/`                           | 通过 Docker CLI 创建 sandbox，并在容器内执行命令和文件操作                        |
| 持久化       | `packages/core/src/persistence/run-store.ts`      | SQLite 中的 Run、事件、队列、usage、快照、黑板和远程环境租约                      |

Project 是数据隔离和权限边界。所有 Project 级 API、SSE 和 workspace 文件操作都必须解析目标 Project；Solver 只获得单题 `ChallengeCapability`，不能获得完整的 `PlatformProject`。

## 2. 启动与请求流程

### 2.1 进程启动

`apps/backend/src/main.ts` 按以下顺序初始化：

1. 从 `--root/.ctf-agent` 打开 `FileSecretStore`、模型认证、模型池、Web Access、调度默认配置和 WebUI 鉴权。
2. 创建含内置 CTFd、DASCTF Pro、GZCTF 和 Ret2Shell 的 `PlatformPluginRegistry`，加载已安装扩展。
3. 创建 `FatherSessionManager` 和 `ControlPlane`。ControlPlane 从 `project-registry.json` 读取所有 Project。
4. 为每个 Project 创建 `Project` 和 `ContestScheduler`；归档 Project 走 `Project.openLocal()`，其他 Project 尝试连接平台。
5. `ControlPlane.start()` 完成后调用 `startWebUi()`。

`apps/backend/src/server.ts` 在监听 HTTP 端口前先进行一次真实快照刷新，然后启动定时刷新、调度器 reconcile 和 15 秒 SSE heartbeat。`--auto-start` 只会在模型可用且 Project 可调度时开启自动调度。

进程监听 `SIGINT`、`SIGTERM`、`SIGHUP`（Windows 另含 `SIGBREAK`）以及未捕获异常。所有退出来源共享一次关闭任务；WebUI、Father 和 ControlPlane 都会被调用并等待正常关闭，致命异常只在回收完成后退出。`SIGKILL`、宿主 OOM 等无法执行 JavaScript 的场景由下次启动时的 Docker 标签清理和远程租约 reconcile 兜底。

### 2.2 HTTP 与前端

`apps/backend/src/http/app.ts` 组装三类入口：

- 全局 `/api`：认证、Project 列表、全局模型/Father/Web Access、兼容的当前 Project 操作。
- Project 级 `/api/projects/:projectId/...`：Project 状态、队列、题目、Run、workspace 和 Project 模型绑定。
- 兼容路径 `/api/projects/:projectId/api/...`：与旧客户端保持同一套 scoped handler。

`authenticationGate` 保护 `/api/*`，健康检查 `/health` 不依赖前端。`apps/frontend/src/lib/api.ts` 的 `projectApi()` 对 Project ID 做 URL 编码，并把 `/api/...` 规范化为 Project 路径。`AppProvider` 先读取 `/api/auth`，登录后再读取 Project 列表。

后端路由按领域拆分，global/scoped 两种挂载形态复用同一业务实现：

| 路由模块        | 主要能力                                                                      |
| --------------- | ----------------------------------------------------------------------------- |
| `system.ts`     | `/health`、WebUI 登录、全局/Project 快照、刷新和 dashboard SSE                |
| `projects.ts`   | Project 列表、连接测试、创建、归档、删除、重置和 runtime 配置                 |
| `scheduler.ts`  | 手动/自动调度启停、双队列批量编排、并发修改和带版本检查的排序                 |
| `challenges.ts` | 题目派发/取消、人工消息、thinking level、TLDR、公告审核、workspace 和 Writeup |
| `runs.ts`       | Run/SubAgent 对话、SSE、steer、cancel、retry 和 HTML 导出                     |
| `models.ts`     | 全局模型池、Project 模型绑定、自定义 Provider、模型发现和 Provider 登录       |
| `father.ts`     | Father session、插件候选 workspace、Validation Gate 和激活                    |
| `web-access.ts` | Web Access allowlist、provider Secret 和 SSRF 配置                            |

前端路由定义在 `apps/frontend/src/main.tsx`：

| 路径                                           | 页面                  | 作用                                                    |
| ---------------------------------------------- | --------------------- | ------------------------------------------------------- |
| `/`、`/projects/new`                           | `ProjectsPage`        | Project 列表、创建、连接测试、归档和删除                |
| `/projects/:projectId`                         | `ProjectPage`         | 题目批量编排、双队列工作台、远程环境、Solver 日志与调度 |
| `/projects/:projectId/settings`                | `ProjectSettingsPage` | 平台和 Project runtime 配置                             |
| `/projects/:projectId/challenges/:challengeId` | `ChallengePage`       | 对话、情报、Attempts、workspace、Writeup 和 Agent 选择  |
| `/settings`                                    | `GlobalSettingsPage`  | WebUI 鉴权、Provider、模型认证、模型池和 Web Access     |
| `/father`、`/father/sessions/:sessionId`       | `FatherPage`          | Father 会话、插件工作区、验证和安装                     |

### 2.3 SSE

`apps/backend/src/http/sse/events.ts` 为每条连接发送：

1. `snapshot`：连接建立时的全局或 Project 快照。
2. `dashboard_status`：刷新成功、失败次数和最近错误。
3. 后续事件队列。

`SseHub` 为每个客户端维护串行队列，并按 `projectId` 过滤广播。`server.ts` 每 15 秒发送 heartbeat；Run、SubAgent 和 Father 会话使用独立的 session event stream。`apps/frontend/src/hooks/useConversation.ts` 先读取持久化会话，再合并 `agent_event` 增量，因此断线后不会把瞬时流当作唯一事实。

## 3. ControlPlane 与 Project 生命周期

### 3.1 ControlPlane 状态

`packages/core/src/control-plane/control-plane.ts` 定义全局阶段：

```text
unconfigured → disconnected → connecting → ready
                                      └──→ degraded
closing
```

每个 Project 有独立的 `ControlPlaneProjectSnapshot`，包括 `phase`、`lastError`、`archived`、创建时间和更新时间。

- `create()` 只读取注册表，不立即连接平台。
- `start()` 连接未归档 Project；归档 Project 使用 `openLocal()`。
- `connect()` 通过平台配置解析、凭据解析和 `Project.open()` 建立运行时。
- 连接或同步失败会进入 `degraded`，Scheduler 暂停领取新任务，但保留最后成功快照。
- `reportPlatformSuccess()` 恢复 `ready` 和 Scheduler。
- `archiveProject(true)` 立即暂停自动模式；活跃 Solver 不会被中断，全部结束后才释放平台连接并转为 local-only。
- `resetProject()` 断开并删除 RunStore 运行产物，再重新连接；`deleteProject()` 先断开、删除注册表条目和项目目录，并清理该 Project 的命名空间凭据。

### 3.2 Project.open 与 openLocal

`packages/core/src/project/project.ts` 是单 Project 的运行时装配器：

1. 解析 `ProjectConfig` 并选择 `PlatformPlugin`。
2. `open()` 调用 `plugin.connect()`；`openLocal()` 使用不可用平台实现，只打开本地数据。
3. 发现 Project skills 和 SubAgent role。
4. 打开 `<stateDirectory>/runs.sqlite`，把上一次进程遗留的 `preparing`/`running` Run 和非终态 SubAgent 标记为 interrupted，并按 Run 标签清理其遗留 Docker Sandbox。
5. 创建 `RemoteEnvironmentCoordinator` 并回收持久化的遗留远程租约。
6. 为后续 Run 保存平台快照、workspace、session、黑板、TLDR 和 Agent stream。

Project 对 Solver 暴露题目级能力：题目详情、附件下载、Flag 提交以及可选远程实例。平台总览、其他题目和远程环境列表留在 Project 内部，防止 Agent 跨题或跨 Project 操作。

远程实例的 Project 级配额、协议就绪、single-flight、到期广播、租约恢复与补偿清理见 [远程环境生命周期](remote-environments.md)。

## 4. Run、Solver 与调度

持久队列、Solver/Sandbox 硬上限、远程容量感知准入、失败分类和恢复规则详见
[调度与硬资源上限](scheduling.md)。

### 4.1 Run 创建和清理

`Project.createSolver()` 为每次尝试生成 Run ID、workspace 和 `runs/<runId>/session.jsonl`，并创建 `CtfSolverAgent`。Solver 使用 `BaseAgent` 打开 Pi 原生 JSONL session，加载系统提示词、skills、Pi tools、题目能力和可选 Web Access。

Solver 的关闭顺序在 `packages/agents/src/solver/agent/solver-agent.ts`：

1. 中止 Agent 并等待空闲。
2. 回收 SubAgent。
3. 销毁题目远程实例。
4. 关闭 Docker sandbox。
5. 通过 `onClosed` 写入 Run 终态、usage、错误和 cleanup 错误。

Flag 被平台接受后会记录 terminal submission。生产调度会进入 Writeup turn；Writeup 通过 `packages/core/src/orchestration/writeup-validator.ts` 检查格式和必要内容，只有校验成功才对外提供下载。

### 4.2 ContestRunner 与 ContestScheduler

两者职责不同：

| 组件               | 入口                   | 使用方式             | 行为                                                                              |
| ------------------ | ---------------------- | -------------------- | --------------------------------------------------------------------------------- |
| `ContestRunner`    | `contest-runner.ts`    | 一次性批量任务或测试 | 刷新并去重题目，按 worker pool 并发执行，统计结果，保证 finally 中关闭所有 Solver |
| `ContestScheduler` | `contest-scheduler.ts` | WebUI 长驻调度       | 维护空闲/执行双队列、手动/自动模式、blocked lane、重试、暂停恢复和并发变化        |

调度器的关键规则：

- WebUI 手动计划按 `赛题池 → idle → execution → active` 流转；`start()` 原子迁移全部 idle 项且不会隐式加入未选择题。
- `stopped | manual | automatic` 模式、两条队列及各自版本均持久化；暂停冻结并保留等待项，不自动取消活跃 Solver。
- 平台已解、RunStore 已解、人工 `excluded/solved` 的题目不会自动入队。
- 同一题在 idle/execution/active 阶段互斥；直接派发可以显式 `force` 绕过 solved 或 blocked 检查。
- `maxConcurrent` 是活跃 Solver/Sandbox 的硬上限；等待远程环境的 Run 仍占一个容器槽。
- 远程槽满时跳过无附件环境题，但允许纯本地题和有附件可本地分析的题越过它。
- 历史 Run 参与 attempt 预算；`interrupted` 和 `blocked` 不消耗普通重试预算。
- 网络/限流/服务端错误按可重试分类处理；Session 连续异常超过阈值后将题目设为 blocked。
- 平台暂不可用时停止领取，但不删除持久化队列和自动调度意图；恢复后继续 reconcile。
- 空闲整队排序使用 `idleVersion`，执行队列排序校验条目版本；冲突时拒绝陈旧拖拽请求，前端重新读取服务端快照。
- `AnnouncementPoller` 定期拉取公告；`announcement-matcher.ts` 按 ID、标题、内容和关键词生成题目候选，候选先由 WebUI 审核，之后才写入 Run 的上下文。

Scheduler 的内存队列负责当前进程执行，RunStore 的 `scheduler_queue.stage` 与 `scheduler_control` 保存跨重启的两阶段顺序、版本和运行模式；创建 Scheduler 后调用 `restore()`，发布快照前再把持久层版本回灌内存，避免 WebUI 使用过期版本。旧库没有 `stage` 的等待项迁移为 `execution`。暂停调度不会打断或删除已活跃 Solver；暂停后 WebUI 会提供“停止全部 Solver”，该操作等待每个 Solver 按正常关闭顺序回收 SubAgent、远程实例和 Docker Sandbox。

## 5. 持久化与恢复

### 5.1 目录结构

`ProjectConfigStore` 位于 `packages/core/src/control-plane/config-store.ts`：

```text
<root>/.ctf-agent/
├── project-registry.json
├── project-config.json / runtime-config.json / runs.sqlite  # 根 Project
├── runs/<run-id>/session.jsonl
├── challenges/<challenge-key>/
├── projects/<sha256(projectId)[0:32]>/                    # 其他 Project
│   ├── project-config.json
│   ├── runtime-config.json
│   ├── runs.sqlite
│   ├── runs/<run-id>/
│   └── challenges/
├── model-config.json / auth.json / web-access.json / built-in-plugins.json
├── scheduler-config.json / global-config.json / secrets.json
├── father/sessions/<session-id>/
└── extensions/<plugin-id>/revisions/<revision>/
```

`directory` 只接受 `.` 或 `projects/<32 位小写十六进制>`，由 Project ID 的 SHA-256 前缀派生。JSON 使用临时文件加 rename 写入，避免写入一半时留下有效但不完整的配置。

### 5.2 RunStore

`packages/core/src/persistence/run-store.ts` 使用 Node `sqlite` 的 `DatabaseSync`。主要表包括：

| 表                                                                            | 内容                                                   |
| ----------------------------------------------------------------------------- | ------------------------------------------------------ |
| `runs`、`run_events`                                                          | Run 基本信息、状态、退出原因、错误和顺序事件           |
| `run_subagents`                                                               | SubAgent role、状态、session、工具统计、usage 和结果   |
| `model_token_usage`                                                           | 按 provider/model 记录 Solver、SubAgent、TLDR 逐次用量 |
| `platform_view_cache`                                                         | overview、题目、公告、远程环境快照                     |
| `scheduler_queue`、`scheduler_control`、`challenge_scheduling_overrides`      | 双队列阶段/顺序/版本、调度模式和人工覆盖               |
| `challenge_runtime_state`、`challenge_block_events`                           | blocked 分数、阈值、复活次数和审计事件                 |
| `remote_environment_leases`                                                   | Project 内远程环境租约和优先级                         |
| `challenge_evidence`、`challenge_opportunities`                               | 黑板数据                                               |
| `challenge_tldr`                                                              | TLDR 内容、模型、session 和 token usage                |
| `contest_announcements`、`challenge_announcements`、`announcement_deliveries` | 公告去重、题目匹配、审核和投递状态                     |

`model_token_usage` 以 Pi 的 provider 报告为准，记录普通回复以及 compaction、branch summary 的输入、输出、缓存读取和缓存写入；首次升级时会从旧 `agent_usage`、SubAgent 与 TLDR 累计字段回填，无法恢复模型名的旧记录明确标为未归因。该账本由默认开启的内置 `token-usage` 插件维护，开关持久化在 `built-in-plugins.json`；关闭后保留已有数据和 Solver 运行事件，但不再写入新的插件账本记录，HTTP 接口与前端项目入口同时停用。

恢复时以持久化终态、事件和 session 为准，内存队列只是执行投影，浏览器临时状态不是恢复来源。SSE 断线后前端先拉取 snapshot，再继续订阅；Run 和 SubAgent 对话以 JSONL session 为准，SQLite 保存索引和运行摘要。

## 6. 模型、技能与 Web Access

### 6.1 模型池

`apps/backend/src/domain/model-pool.ts` 保存 version 3 模型配置。模型公开参数和 Provider 定义写入 `model-config.json`，API key 与 OAuth 凭据写入 SecretStore。完整 Pi Models registry 会传给 Agent，模型选择再按角色绑定：

| 角色     | 默认来源                                  | Project 覆盖                   |
| -------- | ----------------------------------------- | ------------------------------ |
| Solver   | 全局 `solverModelId`                      | 是，存于 `runtime-config.json` |
| TLDR     | Project TLDR 绑定，否则回退 Solver        | 是                             |
| SubAgent | 角色 frontmatter 或全局角色绑定           | 是                             |
| Father   | 全局 `fatherModelId`，未配置时回退 Solver | 否                             |

没有配置可用 Solver 模型时，后端会暂停自动调度并在快照中返回原因。自定义 Provider 的模型列表由后端用 SecretStore 请求，浏览器只接收模型 ID；请求失败时保留已有手工输入，不返回上游响应正文。

同一个后端进程创建的 Solver、SubAgent、TLDR、Father 和 Web Access 摘要模型共享按 Provider
划分的请求门。相同 Provider 的请求起点至少错开 2 秒；任一请求返回可重试的 429 或
5xx 后，该 Provider 的后续请求统一冷却 15 秒。不同 Provider 相互独立，等待期间的取消
不会触发上游调用。该背压补充而不替代 Scheduler 的 Run 级重试。

### 6.2 Agent session 与 compaction

`packages/agents/src/base-agent/` 将 Pi `AgentHarness`、原生 JSONL session、model、thinking level、tools 和 skills 组合成 `BaseAgent`。自动 compaction 默认开启，Solver 使用 `CTF_COMPACTION_PROMPT`，compaction 后由 Project 重新注入 challenge context、黑板、公告和活跃 SubAgent 快照。

### 6.3 Web Access

`packages/web-access` 是 fork 后的 Agent 工具库，不是 Pi TUI 扩展。`apps/backend/src/domain/web-access-config.ts` 管理 provider allowlist、`none/auto-summary` workflow、模型、超时和 SSRF 配置。

- provider 凭据只从宿主 SecretStore 解析。
- `web_search`、`fetch_content`、`source_check` 在 backend 宿主进程执行，不在 Solver 容器内执行。
- Solver 的 `networkMode` 不能限制 Web Access；需要依赖 SSRF guard 和 allowlist。
- GitHub clone、PDF 临时文件落在题目 workspace；缺少 `workspaceHostPath` 时这些能力关闭。
- GitHub 能力需要宿主 `git`；视频能力可选需要 `ffmpeg/ffprobe`。

## 7. Father 与扩展边界

Father 会话由 `packages/core/src/father/father-manager.ts` 管理，保留宿主 workspace 和 JSONL，但每个工作回合使用一个临时 Docker sandbox；回合结束后 sandbox 回收，下一次消息或验证反馈再创建新的 sandbox。

插件候选由 WebUI 和 `PlatformExtensionStore` 管理。候选代码在 Validation Gate 之前不会被主进程导入；Gate 在受限 Docker sandbox 中加载并运行。只有报告与候选 session、content hash、revision 和 setup fingerprint 匹配时，才能复制到 immutable revision 并注册到 `PlatformPluginRegistry`。具体 manifest 和检查项见 [平台插件文档](platform-plugins.md)。

## 8. 安全与资源约束

- `secrets.json`、模型认证和平台 Secret 不进入 Project 配置、Run 日志、黑板或浏览器响应。
- Docker sandbox 默认资源为 2 CPU、4 GiB 内存/交换、512 PIDs、20 GiB 可写层；Project 可配置 `privileged` 和 `networkMode`，因此部署者必须明确接受这些权限设置。
- Docker 命令直接调用 `docker`，不经过宿主 shell；stdout/stderr 单向各限制为 8 MiB。
- workspace 文件列表只包含普通文件且最多 2,000 项；下载和预览执行 containment 校验。文本预览要求白名单扩展名、有效 UTF-8，大小最多 256 KiB。
- `needsEnv` 未被平台提供时保持 `undefined`，提示层显示为 `unknown`，不会自行启动远程环境。
- 归档不打断活跃 Solver；它只停止新的自动调度，空闲后转为 local-only。

## 9. 变更导航

| 需求                      | 主要代码和测试                                                                                            |
| ------------------------- | --------------------------------------------------------------------------------------------------------- |
| 增加 HTTP 能力            | `apps/backend/src/http/routes/`、`schema.ts`、对应 `apps/backend/test/`                                   |
| 修改 Project/Run 生命周期 | `packages/core/src/project/`、`control-plane/`、`persistence/`；先读本文件和 `run-store.test.ts`          |
| 修改调度/重试             | `packages/core/src/orchestration/contest-scheduler.ts`、`contest-runner.ts`、`packages/core/test/runner/` |
| 修改 Agent 工具或提示词   | `packages/agents/src/`、`packages/prompts/src/` 和对应 Agent 测试                                         |
| 增加平台适配器            | `packages/platform/src/`，遵循 [平台插件文档](platform-plugins.md)                                        |
| 修改黑板                  | `run-store.ts`、`collaboration/blackboard.ts`、[黑板协议](blackboard-spec.md) 和黑板测试                  |
| 修改 WebUI                | `apps/frontend/src/pages/`、`hooks/`、`lib/api.ts` 和前端测试                                             |
| 修改 Docker 执行          | `packages/sandbox/src/`、`packages/sandbox/test/`；镜像入口为 `packages/sandbox/docker/Dockerfile`        |

测试命令、Docker 构建和运行前置条件见根目录 [README](../README.md)。
