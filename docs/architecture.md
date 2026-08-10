# 系统架构

CTF Agent 是一个以 WebUI 为控制面的 pnpm/TypeScript monorepo。它把比赛平台、Pi Agent、Docker 工具环境、调度器和持久化运行历史组合起来，面向整场比赛并发解题。

## 包边界

```text
packages/
├── platform/  ChallengeCapability 契约与 CTFd、GZCTF 插件
├── sandbox/   Docker 生命周期、DockerExecutionEnv、RTK 与 solver 镜像
├── prompts/   Solver、SubAgent 与项目上下文的共享提示词
├── agents/    BaseAgent、Solver/SubAgent、Pi session/skills 和容器工具
└── core/      Project、ControlPlane、调度器、RunStore、黑板与 SubAgent manager

apps/
├── backend/   进程入口、Hono HTTP/SSE API、模型配置与 WebUI 鉴权
└── frontend/  React 客户端（shadcn/ui 组件与 Tailwind CSS v4）
```

后台平台轮询只服务于活跃 Solver 或已开启的自动调度；空闲 Project 仍可由 WebUI 显式刷新。归档 Project 不参与进程启动时的平台连接。归档操作会暂停自动调度，但保留已经活跃的 Solver；最后一个活跃 Solver 结束后，控制面关闭在线 runtime 并打开不含 Scheduler 的只读本地 runtime。平台连接失败时也回退到该 runtime，使 SQLite、历史对话、Writeup 与 workspace 保持可读；启动或重试 Solver 必须要求在线且未归档。取消归档时重新建立在线 runtime。

主要依赖方向是 `apps/backend → core → agents/platform/sandbox`；`apps/backend`、`core` 与 `agents` 共享依赖 `prompts`，而 `prompts` 只依赖 `platform` 的题目类型。`agents` 可以依赖 `platform` 与 `sandbox`，但不能依赖 `core`、Project 或 SQLite。跨包公开 API 从各包的 `src/index.ts` 导出。

## 启动与配置

`apps/backend/src/main.ts` 是生产入口，`src/server.ts` 导出 `createWebUiApp()`（内存装配，供 `app.request()` 测试）与 `startWebUi()`（真实端口 + 轮询/心跳定时器）。它依次打开全局 Secret/Credential Store、全局模型池、可选登录配置和 ControlPlane，再为注册表中的每个 Project 创建独立 runtime，最后启动 HTTP/SSE 服务。业务配置保存在项目根目录下的 `.ctf-agent/`：

```text
.ctf-agent/
├── secrets.json
├── auth.json
├── model-config.json
├── scheduler-config.json     # legacy 迁移回退
├── global-config.json
├── project-registry.json
├── project-config.json       # 首个/legacy Project
├── runtime-config.json       # 首个/legacy Project
├── runs.sqlite、runs/、challenges/
└── projects/<project-hash>/
    ├── project-config.json
    ├── runtime-config.json
    ├── runs.sqlite
    ├── runs/<run-id>/
    │   ├── session.jsonl
    │   └── subagents/<subagent-id>/session.jsonl
    └── challenges/<safe-key>/workspace/
```

`.pi/ctf-config.json` 只作为旧配置的只读回退。`project-registry.json` 是 Project ID 到状态目录、创建时间与归档状态的权威映射；归档不停止运行时，只影响列表分组，并在不同客户端间保持一致。附加 Project 使用 Project ID 的稳定 SHA-256 前缀作为目录名，避免路径注入和重命名冲突。首个或升级自旧版本的 Project 继续使用 `.ctf-agent` 根目录，原有 `runs.sqlite`、session 和 workspace 无需搬迁；旧注册项缺少 `archived` 时按 `false` 读取。

平台配置只保存非敏感字段和 secret 名称。平台凭据虽然集中写入全局 `secrets.json`，键名会同时散列 Project ID 和插件 Secret 名，因此两个 CTFd/GZCTF Project 可以使用不同账号而不会覆盖。旧版 `CTFD_TOKEN`、`GZCTF_*` 等未命名空间键只作为兼容读取回退；新的保存永远写入 Project 命名空间。Provider OAuth/API Key 与模型池属于全局配置，不进入这个命名空间。

