# CTF Solver Agent

这是一个以 `Project` 为基本单元的 CTF Solver 框架。它不提供 Pi CLI/TUI extension；调用方通过 SDK 创建并控制 Solver。

---

## 快速开始

### 1. 配置 API 凭据

复制 `.env.example` 为 `.env` 并填入你的 API 信息：

```bash
cp .env.example .env
```

`.env` 文件格式（支持所有 OpenAI-compatible API）：

```ini
# DeepSeek
CTF_MODEL_API_KEY = "sk-your-deepseek-api-key"
CTF_MODEL_ID = "deepseek-chat"
CTF_MODEL_BASE_URL = "https://api.deepseek.com"
CTF_MODEL_PROVIDER = "deepseek"

# OpenRouter
# CTF_MODEL_API_KEY = "sk-or-v1-your-openrouter-key"
# CTF_MODEL_ID = "openai/gpt-4o"
```

可用的环境变量：

| 变量 | 必填 | 说明 |
|---|---|---|
| `CTF_MODEL_API_KEY` | 是 | API 密钥 |
| `CTF_MODEL_ID` | 是 | 模型 ID |
| `CTF_MODEL_PROVIDER` | 否 | Provider，默认 `"openrouter"` |
| `CTF_MODEL_BASE_URL` | 否 | API endpoint（DeepSeek 需设置） |
| `CTF_MODEL_CONTEXT_WINDOW` | 否 | 上下文窗口大小，默认 64000 |
| `CTF_MODEL_MAX_TOKENS` | 否 | 最大输出 tokens，默认 4096 |

同时兼容 `OPENROUTER_API_KEY` / `OPENROUTER_MODEL`（旧变量名）。

脚本和测试使用 `loadEnvFile()` 从 `.env` 加载，环境变量直接设置优先级更高。
`.env` 未配置时 E2E 测试自动标记为 skipped。即使已配置凭据，真实模型测试也只在显式设置
`CTF_RUN_MODEL_E2E=1` 时运行，避免普通 `pnpm test` 意外产生外部请求和费用。

### 2. 构建 Docker 沙箱（可选）

```bash
pnpm build:sandbox
```

### 3. 运行示例

```bash
# 标准解题流程
pnpm example:mock

# 黑板系统专项测试
pnpm example:blackboard

# 启动本地实时 WebUI（http://127.0.0.1:3000）
pnpm webui:mock
```

### 4. 用 Docker 启动 WebUI

```bash
docker compose -f compose.webui.yaml up --build
```

控制台默认仅发布到 `127.0.0.1:3000`。通过 `CTF_WEBUI_PORT=8080` 可修改宿主机端口。
Docker 模式使用命名卷 `ctf-agent-data` 保存 SQLite、附件和各次尝试的 workspace；
WebUI 容器与它启动的 Solver 容器共享该卷，因此容器重启后仍可查看历史状态。

默认 `CTF_SCHEDULER_AUTO_START=false`，打开页面后可人工调度单题，或显式点击“开启自主调度”。
要使用调度功能，需配置 `CTF_MODEL_API_KEY` 和 `CTF_MODEL_ID`；未配置时页面仍可只读查看历史。

> `compose.webui.yaml` 将 Docker socket 挂入 WebUI，以便它创建和销毁 Solver 容器。能够访问
> 该控制面的进程实际上拥有宿主机级 Docker 权限。请只在可信主机使用，不要向公网直接暴露端口，
> 生产环境应改用受限的容器执行服务或 socket proxy。

### 5. 常用命令

```bash
pnpm build:sandbox      # 构建 Docker 沙箱镜像（需要 Docker）
pnpm test               # 确定性测试；真实模型 E2E 默认 skipped
pnpm test:runner        # ContestRunner 并发测试
pnpm typecheck          # TypeScript 类型检查
pnpm example:mock       # 运行解题示例
pnpm example:blackboard # 运行黑板专项测试
pnpm webui:mock         # 启动实时控制台
```

---

## 架构

