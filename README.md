# CTF Agent

面向整场 CTF 的自主解题控制面。项目将比赛平台、调度器、Solver Agent、Docker 工具环境、运行历史与协作黑板组合成一个可恢复的系统，并通过 WebUI 完成所有业务配置。

目前内置：

- CTFd 插件：题目、附件、公告、Flag 提交；
- Flag 提交滑动窗口：每个 Solver Run 每分钟最多 5 次；
- GZCTF 插件：用户名密码或 `GZCTF_Token` Cookie 登录、比赛题目与实例管理；
- 公告关键字筛选与 WebUI 人工批准，只有获批公告进入 Solver 上下文；
- 并发调度：自动、人工、重试、取消、超时和 attempt 上限；
- 每题独立 Docker sandbox；
- 题目上下文结构化注入、附件自动下载；
- Pi 原生 JSONL session 保存、恢复、分支、compaction、结构化对话读取与 HTML 导出；
- 每个 Run 独立的 SubAgent fleet：专业角色、并发队列、完成后立即 steer 通知，以及可被父消息中断的结果等待和 steer/resume/cancel；
- SQLite RunStore、完整工具时间线和跨 attempt 黑板；
- 多 Project 控制面：每场比赛拥有独立调度器、数据库、workspace 与运行配置；
- 可选 WebUI 登录、全局 Provider/模型池配置，以及按 Project 隔离的平台凭据；
- React 路由式 WebUI、HTTP API 与按 Project 订阅的 SSE 实时更新。
- Solver 与 SubAgent 对话通过独立 SSE 实时显示模型文本、Markdown/代码高亮、ANSI 终端输出、工具状态、耗时与重试/上下文整理阶段；短工具结果自动展开，流式推理在下一条消息出现前保持展开，离开底部时可一键返回，SubAgent 工具与通知可跳转到对应 worker，完成消息仍以 Pi JSONL 为权威。
- shadcn/ui 源码组件、Tailwind CSS v4 与 Iconify 构成的可维护前端组件层。
- 题目工作区文件浏览与下载，可直接获取附件、脚本和分析产物。

## 使用 Docker Compose 启动

要求 Docker Engine、Docker Compose v2，以及至少约 10 GB 的可用磁盘空间。solver 镜像包含 Rizin、GDB、angr、Frida、QEMU、交叉编译器、多版本 JDK、ffuf、OneListForAll 字典和 hashcat，首次构建会比较久。

```bash
# 1. 构建 Solver 工具镜像
docker build -t ctf-agent-solver:latest packages/sandbox/docker

# 2. 构建并启动 WebUI
docker compose -f compose.webui.yaml up -d --build

# 3. 验证服务
curl http://127.0.0.1:3000/health
docker compose -f compose.webui.yaml ps
```

本机浏览器打开 <http://127.0.0.1:3000>；远端浏览器使用服务器可达 IP 或域名的 3000 端口。

服务启动时允许没有模型和比赛配置，此时控制面保持可恢复的 `unconfigured` 状态，不会退出。首次进入 WebUI 后按以下顺序操作：

1. 在“全局配置 → Provider”中按 Subscription 登录或 API Key 两类添加供应商，再在“模型池”加入可用模型；
2. 从首页创建比赛，通过可搜索的平台插件选择器填写插件声明的站点、比赛与认证信息；
3. 先测试连接，再输入比赛名称；浏览器会实时生成不可编辑的拼音 Project ID，确认后创建并连接；
4. 在该 Project 的“比赛配置”中分别绑定 Solver、TLDR、各类 SubAgent 模型并设置并发数；
5. 从 Project 首页拖动调度队列、人工派发单题，或开启自主调度整场比赛。

Project 列表展示平台、创建时间与“解出数 / 总题数”，归档状态保存在服务端注册表，因此会在不同浏览器间同步。没有活跃 Solver 且未开启自动调度时，后台快照与公告轮询不会访问比赛平台，仍可从页面手动刷新。归档会暂停该 Project 的自动调度，但不会打断正在运行的 Solver；最后一个活跃 Solver 结束后平台连接会自动释放，服务重启时也不会连接归档 Project。平台故障或归档时，WebUI 仍以只读本地 runtime 打开 SQLite、历史对话、Writeup 与 workspace，但禁止启动或重试 Solver。列表仍提供带二次确认的永久删除操作。删除前系统会停止该 Project 的调度器、Solver 与 SubAgent，然后清理其 Run、Pi 会话、题目 workspace、运行配置和命名空间凭据；其他 Project 与全局模型配置保持不变。