`model-config.json` 保存全局 v3 模型池与自定义 Provider 元数据，不保存密钥。自定义 Provider 负责 API 类型、Base URL 与共享凭据，支持 OpenAI Completions、OpenAI Responses 和 Anthropic Messages；API Key 按 Provider 隔离在 Secret Store，原生 Provider 继续使用 Pi CredentialStore。模型条目只引用已连接 Provider。每个 Project 的 `runtime-config.json` 保存 Solver、TLDR、SubAgent role 模型绑定、`maxConcurrent` 和 `maxRemoteEnvironments`。控制面为每次调度构造完整 Pi `Models` registry，再应用所属 Project 的绑定；未覆盖的角色仍使用 frontmatter 的 `model`。旧配置缺少远程环境配额时使用默认值 1；v2/旧版单模型文件、模型池内的角色绑定、`scheduler-config.json` 和遗留明文 Key 会作为迁移回退读取，新保存则遵循全局模型池/Project runtime 的边界。

自定义 Provider 更新保留稳定 Provider ID，避免破坏模型池引用；名称、API 类型和 Base URL 可独立修改，只有请求显式携带新 API Key 时才替换 Secret Store 中的现有密钥。

模型池页面通过后端按 Provider ID 探测自定义端点的模型列表。后端从 Secret Store 读取密钥，请求规范化后的 `/models`，只向浏览器返回去重后的模型 ID；密钥与上游错误正文不会回传。发现失败属于可恢复能力降级，前端回退到手工输入模型 ID。

ControlPlane 同时持有多个 `ManagedProjectRuntime`。每个 runtime 都有自己的 `Project`、`ContestScheduler`、`AnnouncementPoller` 和状态目录；一个 Project 连接降级、断开或关闭不会替换其他 runtime。WebUI 的 Project 路由使用 `/api/projects/:projectId/...`，SSE 客户端也绑定显式 Project ID，业务代码不得依赖 UI 当前选择项来定位 Run 或 Scheduler。

删除 Project 是显式且不可恢复的控制面操作：ControlPlane 先关闭该 Project 的公告轮询、Scheduler、Solver/SubAgent 与 RunStore，再从注册表移除它，清理隔离状态目录和命名空间平台凭据。旧版首 Project 只删除 `.ctf-agent` 下明确属于 Project 的 `project-config.json`、`runtime-config.json`、RunStore、session 与 challenge workspace，不删除全局登录、模型池、Provider 凭据、调度迁移配置或其他 Project。

重置 Project 的 Solver 状态同样通过控制面串行迁移执行：先完整断开该 Project，再只删除 `runs.sqlite*`、`runs/` 和 `challenges/`，保留 `project-config.json`、`runtime-config.json`、注册表与凭据，最后重新连接。因调度队列、公告审核、黑板和 Run 事件都以 SQLite 为权威来源，重连后的状态与新建 Project 首次连接一致。

## WebUI 页面与会话读取

前端使用 React Router 的独立页面和 Misuzu 风格的全局图标栏 + Project 上下文栏。根页面列出所有 Project；全局设置管理 Provider 凭据、模型池和可选登录；Project 首页管理完整题目列表与可拖动持久队列；Project 设置只管理比赛连接、角色绑定和并发量；每道题拥有独立聊天工作区。

通用 UI 采用 shadcn/ui 的源码托管结构：`apps/frontend/components.json` 是 CLI 配置，Radix/CVA 组件位于 `src/components/ui/`，组合型业务组件位于 `src/components/`，`src/lib/utils.ts` 提供 `cn()`。Tailwind CSS v4 在构建期把 `src/styles.css` 编译为 `dist/app.css`；后端通过 `WEBUI_FRONTEND_DIST` 环境变量定位构建产物（默认 `apps/frontend/dist`），缺失时回退到占位 HTML。图标继续统一通过 Iconify 渲染，不在业务组件中嵌入裸 SVG。

