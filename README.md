# CTF Solver Agent

这是一个以 `Project` 为基本单元的 CTF Solver 框架。它不提供 Pi CLI/TUI extension；调用方通过 SDK 创建并控制 Solver。

## 架构

- `Project`：连接平台、同步比赛概览/公告、管理全局远程环境、保存 Run 元数据。
- `PlatformPlugin`：纯业务平台适配器，不依赖 Pi。`PlatformProject` 是 Project 的完整控制面。
- `ChallengeCapability`：由平台为单题创建的最小能力面；没有 `challengeId` 参数，因此 Solver 无法越题操作。
- `CtfSolverAgent`：直接继承 `@earendil-works/pi-agent-core` 的 `Agent`，保留其原生 API。
- `DockerSandbox`：每个 Solver 一个容器。`bash`、`read`、`write`、`edit`、`list` 和 RTK 都在容器内执行；宿主机仅保留挂载的 workspace 与 Run 元数据。
- Skills：发现 `.pi/skills/` 与 `.agents/skills/` 中 Pi-compatible `SKILL.md`，复制到容器可见的 `/workspace/.skills/`，以 `<available_skills>` catalog 和 `load_skill` 工具按需提供。
- Compaction：自动在上下文接近 model window 时生成摘要；也可调用 `await solver.compact()` 手动压缩。

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

可在创建 Solver 时控制自动压缩：

```ts
const solver = await project.createSolver("warmup-flag", {
  agent: piAgentOptions,
  compaction: { reserveTokens: 8192, keepRecentTokens: 12000 },
  // 或 compaction: false
})
```