Compose 只使用 `CTF_AGENT_WEBUI_PORT`、`CTF_AGENT_CHALLENGE_TIMEOUT_MS` 和 `CTF_AGENT_MAX_SESSION_INTERRUPTIONS` 三个可选环境变量（默认分别为 `3000`、`1800000` 和 `3`）；不会从环境注入模型或平台凭据。其余业务配置都从 WebUI 写入具名卷 `ctf-agent-data`：

```text
.ctf-agent/
├── global-config.json    # 可选 WebUI 登录策略与 scrypt 密码摘要
├── project-registry.json # Project ID 到隔离状态目录的注册表
├── secrets.json          # 全局模型密钥和按 Project 命名空间隔离的平台凭据，权限 0600
├── auth.json             # 全局 Pi Provider OAuth / API Key 凭据，权限 0600
├── model-config.json     # 全局非敏感模型池参数
├── scheduler-config.json # 旧版并发量迁移回退
├── project-config.json   # 首个/旧版 Project 的平台与 sandbox 配置
├── runtime-config.json   # 首个/旧版 Project 的模型绑定、Solver 与远程环境并发量
├── runs.sqlite           # 首个/旧版 Project 的权威运行状态
├── runs/…、challenges/…  # 首个/旧版 Project 的 session 与 workspace
└── projects/<project-hash>/
    ├── project-config.json
    ├── runtime-config.json
    ├── runs.sqlite
    ├── runs/<run-id>/session.jsonl
    └── challenges/<safe-key>/workspace/
```

常用运维命令：

```bash
docker compose -f compose.webui.yaml logs -f webui
docker compose -f compose.webui.yaml restart webui
docker compose -f compose.webui.yaml down

# 查看持久卷；down 不会删除它
docker volume inspect ctf-agent-data
```

只有显式执行 `docker compose -f compose.webui.yaml down -v` 才会删除持久数据。

## WSL

项目可直接在 WSL 的 Docker Engine 中运行。PowerShell 示例：

```powershell
wsl -d kali-linux -- bash -lc `
  'cd /mnt/e/dev/my-projects/ctf-agent && docker build -t ctf-agent-solver:latest packages/sandbox/docker'

wsl -d kali-linux -- bash -lc `
  'cd /mnt/e/dev/my-projects/ctf-agent && docker compose -f compose.webui.yaml up -d --build'
```

WebUI 映射到宿主机 `0.0.0.0:3000`，可从外部网络访问；WSL2 端口转发和主机防火墙仍需允许相应流量。Codex 和 Claude OAuth 回调分别使用仅绑定本机的 `1455`、`53692` 端口。

## 模型认证

模型设置支持以下入口：

| Provider | 登录方式 | 持久化标识 |
|---|---|---|
| OpenAI Codex | 浏览器 OAuth、Device Code | `openai-codex` |
| Claude | 浏览器 OAuth / 手动回调、Claude Code OAuth Token、Anthropic API Key | `anthropic` |
| OpenAI API | Platform API Key | `openai` |
| 自定义兼容端点 | 自定义名称、OpenAI Completions / Responses 或 Anthropic Messages、Base URL、API Key | `custom-*` |

OAuth 和原生 Provider API Key 由 Pi 的 `CredentialStore` 写入具名卷中的 `.ctf-agent/auth.json`，刷新 token 时会原子更新；WebUI 状态接口只返回 Provider、凭据类型和模型清单，不返回凭据原文。

Provider 设置页以列表管理已连接供应商，可就地更新原生 Provider 凭据或自定义 Provider 的名称、API 类型、Base URL 与可选的新 API Key。新增供应商时先选择 Subscription 登录、API Key 或自定义 Provider，再展开对应表单；编辑自定义 Provider 不会改变其稳定 ID，留空 API Key 时保留已有密钥。