聊天接口直接读取 Pi JSONL 当前分支上的结构化消息，不从 SQLite 事件拼接 transcript。Solver attempt 与 SubAgent 使用同一个消息渲染器；工具、thinking 和元数据可以折叠，黑板、Attempts、Workspace 文件与 Writeup 放在独立 tab。文件视图以可折叠目录树呈现题目级 workspace，少于 8 个文件的目录默认展开；后端最多返回 2,000 个普通文件且不跟随 symlink，预览和下载请求同时校验规范化相对路径和真实路径 containment。代码、纯文本与 Markdown 预览使用服务端扩展名白名单，仅接受有效 UTF-8 且限制为 256 KiB；前端对选定语言使用轻量高亮，Markdown 复用禁用原始 HTML 的共享渲染器。只有至少存在一条 Assistant 消息时，结构化会话与 Pi HTML 导出才可查看。BrowserRouter 的非 API GET 路由由服务端回退到 `index.html`，刷新嵌套路由不会得到 404。桌面侧栏折叠状态仅作为浏览器本地界面偏好持久化，不进入 Project 配置。

WebUI 登录默认关闭。启用后 `global-config.json` 只保存 scrypt 参数、盐和摘要；成功登录签发内存 session，并使用 HttpOnly、SameSite=Strict Cookie。除静态 SPA、登录端点和最小健康状态外，API、SSE 与导出均经过同一鉴权门。

## 一次 Solver Run

`Project.createSolver()` 的主要流程：

1. 将题目 ID 绑定为单题 `ChallengeCapability` 并读取元数据；
2. 读取当前题目已有的共享黑板；黑板默认保持为空；
3. 创建或复用由题目 ID 稳定哈希得到的题目级 workspace，并创建 Docker sandbox；
4. 自动下载全部附件到容器的 `/workspace/attachments/<文件名>`；同题后续 attempt 会复用内容未变化的附件，内容变化时以同目录原子替换刷新，避免覆盖仍被旧进程执行的 inode 时触发 `ETXTBSY`；
5. 把题目信息与附件路径编码为 `<challenge_context>` 初始 user 消息；
6. 创建共享同一 sandbox 的 SubAgent manager；
7. 装配 Solver 的容器工具、平台工具、黑板工具与 SubAgent 工具；
8. 用 Pi 原生 append-only JSONL session 运行并持久化消息树。

远程实例不由各 Solver 直接竞争平台配额。Project 级 `RemoteEnvironmentCoordinator` 包装单题 `ChallengeCapability.instance`，以 SQLite `remote_environment_leases` 记录本控制面持有的租约，并串行化回收与启动。无附件远程题的申请属于 `required`；带附件题从 `local-first` 开始，Solver 只有在本地分析得到待验证结果并调用 `ctf_instance_start` 后才晋升为 `verification` 请求。请求按 required 优先、同级 FIFO 排队，工具调用可由 Solver abort；required 可以回收最早的 verification 租约，但 verification 不互相抢占。被回收的 Solver 会收到 `<environment_revoked>` steer，不能继续使用旧 endpoint。terminal submission 在 writeup turn 前释放租约，所有关闭路径再次幂等清理；Project 重连时只按持久化租约回收本系统遗留环境，不主动销毁未管理的队员实例。

首次 attempt 在 `run_creation` 阶段失败时按故障域处理：附件下载或写入失败允许重新创建一次 Run，其他装配错误立即把该 Run 与题目置为 blocked，等待人工介入。附件重试不计入实际开始解题的 Scheduler attempt 预算。

题目描述和黑板快照均按不可信数据处理，动态内容不会进入 system prompt。固定 Solver、SubAgent、continuation 和 CTF compaction 提示词使用版本化英文占位文案，并明确要求 Agent 使用英语 reasoning；题目原文、Flag、路径、命令和协议 payload 保留原文。最终 Solver 策略和角色正文仍由人类审阅替换。Solver 默认 `thinkingLevel=medium`，再使用 Pi 的 `clampThinkingLevel` 按模型能力映射。SubAgent 的 thinkingLevel 由角色 registry 自己决定。

