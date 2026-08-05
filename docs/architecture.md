# 系统架构

CTF Agent 是一个以 WebUI 为控制面的 pnpm/TypeScript monorepo。它把比赛平台、Pi Agent、Docker 工具环境、调度器和持久化运行历史组合起来，面向整场比赛并发解题。

## 包边界

```text
packages/
├── platform/  ChallengeCapability 契约与 CTFd、GZCTF 插件
├── sandbox/   Docker 生命周期、DockerExecutionEnv、RTK 与 solver 镜像
├── agents/    BaseAgent、Solver/SubAgent、Pi session/skills 和容器工具
├── core/      Project、ControlPlane、调度器、RunStore、黑板与 SubAgent manager
└── webui/     进程入口、HTTP/SSE API、模型配置和 React 客户端
```

主要依赖方向是 `webui → core → agents/platform/sandbox`；`agents` 可以依赖 `platform` 与 `sandbox`，但不能依赖 `core`、Project 或 SQLite。跨包公开 API 从各包的 `src/index.ts` 导出。

## 启动与配置

`packages/webui/src/main.ts` 是生产入口。它依次打开 Secret Store、模型配置、调度配置和 ControlPlane，再启动 HTTP/SSE 服务。业务配置保存在项目根目录下的 `.ctf-agent/`：

```text
.ctf-agent/
├── secrets.json
├── auth.json
├── model-config.json
├── scheduler-config.json
├── project-config.json
├── runs.sqlite
├── runs/<run-id>/
│   ├── session.jsonl
│   └── subagents/<subagent-id>/session.jsonl
└── challenges/<safe-key>/
    └── workspace/
```

`.pi/ctf-config.json` 只作为旧配置的只读回退。平台配置只保存非敏感字段和 secret 名称，凭据由 Secret Store 单独保存。

## 一次 Solver Run

`Project.createSolver()` 的主要流程：

1. 将题目 ID 绑定为单题 `ChallengeCapability` 并读取元数据；
2. 为当前题目创建或复用黑板 origin；
3. 创建或复用由题目 ID 稳定哈希得到的题目级 workspace，并创建 Docker sandbox；
4. 自动下载全部附件到容器的 `/workspace/attachments/<文件名>`；
5. 把题目信息与附件路径编码为 `<challenge_context>` 初始 user 消息；
6. 创建共享同一 sandbox 的 SubAgent manager；
7. 装配 Solver 的容器工具、平台工具、黑板工具与 SubAgent 工具；
8. 用 Pi 原生 append-only JSONL session 运行并持久化消息树。

题目描述和黑板快照均按不可信数据处理，动态内容不会进入 system prompt。固定 Solver、SubAgent、continuation 和 CTF compaction 提示词使用版本化英文占位文案，并明确要求 Agent 使用英语 reasoning；题目原文、Flag、路径、命令和协议 payload 保留原文。最终 Solver 策略和角色正文仍由人类审阅替换。Solver 默认 `thinkingLevel=medium`，再使用 Pi 的 `clampThinkingLevel` 按模型能力映射。SubAgent 的 thinkingLevel 由角色 registry 自己决定。

容器文件工具不限制到 `/workspace`；`bash`、`read`、`write`、`edit` 和 `list` 可访问 sandbox 内任意绝对路径，包括 `/tmp`。这不会给予 Agent 宿主机文件访问权，宿主机只负责 Docker bind/volume 和控制面状态。

## Session 中断与阻塞

一次模型 prompt 对应一个 Solver Run 和一个 Pi session。只有成功提交 Flag 才算完成；模型正常停止、长度截断、provider/WebSocket 错误都记为一次 Session 中断。调度器关闭旧 Solver（同时停止其 SubAgent），创建全新的 Run/session，并使用固定提示词继续：

```text
The correct final flag has not been submitted. Continue solving the challenge.
```

中断计数按 challenge 持久化在 `challenge_runtime_state`。默认允许 3 次；当计数超过 `maxSessionInterruptions` 时，题目进入 `blocked`，不再自动调度，等待 WebUI 人工重启。人工强制派发会清除该题的中断计数和 blocked 状态。

`interrupted` 与 `blocked` Run 不消耗常规 `maxAttempts` 预算；超时、取消、准备失败等走各自终态和重试规则。