模型池编辑器会为已配置密钥的自定义 Provider 请求其 `Base URL + /models`（Anthropic 根地址使用 `/v1/models`）。接口返回 OpenAI 风格的 `data[].id` 或 `models[].id` 时，模型 ID 使用可搜索 Combobox；请求失败、超时、返回为空或格式不兼容时自动保留手工输入框。

`.ctf-agent/model-config.json` 使用 v3 全局模型池结构，只保存非敏感模型与自定义 Provider 元数据，不保存 Project 的最终角色绑定。自定义 Provider 统一保存 API 类型与 Base URL，其 API Key 按 Provider 写入全局 Secret Store；模型池条目只引用已连接 Provider，不再重复保存端点或凭据。每个 Project 的 `runtime-config.json` 分别选择 Solver、TLDR 和 SubAgent role 模型，并保存最大 Solver 并发量与最大远程环境数；未覆盖的 SubAgent 角色仍使用 frontmatter 的 `model`。所有可用模型会注册进同一个 Pi `Models` registry，因此角色绑定不受 Solver 当前模型限制。v2 模型池、旧版单模型配置、全局绑定与 `scheduler-config.json` 只作为自动迁移时的回退值。

远程环境由每个 Project 的租约协调器统一限流，默认最多同时开启 1 个。无附件且必须依赖远程服务的题目优先；带附件题会先在本地分析，只有 Solver 调用 `ctf_instance_start` 表示已准备好远程验证后才排队申请。等待发生在可取消的工具调用中，不需要模型轮询；无附件请求可以回收一个附件题验证租约，被回收 Solver 会收到旧 endpoint 已失效的通知。accepted 后环境会在 writeup 前立即释放，其他 Run 终态也会清理；SQLite 中的租约用于进程重启后回收本系统遗留实例。

WebUI 可直接上传 JSON，也可读取容器内的 `/auth.json`。解析器兼容 Pi 的 Provider-keyed `auth.json`、Codex CLI 的 `~/.codex/auth.json`、Claude Code 常见的 `.credentials.json` 字段，以及 `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` 等导出字段。例如可先把本机文件复制进当前容器，再在模型设置中点击“读取 /auth.json”：

```bash
docker cp "$HOME/.codex/auth.json" "$(docker compose -f compose.webui.yaml ps -q webui):/auth.json"
```

导入成功后凭据已复制到持久卷，临时 `/auth.json` 不再参与后续 token 刷新。

## 平台认证

| 平台 | 认证方式 | 说明 |
|---|---|---|
| CTFd | Access Token | 在 CTFd 用户设置中创建；demo 默认地址为 `https://demo.ctfd.io` |
| GZCTF | 用户名 + 密码 | WebUI 登录并保存返回的身份 Cookie |
| GZCTF | `GZCTF_Token` Cookie | 适合启用验证码的站点；先在浏览器登录，再复制 Cookie |

GZCTF 的玩家接口使用身份 Cookie，不是管理员 API Token。目标站 `https://gz.imxbt.cn/` 还需要填写正确的 Game ID。具体字段与能力边界见 [平台插件文档](docs/platform-plugins.md)。

## 架构与包边界

全局侧栏的 **Clanker Father** 提供平台适配插件工坊。新建操作无需填写表单，会直接进入随机命名的对话；Father 识别目标插件后自动更新会话名称，并在候选具备静态 setup 后请求测试连接信息。请求完成时 WebUI 会实时打开与比赛创建复用的配置 Dialog；配置 schema 不变时只需填写一次，密钥进入 Secret Store 且不会暴露给模型。Father workspace 可从会话页按目录浏览、预览并逐文件下载。未批准候选在短生命周期 Docker sandbox 中执行 Validation Gate，通过后仍需用户显式批准安装。Father 模型在全局模型池中独立绑定，不跟随 Project。详见 [平台插件文档](docs/platform-plugins.md)。

```text
packages/
├── agents/    BaseAgent、Pi session/skills、CtfSolverAgent/SubAgent、单题工具
├── platform/  平台契约，以及 CTFd/GZCTF 单文件插件
├── sandbox/   Docker 生命周期、Pi ExecutionEnv、RTK 与 solver 镜像
├── prompts/   Solver、SubAgent 与项目上下文的共享提示词
└── core/      Project、ControlPlane、调度器、SQLite、blackboard

apps/
├── backend/   Hono HTTP/SSE 服务（createWebUiApp/startWebUi）、聚合模型与鉴权
└── frontend/  React 客户端（Vite/esbuild 构建，产物 dist/ 由 backend 托管）
```