每个 Solver Run 的 `ctf_submit_flag` 工具维护独立滑动窗口：任意连续 60 秒内最多发起 5 次平台提交，第 6 次在工具层拒绝且不会触达平台。新的 Run 会开始新的窗口。

容器文件工具不限制到 `/workspace`；`bash`、`read`、`write`、`edit` 和 `list` 可访问 sandbox 内任意绝对路径，包括 `/tmp`。这不会给予 Agent 宿主机文件访问权，宿主机只负责 Docker bind/volume 和控制面状态。`DockerSandbox` 为每个 Solver 容器默认传入 `--cpus=2`、4 GiB 的 `--memory/--memory-swap`、`--pids-limit=512`，并优先通过 `--storage-opt size=21474836480` 将容器可写层限制为 20 GiB；`DockerSandboxOptions.resources` 可由嵌入方收紧或覆盖这些限制。存储限制是否可用取决于 Docker storage driver；例如 `overlay2` 要求 XFS backing filesystem 启用 `pquota`。当 Docker 明确报告当前 driver 不支持 `--storage-opt` 时，Sandbox 会记录降级警告并只移除该参数重试创建，不能把这种宿主机兼容性问题误判为 Agent 连续中断。挂载到 `/workspace` 的 bind mount 或 volume 不属于容器可写层，需由宿主机或 volume driver 单独提供配额。

## Session 中断与阻塞

一次模型 prompt 对应一个 Solver Run 和一个 Pi session。只有成功提交 Flag 才算完成；模型正常停止、长度截断、provider/WebSocket 错误都记为一次 Session 中断。调度器关闭旧 Solver（同时停止其 SubAgent），创建全新的 Run/session，并使用固定提示词继续：

```text
The correct final flag has not been submitted. Continue solving the challenge.
```

中断计数按 challenge 持久化在 `challenge_runtime_state`。默认允许 3 次；当计数超过 `maxSessionInterruptions` 时，题目进入 `blocked`，不再自动调度，等待 WebUI 人工重启。人工强制派发会清除该题的中断计数和 blocked 状态。

Run 级人工重试与题目级重新派发是两个不同操作。重新派发创建新 Run/attempt；对 `failed`、`timed_out`、`cancelled`、`closed`、`interrupted` 或 `blocked` Run 执行重试时，Scheduler 重新创建 sandbox 并通过 `Project.resumeSolver()` 打开原 Pi JSONL，保留 Run ID、attempt、source 和 workspace。首轮默认使用 `INCOMPLETE_CONTINUATION_PROMPT`，WebUI 可覆盖为最长 32,000 字符的人工提示词；恢复后的 turn 仍经过正常的超时、compaction、blocked 和 Flag 提交监督。

`interrupted` 与 `blocked` Run 不消耗常规 `maxAttempts` 预算；超时、取消、准备失败等走各自终态和重试规则。

## SubAgent 协作

每个 Run 拥有独立 fleet，默认最多并发 4 个后台 worker。主 Solver 用 `Agent`、`get_subagent_result`、`steer_subagent`、`cancel_subagent` 和 `list_subagents` 管理 worker。worker 共享题目 sandbox，但默认 cwd 为 `/workspace/subagents/<id>`，有独立 Pi session，不能提交 Flag、管理远端实例或写黑板。

角色来自内置 registry，并可由 `.agents/agents/*.md` 和 `.pi/agents/*.md` 覆盖；后者同名优先。派发策略和 prompt 占位协议见 `packages/prompts/src/project.ts`。

## 持久化职责

- Pi JSONL：单个 Solver/SubAgent 的完整对话树、thinking、工具状态和 compaction；WebUI 对明确选择且已经产生 assistant 消息的 attempt/SubAgent session 读取当前分支的结构化消息，并可调用 Pi HTML 导出器，不提供题目级“最新 Run”推断，也不从 SQLite 事件重建 transcript。导出以 HTML 页面内联呈现、不强制下载。活跃 Solver Run 从内存 AgentState 读取 system prompt 与 tools metadata；关闭后从 Run 目录的 `session-export-metadata.json` 恢复同一信息；
- SQLite RunStore：Run 状态、事件时间线、SubAgent 摘要、调度状态、Session 中断计数和黑板；
- 题目级 workspace：附件、脚本、反编译结果、`writeup.md` 和其他跨复活保留的解题产物。