- `Project`：连接平台、同步比赛概览/公告、管理全局远程环境、保存 Run 元数据。
- `PlatformPlugin`：纯业务平台适配器，不依赖 Pi。`PlatformProject` 是 Project 的完整控制面。
- `ChallengeCapability`：由平台为单题创建的最小能力面；没有 `challengeId` 参数，因此 Solver 无法越题操作。
- `BaseAgent`：封装 Pi `AgentHarness`、原生 JSONL session tree、恢复、分支、compaction、skills 与公共生命周期。
- `CtfSolverAgent`：继承 `BaseAgent`，只增加单题 CTF capability、提交终态与资源回收。
- `RunStore`：SQLite/WAL 持久化每次题目尝试、状态转换、错误与清理结果；Project 重开时会把遗留活跃 Run 标为 `interrupted`。
- `ContestRunner`：一次性批量执行器，适合脚本和测试。
- `ContestScheduler`：长驻的混合调度器，负责自主队列、人工派发、同题去重、并发上限、调度 attempt 上限、硬超时、重试与取消。
- `WebUI`：Project 与 ContestScheduler 的实时控制面；聚合平台题目、队列、RunStore 事件、远程环境与黑板数据，通过 SSE 推送变化，并提供受控的调度 API。
- `DockerSandbox`：每个 Solver 一个容器。`bash`、`read`、`write`、`edit`、`list` 和 RTK 都在容器内执行；宿主机仅保留挂载的 workspace 与 Run 元数据。
- Sessions：每个 Run 在 `.ctf-agent/runs/<run-id>/session.jsonl` 保存 Pi 原生树；消息、模型、thinking level、active tools、compaction 与分支均可恢复。SQLite 不重复保存完整 transcript。
- Skills：`@ctf-agent/base-agent` 使用 Pi loader 发现 `.pi/skills/` 与 `.agents/skills/`，再复制到容器可见的 `/workspace/.skills/`；模型通过 Pi `read` 工具渐进加载正文。
- Compaction：使用 Pi session-tree 原生摘要节点；可调用 `await solver.compact()` 手动压缩。
- **Blackboard（黑板）**：跨 attempt 共享的 Evidence-Opportunity 知识图。Agent 通过 `ctf_blackboard_read` 和 `ctf_blackboard_record` 工具读写；每次 attempt 自动获得有界、JSON 编码且明确标记为不可信数据的既有知识快照。详见 [`docs/blackboard-spec.md`](docs/blackboard-spec.md)。
- 强制清理：Solver 无论成功、失败、超时或取消，都会先销毁当前题远程实例，再删除 Docker sandbox，最后持久化终态。

### 目录结构

```text
packages/base-agent/         # Pi harness、session、skills 与通用 Agent API
packages/platform/           # 平台 capability 契约
packages/platform-ctfd/      # CTFd access-token 适配器
packages/platform-gzctf/     # GZCTF 玩家 Cookie、判题与容器适配器
packages/sandbox/            # Docker sandbox 与 Pi ExecutionEnv
packages/solver/             # 仅 CTF SolverAgent 与题目工具
packages/project/            # Project、SQLite、blackboard、runner、scheduler

packages/webui/
├── src/
│   ├── client/              # 无框架响应式前端
│   ├── model.ts             # 平台、Run、黑板的聚合模型
│   └── server.ts            # HTTP API、静态资源与 SSE
├── test/                    # 聚合模型与 HTTP/SSE 测试
└── Dockerfile               # 控制面 WebUI 容器
```

平台接入采用“插件 + 插件自有配置”模式；项目配置不保存 token、密码或 Cookie。CTFd 与
GZCTF 的配置、认证方式和能力边界见 [`docs/platform-plugins.md`](docs/platform-plugins.md)。

---

## 实时 WebUI

控制台提供题目全文搜索、状态/分类/分值筛选和多种排序；题目详情显示当前进度、
每次 Agent 尝试的工具时间线、运行错误、远程环境及 Evidence-Opportunity 协作黑板。
页面带断线重连、平台手动刷新、公告、完成率、深链接和移动端布局。题目列表明确区分：

- `未调度`：尚未进入任何队列；
- `队列中`：已入队，等待可用并发槽位；
- `执行中`：Agent 正在准备或运行；
- `已解出`：平台或本地 RunStore 已确认完成。

自主调度暂停时，已经排入的自主任务会保留但不再派发；人工调度仍然可用。列表行和详情页均提供
“调度 / 重试 / 取消 / 重新验证”操作。已经解出的题目只允许显式重新验证，避免误耗模型额度。

顶部的模型设置面板可配置 Provider、Model ID、OpenAI-compatible Base URL、API Key、
Context Window 和 Max Tokens。保存后配置立即应用，无需重启 WebUI；API Key 明文不会通过
读取接口回传浏览器。示例控制面把配置以仅服务进程可读的权限保存到
`.ctf-agent/model-config.json`，该目录由 `ctf-agent-data` 数据卷持久化。清除 API Key 会同时
暂停自主调度，但不会中断已经运行的 Agent。

每次 Run 都记录来源：`auto`、`manual`、`retry`、`direct` 或 `test`。只有前三者消耗调度器的
重试预算，因此开发测试和旧的直接运行不会让题目莫名达到调度上限。历史中出现多次 attempt，
代表确实创建过多次独立 Solver；关闭原因 `submitted` 表示 Flag 已被平台接受，`manual`
表示旧调用方主动关闭，`cancelled` 表示由当前控制面取消。

WebUI 应嵌入持有 `Project` 的控制面进程，不应为每个 Solver 沙箱启动一份，也不要让
另一个进程再次对同一项目执行 `Project.open()`；后者会按恢复规则把遗留的活跃 Run
标记为 `interrupted`。`examples/mock-ctf/webui.ts` 是可运行的混合调度示例，正式控制面可直接：