依赖方向保持为 `apps/backend → core → agents/platform/sandbox`；`apps/backend`、`core` 与 `agents` 共享依赖 `prompts`，而 `prompts` 只依赖 `platform` 的题目类型。`agents` 不依赖 Project 或 SQLite，因此后续可以在同一包中增加其他职能 Agent，并复用 BaseAgent 的 session、skills、模型和生命周期能力。

每个 Solver 只拿到当前题目的 `ChallengeCapability`，无法通过任意 `challengeId` 操作其他题。题目信息以结构化 XML 初始消息注入，附件在 Solver 启动时自动下载到 `/workspace/attachments`。`bash`、`read`、`write`、`edit` 和 `list` 可访问 sandbox 内任意路径（包括 `/tmp`），但不能访问宿主机文件；宿主机只持有控制面状态和 workspace 挂载。每个 Solver 容器默认限制为 2 CPU、4 GiB 内存（不额外使用 swap）和 512 个 PID，避免单题耗尽宿主机资源。

详细设计：

- [系统架构](docs/architecture.md)
- [Blackboard 规范](docs/blackboard-spec.md)
- [SubAgent 架构与自定义角色](docs/subagents.md)
- [平台插件说明](docs/platform-plugins.md)

## 本地开发

要求 Node.js 22.19+ 和 pnpm 11。

```bash
corepack enable
pnpm install
pnpm check
pnpm typecheck
pnpm test

# 本机启动；需要本机 Docker
pnpm webui --root . --host 0.0.0.0 --port 3000  # 等价于 pnpm build:webui && node --experimental-transform-types apps/backend/src/main.ts
```

WebUI 可执行入口还支持：

| 参数 | 默认值 | 含义 |
|---|---:|---|
| `--root` | 当前目录 | 项目根目录，状态写入其 `.ctf-agent` |
| `--host` | `0.0.0.0` | HTTP 监听地址 |
| `--port` | `3000` | HTTP 端口 |
| `--poll-interval-ms` | `1000` | SSE 快照轮询周期 |
| `--max-concurrent` | `8` | 最大并发 Solver 数 |
| `--max-attempts` | `2` | 每题调度 attempt 上限 |
| `--max-session-interruptions` | `3` | 未提交 Flag 的 Session 中断阈值；超过后 blocked |
| `--challenge-timeout-ms` | `1800000` | 单次挑战硬超时 |
| `--retry-delay-ms` | `2000` | 重试间隔 |
| `--workspace-volume` | 无 | 容器部署时供 Solver 挂载的 Docker volume |
| `--auth-file` | `/auth.json` | WebUI“读取 auth.json”使用的导入路径 |
| `--auto-start` | 关闭 | 已有完整配置时启动自主调度 |

一次 prompt 对应一个 Run 和一个全新 Pi session。若模型正常结束、输出被截断或 provider/WebSocket 异常时仍未提交 Flag，系统会关闭旧 Solver 与 SubAgent，统计一次中断并创建全新的 Run/session，以英文 continuation prompt 继续。中断次数超过阈值后题目进入 `blocked`，等待人工重启；`interrupted`/`blocked` 不消耗常规 attempt 预算。模型请求不发送 `max_tokens` / `max_completion_tokens`，上下文接近窗口时仍使用 Pi compaction 保留关键进度。当前固定 Solver/SubAgent/compaction 提示词已集中为版本化英文占位文案，最终策略正文仍等待人类审阅。

Solver 与 SubAgent 默认只加载项目根目录 `.pi/skills` 中的 skill；供开发 Agent 使用的 `.agents/skills` 不会进入解题环境。额外 Solver skill 必须由宿主通过 `skillPaths` 显式传入，并在每个 Run 创建时复制到容器可见的 `/workspace/.skills/`。