## SubAgent 协作

每个 Run 拥有独立 fleet，默认最多并发 4 个后台 worker。主 Solver 用 `Agent`、`get_subagent_result`、`steer_subagent`、`cancel_subagent` 和 `list_subagents` 管理 worker。worker 共享题目 sandbox，但默认 cwd 为 `/workspace/subagents/<id>`，有独立 Pi session，不能提交 Flag、管理远端实例或写黑板。

角色来自内置 registry，并可由 `.agents/agents/*.md` 和 `.pi/agents/*.md` 覆盖；后者同名优先。派发策略和 prompt 占位协议见 `packages/core/prompts/project.ts`。

## 持久化职责

- Pi JSONL：单个 Solver/SubAgent 的完整对话树、thinking、工具状态和 compaction；
- SQLite RunStore：Run 状态、事件时间线、SubAgent 摘要、调度状态、Session 中断计数和黑板；
- 题目级 workspace：附件、脚本、反编译结果、`writeup.md` 和其他跨复活保留的解题产物。

题目级目录使用 challenge ID 的 SHA-256 截断值作为 `safe-key`，不会把平台 ID 直接拼入宿主机路径。文件 API 可复用 `resolveWorkspaceArtifact()` 和 symlink containment 检查拒绝路径逃逸。`validateChallengeWriteup()` 已提供 UTF-8、大小和必需标题校验；accepted Flag 后的 `writing_writeup` turn 与延迟 sandbox 清理由后续 lifecycle supervisor 接管，在该接入完成前不得把 validator 的存在误认为交付生命周期已经切换。

不要把完整 transcript 复制到 SQLite，也不要从 `agents` 包反向读取 RunStore。涉及多个控制面事实的更新应继续使用 RunStore 事务，以免 WebUI、调度器和恢复逻辑看到中间状态。

RunStore 已具备 block v2 的持久化基础：`challenge_runtime_state` 保存 `block_score`、基础阈值、复活次数、blocked 来源和 lifecycle generation，`challenge_block_events` 以唯一 `event_key` 幂等记录每次计分及 compact 是否执行。有效阈值为 `base_block_threshold + revival_count * 4`，只有 `score > threshold` 才设置 blocked。数据库使用 partial unique index 保证同一道题最多存在一个 `preparing`、`running`、`blocking` 或 `writing_writeup` Run；打开遗留库时会保留最新 active Run，并把重复项审计为 interrupted。

在 Solver supervisor 接管 turn 生命周期前，现有 Session 中断路径仍会同步维护旧 `session_interruptions` 与 `block_score` 兼容值；新 supervisor 应只写 block event ledger，旧字段只保留审计和迁移用途。

ControlPlane 连接平台时先执行公告 baseline，再创建 Scheduler；baseline 失败只进入降级诊断，不阻塞解题。之后由不重叠的递归 timer 默认每 30 秒同步一次，失败指数退避，断开时停止。公告按平台 ID 与内容 revision hash 持久化，solve broadcast 会被过滤，其余公告经确定性标题/ID 匹配关联题目。新 Solver 从 `challenge_announcements` 获得完整的转义数据消息；新关联公告会以 `steer` 投递给活跃 Solver，并以稳定 announcement key 支持去重。

Solver 停止原因经过 `classifySolverStop` 归一化：网络断连、Provider 5xx/429 和显式 retryable 错误不增加 block score，记录 `run_transient_failure` 后按基础设施退避重试；认证/配置错误不重试；模型自然停止、长度耗尽和协议异常沿现有 Session interruption/block 路径处理。取消、进程关闭和已提交结果不计入 block。

调度等待队列持久化在 `scheduler_queue`，记录 normal/blocked lane、lane 内位置、人工跨 lane override 和乐观锁版本。自主调度优先填充 normal lane；普通题耗尽后，按 `blocked_at` 顺序加入 blocked revival。领取复活题时保留原 block score，`revival_count` 和 `lifecycle_generation` 各增加 1，因此有效阈值增加 4。人工重排使用版本检查，冲突时拒绝覆盖；数据库队列在进程关闭后保留，显式暂停自主调度或取消排队题目时才删除相应记录。生产默认 Solver 并发数为 8。