```ts
import { ContestScheduler } from "@ctf-agent/project"
import { startWebUi } from "@ctf-agent/webui"

const scheduler = new ContestScheduler(project, {
  maxConcurrent: 4,
  maxAttempts: 2,
  createAgentOptions: ({ challenge, attempt }) =>
    createAgentOptions(challenge, attempt),
})

const webui = await startWebUi({
  project,
  scheduler,
  host: "127.0.0.1",
  port: 3000,
  pollIntervalMs: 1000,
})
```

`CTF_TELEMETRY_LEVEL=full` 会把完整工具参数、工具结果和提交的 Flag 保存到 RunStore，并在详情页
展示；凭据类字段仍会脱敏。该模式便于 CTF 复盘，但 SQLite 中会包含敏感比赛数据。
设置为 `safe` 可恢复命令/Flag 脱敏。修改只影响新事件，不会改写既有历史。

HTTP 服务默认只监听本机且当前不内置身份认证。需要跨主机访问时，应在反向代理层增加
TLS 与认证，不要直接把端口暴露到公网。

---

## 使用方式

### 单题解题

```ts
import { Project } from "@ctf-agent/project"
import { mockPlatform } from "@ctf-agent/platform-mock"

const project = await Project.open({
  root: "examples/mock-ctf",
  platforms: [mockPlatform],
})

const solver = await project.createSolver("warmup-flag", {
  agent: piAgentOptions,
})

try {
  await solver.prompt("分析当前题目、下载附件、找到并提交 Flag")
  await solver.waitForIdle()
} finally {
  // close 删除容器，但保留 .ctf-agent/runs/<run-id>/workspace 中的产物。
  await solver.close()
  await project.close()
}
```

`piAgentOptions` 是 Pi `Agent` 构造函数所需的原生 `AgentOptions`（包括模型 streamFn 等）。

平台实例工具会根据 `ChallengeCapability.instance` 动态注入。题目没有远程环境时，Solver 根本看不到 `ctf_instance_*` 工具。

### 批量并发

```ts
import { ContestRunner } from "@ctf-agent/project"

const runner = new ContestRunner(project, {
  maxConcurrent: 4,
  maxAttempts: 2,
  challengeTimeoutMs: 30 * 60_000,
  retryDelayMs: 2_000,
  createAgentOptions: ({ challenge, attempt }) => ({
    ...piAgentOptions,
    sessionId: `${challenge.id}-attempt-${attempt}`,
  }),
})

const summary = await runner.run()
console.log(summary)
```

调用 `await runner.stop()` 会停止派发、abort 活跃 Agent，并等待远程实例和 sandbox 清理结束。历史 attempt 由 `.ctf-agent/runs.sqlite` 记录，重新运行不会重置每题的重试预算。

可在创建 Solver 时控制自动压缩：

```ts
const solver = await project.createSolver("warmup-flag", {
  agent: piAgentOptions,
  compaction: true,
  // 或 compaction: false
})
```

---

## 黑板系统（Blackboard）

黑板是跨 attempt 的共享知识图，由 Evidence（证据）和 Opportunity（机会）两种节点组成。每次 attempt 的发现被持久化，新的 attempt 自动获得之前所有 attempt 积累的知识。

### 概念

| 概念 | 含义 | 生命周期 |
|---|---|---|
| **Evidence** | 已确认的客观发现 | 只增不改 |
| **Opportunity** | 从一个或多个 Evidence 出发的探索方向 | open → concluded |

每个 challenge 首次创建 Solver 时自动生成一条 origin Evidence，包含题目的结构化摘要（title/category/score/description/attachments）。之后的 Evidence 和 Opportunity 由 Agent 通过工具自行记录。

### Agent 工具

| 工具 | 说明 |
|---|---|
| `ctf_blackboard_read` | 读取当前题目的全部 Evidence 和 Opportunity（Markdown） |
| `ctf_blackboard_record` | 记录 Evidence / 声明 Opportunity / 结论 Opportunity |

### 安全快照注入

每次创建 Solver 时，system prompt 只加入固定的安全说明；动态黑板内容作为独立的初始 user
数据消息注入，不会被提升为系统指令。快照经过 JSON 编码并限制为 16000 字符：

```xml
<untrusted_challenge_blackboard encoding="json">
{"snapshot":"## Confirmed Evidence\n- [e1] \"Title: Warmup Flag...\""}
</untrusted_challenge_blackboard>
```

Evidence、Opportunity 描述最多 4000 字符，单个 Opportunity 最多关联 32 条 Evidence；
每道题最多保存 256 条 Evidence 和 256 条 Opportunity；`ctf_blackboard_read` 的文本结果
最多 64000 字符。

### 测试与文档

| 资源 | 说明 |
|---|---|
| `pnpm example:blackboard` | 黑板专项功能测试（6 步操作，含真实模型） |
| `pnpm test` | 包含 RunStore / 工具 / E2E 测试 |
| [`docs/blackboard-spec.md`](docs/blackboard-spec.md) | 完整设计规范 |
