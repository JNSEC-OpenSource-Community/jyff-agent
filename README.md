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
- Pi 原生 JSONL session 保存、恢复、分支、compaction 与 HTML 导出；
- 每个 Run 独立的 SubAgent fleet：专业角色、并发队列、后台通知与 steer/resume/cancel；
- SQLite RunStore、完整工具时间线和跨 attempt 黑板；
- React WebUI、HTTP API 与 SSE 实时更新。

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

1. 在“模型设置”中登录 Codex / Claude、填写 API Key、导入 `auth.json`，或配置 OpenAI-compatible 端点；
2. 在“比赛平台设置”中选择 CTFd 或 GZCTF，填写站点、比赛与认证信息；
3. 先“测试连接”，成功后再“保存并连接”；
4. 人工调度单题，或开启自主调度整场比赛。

Compose 只使用 `CTF_AGENT_WEBUI_PORT`、`CTF_AGENT_CHALLENGE_TIMEOUT_MS` 和 `CTF_AGENT_MAX_SESSION_INTERRUPTIONS` 三个可选环境变量（默认分别为 `3000`、`1800000` 和 `3`）；不会从环境注入模型或平台凭据。其余业务配置都从 WebUI 写入具名卷 `ctf-agent-data`：

```text
.ctf-agent/
├── secrets.json          # API Key、Token、密码或 Cookie，权限 0600
├── auth.json             # Pi Provider OAuth / API Key 凭据，权限 0600
├── model-config.json     # 非敏感模型参数
├── scheduler-config.json # 动态调度并发配置
├── project-config.json   # 平台、比赛和 sandbox 配置
├── runs.sqlite           # Run、事件、SubAgent、调度状态与黑板
├── runs/<run-id>/
│   ├── session.jsonl     # Pi 原生 session tree
│   └── subagents/<id>/
│       └── session.jsonl # 每个 worker 的独立可恢复会话
└── challenges/<safe-key>/
    └── workspace/        # 同题复活时复用的附件、脚本、Writeup 和 Solver 产物
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
| OpenAI-compatible | Provider、Base URL、Model ID、API Key | 旧版通用配置 |

OAuth 和原生 Provider API Key 由 Pi 的 `CredentialStore` 写入具名卷中的 `.ctf-agent/auth.json`，刷新 token 时会原子更新；WebUI 状态接口只返回 Provider、凭据类型和模型清单，不返回凭据原文。

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

```text
packages/
├── agents/    BaseAgent、Pi session/skills、CtfSolverAgent/SubAgent、单题工具
├── platform/  平台契约，以及 CTFd/GZCTF 单文件插件
├── sandbox/   Docker 生命周期、Pi ExecutionEnv、RTK 与 solver 镜像
├── prompts/   Solver、SubAgent 与项目上下文的共享提示词
├── core/      Project、ControlPlane、调度器、SQLite、blackboard
└── webui/     可执行控制面、HTTP/SSE、聚合模型与前端
```

依赖方向保持为 `webui → core → agents/platform/sandbox`；`webui`、`core` 与 `agents` 共享依赖 `prompts`，而 `prompts` 只依赖 `platform` 的题目类型。`agents` 不依赖 Project 或 SQLite，因此后续可以在同一包中增加其他职能 Agent，并复用 BaseAgent 的 session、skills、模型和生命周期能力。

每个 Solver 只拿到当前题目的 `ChallengeCapability`，无法通过任意 `challengeId` 操作其他题。题目信息以结构化 XML 初始消息注入，附件在 Solver 启动时自动下载到 `/workspace/attachments`。`bash`、`read`、`write`、`edit` 和 `list` 可访问 sandbox 内任意路径（包括 `/tmp`），但不能访问宿主机文件；宿主机只持有控制面状态和 workspace 挂载。

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
pnpm webui -- --root . --host 0.0.0.0 --port 3000
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

当前发行镜像启用 OpenAI-compatible、OpenAI Responses / Codex 与 Anthropic Messages；其他 Pi Provider 仍按需裁剪。原生 Provider 由 Pi 负责请求签名、OAuth 刷新和对应 stream 实现。

## 安全说明

- WebUI 不会在读取 API 中回传凭据明文；Provider 凭据使用 Pi `CredentialStore`，平台和通用端点密钥使用 `FileSecretStore`。
- HTTP 服务暂不内置用户认证。默认的 `0.0.0.0:3000` 会接受外部连接；公网部署应使用防火墙限制来源，或放在带 TLS 和认证的反向代理后。
- WebUI 挂载 Docker socket，因此容器等价于拥有 Docker 主机的高权限控制能力，只应运行可信代码。
- 完整遥测会保存工具参数、输出和已提交 Flag，适合赛后复盘，但持久卷应按敏感数据管理。
- WebUI 的 Pi HTML 会话导出保留原始 JSONL 内容，并附加 Agent 的 system prompt 与工具 schema；页面以 HTML 形式内联呈现，可能包含 Flag、题目数据和工具输出，同样应按敏感数据管理。
