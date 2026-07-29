# CTF Solver Agent

这是一个以 `Project` 为基本单元的 CTF Solver 框架。它不提供 Pi CLI/TUI extension；调用方通过 SDK 创建并控制 Solver。

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
- 强制清理：Solver 无论成功、失败、超时或取消，都会先销毁当前题远程实例，再删除 Docker sandbox，最后持久化终态。

### 目录结构

`@ctf-agent/solver` 使用 feature-first 布局；根 `src/index.ts` 是唯一公共导出入口，内部领域不通过包根互相引用：

```text
packages/solver/
├── docker/                  # Solver 镜像构建上下文
├── src/
│   ├── agent/               # Agent 生命周期与上下文压缩
│   ├── platform/            # 平台能力契约
│   ├── project/             # Project、配置与 RunStore
│   ├── runner/              # ContestRunner 调度
│   ├── sandbox/             # Docker、命令和文件工具
│   ├── skills/              # Skill 发现与物化
│   └── index.ts             # 稳定公共 API
└── test/                    # 与 src 领域结构镜像
```

## 使用方式

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

## 批量并发

`ContestRunner` 为每个 attempt 调用一次 `createAgentOptions`，因此模型实例、凭据、会话和预算都可以按题目独立配置：

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

常用工程命令：

```bash
pnpm build:sandbox
pnpm test
pnpm test:runner
pnpm typecheck
pnpm example:mock
```

可在创建 Solver 时控制自动压缩：

```ts
const solver = await project.createSolver("warmup-flag", {
  agent: piAgentOptions,
  compaction: { reserveTokens: 8192, keepRecentTokens: 12000 },
  // 或 compaction: false
})
```