题目级目录使用 challenge ID 的 SHA-256 截断值作为 `safe-key`，不会把平台 ID 直接拼入宿主机路径。文件 API 可复用 `resolveWorkspaceArtifact()` 和 symlink containment 检查拒绝路径逃逸。`validateChallengeWriteup()` 已提供 UTF-8、大小和必需标题校验；accepted Flag 后的 `writing_writeup` turn 与延迟 sandbox 清理由后续 lifecycle supervisor 接管，在该接入完成前不得把 validator 的存在误认为交付生命周期已经切换。

不要把完整 transcript 复制到 SQLite，也不要从 `agents` 包反向读取 RunStore。涉及多个控制面事实的更新应继续使用 RunStore 事务，以免 WebUI、调度器和恢复逻辑看到中间状态。

RunStore 已具备 block v2 的持久化基础：`challenge_runtime_state` 保存 `block_score`、基础阈值、复活次数、blocked 来源和 lifecycle generation，`challenge_block_events` 以唯一 `event_key` 幂等记录每次计分及 compact 是否执行。首次生命周期的基础阈值默认为 10，有效阈值为 `base_block_threshold + revival_count * 4`，只有 `score > threshold` 才设置 blocked；升级旧数据库时仅把尚未 blocked 的默认阈值从 8 提升到 10，已经 blocked 的任务保留原判定阈值。数据库使用 partial unique index 保证同一道题最多存在一个 `preparing`、`running`、`blocking` 或 `writing_writeup` Run；打开遗留库时会保留最新 active Run，并把重复项审计为 interrupted。

在 Solver supervisor 接管 turn 生命周期前，现有 Session 中断路径仍会同步维护旧 `session_interruptions` 与 `block_score` 兼容值；新 supervisor 应只写 block event ledger，旧字段只保留审计和迁移用途。

ControlPlane 连接平台时先执行公告 baseline，再创建 Scheduler；baseline 失败只进入降级诊断，不阻塞解题。之后由不重叠的递归 timer 默认每 30 秒同步一次，失败指数退避，断开时停止。公告按平台 ID 与内容 revision hash 持久化；solve broadcast、新题上线和不含 hint/fix/update/attachment/environment/credential 等关键字的普通公告会被过滤。通过过滤且能确定匹配题目的公告先以 `pending` 候选显示在 WebUI，只有用户批准后才进入 `challenge_announcements` 上下文；拒绝项保持审计记录但不会发送。活跃 Solver 的获批公告 steer 先进入 `announcement_deliveries` outbox，按题目、公告 revision 和 Run 幂等排队，成功/失败/attempts 可恢复，失败 delivery 后续 poll 可重试。steer 只在消息队列尾部追加公告，不改写既有消息；支持前缀缓存的 Provider 通常仍可复用原有前缀，compact 才会重写会话上下文。

生产 Scheduler 在 accepted/already_solved 后进入 `writing_writeup`，保留同一 Solver/session 但将 active tools 限制为 `read/write/edit/list`。Solver 必须把英文可复现 writeup 写入题目 workspace，校验失败时最多继续专用 writeup turn，不增加 block score；通过校验后才以 solved 关闭并销毁 sandbox；校验失败会清除临时 terminal submission，再以 failed 关闭，不能被 close callback 自动改回 solved。测试调度器可显式关闭该流程以隔离生命周期测试。

题目级 TLDR 的 SQLite 记录独立于 Run，保存最新内容、模型、稳定 workspace 下的 `tldr/session.jsonl` 路径、更新时间和错误；更新采用题目主键 upsert，同一进程内同题的重叠刷新合并为一次生成，进程重启后以 SQLite 与该 JSONL 作为恢复依据。`CtfTldrAgent` 仅提供宿主机侧受 containment 校验的 `read/list`，不会创建 Docker sandbox；工具只列出普通文件、不暴露 TLDR 自身 session，并拒绝路径或 symlink 逃逸、非 UTF-8 文本和超过 64 KiB 的单文件。题目、黑板、公告和已有 TLDR 作为不可信数据注入。WebUI 详情可查看状态并触发 `/api/challenges/:id/tldr/refresh` 更新。

