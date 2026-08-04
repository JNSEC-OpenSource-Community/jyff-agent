# CTF Solver Agent

这是一个以 `Project` 为基本单元的 CTF Solver 框架。它不提供 Pi CLI/TUI extension；调用方通过 SDK 创建并控制 Solver。

---

## 快速开始

### 1. 安装依赖

```bash
pnpm install
```

控制面进程应嵌入 `@ctf-agent/webui` 并持有唯一的 `ControlPlane`。启动后，
用户仅通过 WebUI 顶部的“模型设置”与“比赛平台设置”完成业务配置。

模型 API Key、CTFd Token、GZCTF 用户名/密码或 Cookie 只会写入
`.ctf-agent/secrets.json` Secret Store，不从环境变量回退读取，也不会通过读取接口回传浏览器。
非敏感的模型参数和平台参数分别保存到 `.ctf-agent/model-config.json` 与
`.ctf-agent/project-config.json`。

### 2. 构建 Docker 沙箱

```bash
pnpm build:sandbox
```

### 3. 常用命令

```bash
pnpm build:sandbox      # 构建 Docker 沙箱镜像（需要 Docker）
pnpm test               # 确定性测试；真实模型 E2E 默认 skipped
pnpm test:runner        # ContestRunner 并发测试
pnpm typecheck          # TypeScript 类型检查
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
- `ControlPlane`：持有可替换的 Project 与 ContestScheduler 生命周期；配置缺失或平台连接失败时进入可恢复状态，而不是终止 WebUI。
- `WebUI`：ControlPlane 的实时界面；配置平台插件、聚合题目/队列/RunStore/远程环境与黑板，通过 SSE 推送变化，并提供受控的调度 API。
- `DockerSandbox`：每个 Solver 一个容器。`bash`、`read`、`write`、`edit`、`list` 和 RTK 都在容器内执行；宿主机仅保留挂载的 workspace 与 Run 元数据。
- Sessions：每个 Run 在 `.ctf-agent/runs/<run-id>/session.jsonl` 保存 Pi 原生树；消息、模型、thinking level、active tools、compaction 与分支均可恢复。SQLite 不重复保存完整 transcript。
- Skills：`@ctf-agent/agents` 的 BaseAgent 使用 Pi loader 发现 `.pi/skills/` 与 `.agents/skills/`，再复制到容器可见的 `/workspace/.skills/`；模型通过 Pi `read` 工具渐进加载正文。
- Compaction：使用 Pi session-tree 原生摘要节点；可调用 `await solver.compact()` 手动压缩。
- **Blackboard（黑板）**：跨 attempt 共享的 Evidence-Opportunity 知识图。Agent 通过 `ctf_blackboard_read` 和 `ctf_blackboard_record` 工具读写；每次 attempt 自动获得有界、JSON 编码且明确标记为不可信数据的既有知识快照。详见 [`docs/blackboard-spec.md`](docs/blackboard-spec.md)。
- 强制清理：Solver 无论成功、失败、超时或取消，都会先销毁当前题远程实例，再删除 Docker sandbox，最后持久化终态。

### 目录结构

```text
packages/agents/             # BaseAgent、Pi session/skills、CtfSolverAgent 与题目工具
packages/platform/           # 平台契约及 CTFd/GZCTF 插件
packages/sandbox/            # Docker sandbox 与 Pi ExecutionEnv
packages/core/               # 控制面、Project、SQLite、blackboard、runner、scheduler

packages/webui/
├── src/
│   ├── client/              # 无框架响应式前端
│   ├── model.ts             # 平台、Run、黑板的聚合模型
│   └── server.ts            # HTTP API、静态资源与 SSE
└── test/                    # 聚合模型与 HTTP/SSE 测试
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
读取接口回传浏览器。`createFileModelConfiguration()` 把 API Key 保存到
`.ctf-agent/secrets.json`，其余模型参数保存到 `.ctf-agent/model-config.json`。清除 API Key 会同时
暂停自主调度，但不会中断已经运行的 Agent。

顶部的比赛平台设置面板由插件描述动态生成。CTFd 使用 Access Token；GZCTF 支持用户名密码
或浏览器 Cookie。测试连接不会改动当前运行时，只有“保存并连接”成功后才替换 Project 与调度器；
认证或网络失败会保留在可重试的 `degraded` 状态，HTTP 服务和历史数据页面不会因此退出。

每次 Run 都记录来源：`auto`、`manual`、`retry`、`direct` 或 `test`。只有前三者消耗调度器的
重试预算，因此开发测试和旧的直接运行不会让题目莫名达到调度上限。历史中出现多次 attempt，
代表确实创建过多次独立 Solver；关闭原因 `submitted` 表示 Flag 已被平台接受，`manual`
表示旧调用方主动关闭，`cancelled` 表示由当前控制面取消。

WebUI 应嵌入持有 `ControlPlane` 的进程，不应为每个 Solver 沙箱启动一份，也不要让另一个
进程再次打开同一项目；后者会按恢复规则把遗留的活跃 Run 标记为 `interrupted`。
正式控制面应向模型配置和 `ControlPlane` 传入同一个 Secret Store：

```ts
import { join } from "node:path"
import { ContestScheduler, ControlPlane, FileSecretStore } from "@ctf-agent/core"
import { ctfdPlatform, gzctfPlatform } from "@ctf-agent/platform"
import { createFileModelConfiguration, startWebUi } from "@ctf-agent/webui"

const secretStore = await FileSecretStore.open(
  join(projectRoot, ".ctf-agent", "secrets.json"),
)
const modelConfiguration = await createFileModelConfiguration({
  storagePath: join(projectRoot, ".ctf-agent", "model-config.json"),
  secretStore,
})

const controlPlane = await ControlPlane.create({
  root: projectRoot,
  platforms: [ctfdPlatform, gzctfPlatform],
  secretStore,
  createScheduler: project => new ContestScheduler(project, {
    maxConcurrent: 4,
    maxAttempts: 2,
    createAgentOptions: ({ challenge, attempt }) =>
      createAgentOptions(challenge, attempt),
  }),
})
await controlPlane.start()

const webui = await startWebUi({
  controlPlane,
  modelConfiguration,
  host: "127.0.0.1",
  port: 3000,
  pollIntervalMs: 1000,
})
```

控制面可把完整工具参数、工具结果和提交的 Flag 保存到 RunStore，并在详情页
展示；凭据类字段仍会脱敏。该模式便于 CTF 复盘，但 SQLite 中会包含敏感比赛数据。

HTTP 服务默认只监听本机且当前不内置身份认证。需要跨主机访问时，应在反向代理层增加
TLS 与认证，不要直接把端口暴露到公网。

---

## 使用方式

### 单题解题

```ts
import { join } from "node:path"
import { FileSecretStore, Project } from "@ctf-agent/core"
import { ctfdPlatform, gzctfPlatform } from "@ctf-agent/platform"

const projectRoot = "/path/to/project"
const secretStore = await FileSecretStore.open(
  join(projectRoot, ".ctf-agent", "secrets.json"),
)
const project = await Project.open({
  root: projectRoot,
  platforms: [ctfdPlatform, gzctfPlatform],
  resolveSecret: name => secretStore.get(name),
})

const solver = await project.createSolver("challenge-id", {
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
import { ContestRunner } from "@ctf-agent/core"

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
| `pnpm test` | 包含 RunStore / 工具 / E2E 测试 |
| [`docs/blackboard-spec.md`](docs/blackboard-spec.md) | 完整设计规范 |