WebUI 也可以针对一个已经结束的 attempt 执行“重试此 Attempt”。该操作复用原 Run ID、attempt 编号、workspace 和 Pi JSONL session，不新增 attempt；提示词留空时使用 `INCOMPLETE_CONTINUATION_PROMPT`，也可以提供最长 32,000 字符的自定义继续提示词。

WebUI 使用浏览器路由：`/` 管理全部 Project，`/projects/new` 创建 Project，`/settings` 管理全局凭据、模型池与登录策略，`/projects/:id` 管理一场比赛，`/projects/:id/settings` 管理该比赛的连接与运行配置，`/projects/:id/challenges/:challengeId` 是以对话为核心的题目工作区。Solver 与 SubAgent 复用结构化 Pi session 对话布局；移动端通过底部 Drawer 查看题目状态和 Agents；黑板、Attempts 和 Writeup 分页显示，工具与推理块按需展开。用户可见时间统一转换为本地可读格式。

Project 首页的待执行队列限制高度并在溢出时内部滚动，待审核公告支持逐条或全部批准/拒绝。全部题目表可将单题设为“不调度”或“人工已解出”，状态保存在 Project SQLite；两者都会移出当前队列、停止活跃 Run，并阻止自动、人工和重试再次入队，恢复“自动判断”后才重新参与调度。比赛配置中的“重置所有 Solver”会先停止该 Project 的调度器、Solver 与 SubAgent，再清空 SQLite Run 状态、Pi 会话、黑板、公告审核、调度队列和题目 workspace；Project 注册信息、平台连接配置与凭据、模型绑定和并发量保持不变，随后重新连接该 Project。

题目页的“文件”Tab 以可折叠目录树列出题目 workspace 中的普通文件并提供下载，少于 8 个文件的目录默认展开。受支持的代码、纯文本和 Markdown 文件可在响应式弹窗中直接预览；代码按需使用有限语言集高亮，Markdown 复用安全渲染器，预览文件上限为 256 KiB。列表最多返回 2,000 项且不跟随 symlink，预览和下载路径同时经过相对路径与真实路径 containment 校验。桌面侧栏折叠偏好保存在浏览器本地，切换页面或刷新后保持不变。

题目页右侧状态栏跟随当前选中的 Solver/SubAgent 显示输入、缓存读写和实时缓存率。远程环境除状态外还显示可复制的完整 URL；长地址在侧栏内截断，不会撑破布局。平台未声明题目是否需要环境时显示“平台未提供”，与明确的“不需要”区分。Solver 与各 SubAgent 的对话浏览位置独立保留，来回切换后恢复原位置。

Solver 还拥有绑定当前题目的 `ctf_challenge_info` 与 `ctf_download_attachment`。当公告提示题面、环境说明或附件发生变化时，Solver 可重新读取详情，并按附件 ID 将最新文件原子替换到 `/workspace/attachments/`；这两个工具不能访问其他题目。

当前发行镜像启用 OpenAI-compatible、OpenAI Responses / Codex 与 Anthropic Messages；其他 Pi Provider 仍按需裁剪。原生 Provider 由 Pi 负责请求签名、OAuth 刷新和对应 stream 实现。

## 安全说明

- WebUI 不会在读取 API 中回传凭据明文；Provider 凭据使用 Pi `CredentialStore`，平台和通用端点密钥使用 `FileSecretStore`。
- WebUI 登录默认关闭，可在全局配置中启用；启用后 API、SSE 与 session 导出均要求 HttpOnly、SameSite=Strict 会话 Cookie。服务本身不终止 TLS，公网部署仍应放在 HTTPS 反向代理后并限制 Docker socket 暴露。
- WebUI 挂载 Docker socket，因此容器等价于拥有 Docker 主机的高权限控制能力，只应运行可信代码。
- 完整遥测会保存工具参数、输出和已提交 Flag，适合赛后复盘，但持久卷应按敏感数据管理。
- WebUI 仅从明确的 attempt 或 SubAgent 卡片导出对应 Pi JSONL 对话 HTML，不提供含义模糊的题目级导出；尚无 assistant 消息的会话不可导出。Solver 导出会附加 system prompt 与工具 schema；页面以内联 HTML 呈现，可能包含 Flag、题目数据和工具输出，同样应按敏感数据管理。