WebUI 的 Agent 缓存率统一计算为 `cacheRead / (input + cacheRead)`，`cacheWrite` 单独显示。Solver Run 从持久化 `agent_usage` 聚合；SubAgent 在 worker snapshot 中累计 input/cache read/cache write 并通过兼容迁移列持久化；题目页右侧状态栏按当前选中的 Solver 或 SubAgent 切换这些指标。TLDR 保存最近一次成功生成的 usage。没有可用 usage 或分母为 0 时显示无数据，不显示误导性的 0%。远程环境同时显示本地化状态和完整 endpoint；endpoint 在受限宽度内截断展示，但复制操作始终使用未截断原值。平台题目没有提供可选的 `needsEnv` 时必须保持未知态，不能强制映射为 `false`；UI 以“平台未提供”区别于显式“不需要”，Solver 上下文写入 `unknown`。GZCTF 可从题型可靠判断该能力，因此容器题和静态题分别显式映射为 `true` 与 `false`。

Solver 与 SubAgent 的聊天界面使用按 `Project ID + Run ID + SubAgent ID` 隔离的瞬时 SSE。Core 将 Pi 的 `message_*`、`tool_execution_*`、队列、compact 和 retry 事件归一化后旁路广播；浏览器把增量投影到当前对话，并在重新加载或断线恢复时用 Pi JSONL 结构化会话校准。Assistant 文本与推理复用安全的 GFM 渲染和 highlight.js 语言白名单，终端类工具额外安全解析 ANSI SGR 样式；短工具结果自动展开，流式推理在下一条时间线消息出现前保持展开。用户离开对话底部后显示居中的半透明返回按钮并累计新内容，默认只显示箭头，有新内容时显示数量徽标；浏览器按 Run 与 Agent 缓存滚动位置、底部状态和未读数，切换对话后恢复。`Agent`、`get_subagent_result`、`steer_subagent`、`cancel_subagent` 等工具调用及 `<subagent_notification>` 可直接跳转到对应 worker 对话。高频 token 不写入 SQLite，订阅者异常也不得影响 Agent 生命周期。Project 级 snapshot SSE 继续负责题目、调度器和侧栏等低频权威状态。

Solver 停止原因经过 `classifySolverStop` 归一化：`fetch failed`、非人工触发的 `Aborted`、网络断连、Provider 5xx/429 和显式 retryable 错误不增加 block score。每个 attempt 在同一 Solver/Pi session 内有三次 continuation 重试机会，默认分别等待 10 秒、60 秒和 300 秒，并为每次失败记录 `run_transient_failure`；三次机会耗尽后才结束该 attempt。认证/配置错误不重试。模型自然停止、长度耗尽、协议异常和 prompt timeout 在未超过阈值时记录幂等 block event，并在同一 Run/session 追加 continuation prompt；超过阈值才关闭为 blocked。取消、进程关闭和已提交结果不计入 block，等待退避期间也可立即取消或关闭调度器。

Scheduler 已关闭 Solver 的隐式 BaseAgent compaction，并在每个 turn 前读取 context pressure。compact 边界先以 `delta=2` 预判有效阈值：可 compact 时执行 CTF compact 并写入 `compact_performed=true`，会超阈值时跳过 compact 并直接进入 `blocking`。`CTF_COMPACTION_PROMPT` 只让摘要保留未被权威快照覆盖的 Solver 本地调查状态；该提示词由 `CtfSolverAgent` 传给 Pi `AgentHarness.compact()`。compact 成功后，控制面按题目信息、非空黑板、已批准公告、SubAgent snapshot 的顺序组成一个恢复块，并把它直接前置到实际触发模型的首个 post-compact user turn；不再逐条 append 成消息树上的兄弟叶子。各部分因此不在摘要中重复，compact 期间完成的 worker 结果也会进入该 turn。blocking 阶段先取消尚未启动的 queued SubAgent；running SubAgent 的当前 turn 会在保留已有回复后中止，并从同一 JSONL session 启动明确的 final-report turn，最长等待 30 秒。只有所有 worker 都进入终态且最新 snapshot 已生成后，主 Solver 才执行一次 `BLOCKED_FINALIZATION_PROMPT` final turn；SubAgent snapshot 同样直接前置到该 user turn。该收尾要求终止遗留进程、删除临时文件，并把所有保留文件的准确路径与用途记录为 Evidence。最终无论成功还是失败都关闭为 blocked，失败追加 `block_finalization_failed`。因 legacy interruption 上限而进入 blocking 时使用独立的 `forceChallengeBlocked` 生命周期更新，只改变 blocked 事实，不重复增加 block score；存在 ledger 的 Run 也不会再被 close callback 重复计分。事件 key 由 Run/session 事件序列稳定派生，崩溃重放不会重复计分。

