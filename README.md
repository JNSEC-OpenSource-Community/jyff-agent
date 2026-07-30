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
`.env` 未配置时 E2E 测试自动跳过。

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
```

### 4. 常用命令

```bash
pnpm build:sandbox      # 构建 Docker 沙箱镜像（需要 Docker）
pnpm test               # 全部测试（含 E2E，需要 .env）
pnpm test:runner        # ContestRunner 并发测试
pnpm typecheck          # TypeScript 类型检查
pnpm example:mock       # 运行解题示例
pnpm example:blackboard # 运行黑板专项测试
```

---

## 架构

- `Project`：连接平台、同步比赛概览/公告、管理全局远程环境、保存 Run 元数据。
- `PlatformPlugin`：纯业务平台适配器，不依赖 Pi。`PlatformProject` 是 Project 的完整控制面。
- `ChallengeCapability`：由平台为单题创建的最小能力面；没有 `challengeId` 参数，因此 Solver 无法越题操作。
- `CtfSolverAgent`：直接继承 `@earendil-works/pi-agent-core` 的 `Agent`，保留其原生 API。
- `RunStore`：SQLite/WAL 持久化每次题目尝试、状态转换、错误与清理结果；Project 重开时会把遗留活跃 Run 标为 `interrupted`。
- `ContestRunner`：比赛级 worker pool，负责未解题筛选、同题去重、并发上限、总 attempt 上限、硬超时、重试与取消。
- `DockerSandbox`：每个 Solver 一个容器。`bash`、`read`、`write`、`edit`、`list` 和 RTK 都在容器内执行；宿主机仅保留挂载的 workspace 与 Run 元数据。
- Skills：发现 `.pi/skills/` 与 `.agents/skills/` 中 Pi-compatible `SKILL.md`，复制到容器可见的 `/workspace/.skills/`，以 `<available_skills>` catalog 和 `load_skill` 工具按需提供。
- Compaction：自动在上下文接近 model window 时生成摘要；也可调用 `await solver.compact()` 手动压缩。
- **Blackboard（黑板）**：跨 attempt 共享的 Evidence-Opportunity 知识图。Agent 通过 `ctf_blackboard_read` 和 `ctf_blackboard_record` 工具读写；每次 attempt 自动将既有知识注入 systemPrompt。详见 [`docs/blackboard-spec.md`](docs/blackboard-spec.md)。
- 强制清理：Solver 无论成功、失败、超时或取消，都会先销毁当前题远程实例，再删除 Docker sandbox，最后持久化终态。

### 目录结构

```text
packages/solver/
├── docker/                  # Solver 镜像构建上下文
├── src/
│   ├── agent/               # Agent 生命周期与上下文压缩
│   ├── blackboard/          # 黑板系统（跨 attempt 知识共享）
│   ├── platform/            # 平台能力契约
│   ├── project/             # Project、配置与 RunStore
│   ├── runner/              # ContestRunner 调度
│   ├── sandbox/             # Docker、命令和文件工具
│   ├── skills/              # Skill 发现与物化
│   └── index.ts             # 稳定公共 API
└── test/                    # 与 src 领域结构镜像
```

---

## 使用方式

### 单题解题

```ts
import { Project } from "@ctf-agent/solver"
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
import { ContestRunner } from "@ctf-agent/solver"

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
  compaction: { reserveTokens: 8192, keepRecentTokens: 12000 },
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

### 自动注入

每次创建 Solver 时，黑板内容自动注入到 systemPrompt 末尾：

```xml
<challenge_blackboard>
## Confirmed Evidence
- [e1] Title: Warmup Flag / Category: misc / Score: 100
...

## Open Opportunities
- [o1] from e2: 尝试分析附件中的编码
</challenge_blackboard>
```

### 测试与文档

| 资源 | 说明 |
|---|---|
| `pnpm example:blackboard` | 黑板专项功能测试（6 步操作，含真实模型） |
| `pnpm test` | 包含 RunStore / 工具 / E2E 测试 |
| [`docs/blackboard-spec.md`](docs/blackboard-spec.md) | 完整设计规范 |