调度等待队列持久化在 `scheduler_queue`，记录 normal/blocked lane、lane 内位置、人工跨 lane override 和乐观锁版本。自主调度优先填充 normal lane；普通题耗尽后，按 `blocked_at` 顺序加入 blocked revival。领取复活题时保留原 block score，`revival_count` 和 `lifecycle_generation` 各增加 1，因此有效阈值增加 4。人工重排使用版本检查，冲突时拒绝覆盖；数据库队列在进程关闭后保留，显式暂停自主调度或取消排队题目时才删除相应记录。生产默认 Solver 并发数为 8。
# Clanker Father 与运行时平台扩展

Clanker Father 是全局、独立于 Project/Solver 生命周期的多 Session Agent。Father Session 延迟创建 Docker sandbox，并且一个进程同时只保持一个活跃 Father sandbox；切换 Session 时关闭前一个容器，但保留 workspace 与 Pi JSONL。

WebUI 可中止正在运行的 Father；中止会 abort 当前 turn、等待 Agent 退出并关闭 sandbox，然后把 Session 标记为 `stopped`。Session 的 JSONL 与 workspace 保留，后续再次发送消息时按原 Session 重建 sandbox 并继续工作。

Father 对话通过 Pi SSE 展示运行、工具、队列和自动 compaction 状态；`father_request_test_access` 完成时前端重新读取 Session，并弹出由静态 setup 描述生成的 Gate Dialog。终止操作仅在实时事件表明 Agent 正忙时显示在输入框发送按钮左侧。会话页可打开完整 Father workspace 文件树，文件列表、预览和下载复用题目 workspace 的安全读取规则。

后端启动时必须从应用源码根目录发现内置 `extension-authoring` skill，缺失时拒绝启动 Father，不能静默降级。Session 激活前，控制面将 skill 的 `SKILL.md`、references 与 assets 完整复制到该 Session 的 `/workspace/.skills/`，Pi 提示词只暴露 sandbox 内可读路径。

Session 创建不接受插件字段，先生成随机名称。Father 使用 `father_identify_plugin` 写入正式插件身份，使用 `father_request_test_access` 请求或复用测试连接信息。配置表单静态读取 schema v2 `extension.json.setup`，不会为展示表单导入未批准代码；Validation Gate 在短生命周期 Docker sandbox 中执行。验证配置以 setup schema fingerprint 为版本键；验证完成后控制面把 `<plugin_validation_result>` 结构化消息送回原 Session。Father 模型属于全局模型池绑定，创建 Session 时把实际模型记录进 Session 元数据。

平台扩展通过 `PlatformPluginRegistry` 动态进入 ControlPlane。候选插件不会因生成或校验成功而自动生效：`PlatformExtensionStore` 只接受绑定内容哈希的非失败 Validation Report，并把可用于批准的报告持久化到 Father sandbox 不可写的控制面目录；重启后也能继续安装。升级前已经通过验证的 Session 可使用自身持久化的 Gate Report 完成首次安装并回填该可信副本。显式批准后，候选会复制为不可变 revision、记录作者 Session，再更新 active pointer。ControlPlane 每次解析平台时读取 registry，因此不重启即可让新 Project 使用已批准插件。
