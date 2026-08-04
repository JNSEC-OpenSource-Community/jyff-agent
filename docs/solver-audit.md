# Solver / Pi Coding Agent 审计结果

审计基线：`@earendil-works/pi-*` 0.82.1；Pi 当前官方文档以
<https://github.com/earendil-works/pi/tree/main/packages/coding-agent/docs> 为准。

## 最终包边界

| Package | 职责 |
|---|---|
| `@ctf-agent/agents` | BaseAgent 的 Pi runtime/session/skills，以及继承它的 `CtfSolverAgent` 和单题 CTF 工具；不依赖 Project/SQLite |
| `@ctf-agent/platform` | 平台插件、比赛、题目与单题 capability 契约 |
| `@ctf-agent/sandbox` | Docker 生命周期、Docker-backed Pi `ExecutionEnv`、RTK |
| `@ctf-agent/project` | Project、RunStore、blackboard、runner、scheduler 与遥测 |
| `@ctf-agent/webui` | 控制面 HTTP/SSE 与 UI |

依赖方向为 `project -> agents -> platform/sandbox`，不存在反向
`agents -> project` 依赖。BaseAgent 与各职能 Agent 在同一个包内仍保持目录和类型边界。

## Session 存储决策

完整对话采用 Pi 原生 append-only JSONL session tree，每个 Run 一个
`.ctf-agent/runs/<run-id>/session.jsonl`。理由：

- 原生保存 message、model、thinking level、active tools、compaction、label、leaf 与分支关系；
- `AgentHarness` 在消息和 turn 边界负责写入，不需要 Solver 复制事件状态机；
- JSONL 保留完整树语义，SQLite 关系表若重复表达会产生双写与恢复一致性问题；
- Session 文件适合单 Run 顺序追加，SQLite 继续适合跨 Run 查询、调度、blackboard 和遥测。

SQLite 因此只保存控制面事实，不保存完整 transcript。BaseAgent 可直接重开同一
session path；Project 目前仍以“新 attempt = 新 Run”创建 Solver，尚未提供面向 UI 的
“恢复未完成 Run”工作流。

## 文件工具决策

`bash`、`read`、`write`、`edit` 直接使用 Pi 导出的工具实现，但绑定到
`DockerExecutionEnv`。`list`、题目附件和 CTF capability 工具同样只访问容器内
`/workspace`。宿主机只负责受信任的控制面文件：run metadata、session JSONL、SQLite
以及 bind-mounted workspace。

路径越界、symlink 越界、abort、timeout、spawn、callback 与非零 exit code 分开处理；
Pi `ExecutionEnv` 预期的文件/执行失败使用 `Result`，工具边界才转换为可见 tool error。

## Pi Coding Agent 与当前 SolverAgent 能力差异

| 能力 | Pi Coding Agent | 当前 BaseAgent / SolverAgent |
|---|---|---|
| Agent loop、工具调用、steer/follow-up | 完整 | 复用 `AgentHarness`，并提供空闲时 `nextTurn` 路由 |
| Session 自动保存与恢复 | JSONL tree，支持 continue/resume | 同格式按 Run 保存，可由 BaseAgent 重开 |
| 树导航与分支摘要 | `/tree`、fork、clone | 暴露 `navigateTree()`；尚无 Project/UI fork/clone 工作流 |
| Compaction | 自动/手动，保存原生 compaction entry | 自动阈值检查与 `compact()`；使用 Pi 原生 entry |
| 模型与 thinking level 切换 | 交互式选择并持久化 | `setModel()` / `setThinkingLevel()` 并持久化；当前业务入口主要暴露 thinking level |
| Active tools 持久化 | 支持 | 支持 `setActiveTools()` 并恢复 |
| Skills | 多来源、诊断、XML catalog、`read` 渐进披露、命令调用 | 复用 Pi loader/catalog/显式 `skill()`；只加载项目配置的可信来源并物化进 Docker |
| Prompt templates | 文件发现与 slash command | BaseAgent 支持注册/调用；Project 尚未实现目录发现 |
| bash/read/write/edit | 主机工作目录 | Pi 工具实现运行在每 Run Docker 容器 |
| Provider/auth/model registry | 内置 provider、OAuth/API key、交互登录 | 现阶段用兼容桥接收旧 `AgentOptions`；无交互登录和 provider 管理 UI |
| AGENTS.md / CLAUDE.md / SYSTEM.md | 自动发现、project trust | 未实现；Project 明确传入 system prompt，skills 经过可信复制 |
| Extensions/packages/themes/TUI | 完整 CLI/TUI 扩展生态 | 未引入；WebUI 和 CTF capabilities 是独立控制面 |
| CLI print/JSON/RPC、export/import/share | 提供 | 未提供；SDK 事件由 Project/WebUI 消费 |
| CTF 平台、实例、附件、Flag | 无 | 单题 capability、远程实例、附件下载、Flag 提交 |
| 多题调度与跨 attempt 知识 | 无 | Project、SQLite RunStore、ContestRunner/Scheduler、blackboard |
| 沙箱隔离 | 可通过外部容器方案配置 | 默认强制 Docker 文件与 shell 边界 |

Pi 官方将 coding agent 定位为可扩展的最小终端 harness，并刻意不内置 MCP、sub-agent、
permission popup、plan mode、todo 或 background bash；这些并不是当前 Solver 相对 Pi 的
“缺失回归”，而是需要按未来 Agent 职能单独设计的扩展层。

参考：

- Pi 文档索引：<https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/index.md>
- Session/queue/CLI：<https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/usage.md>
- Skills：<https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/skills.md>
- Extensions：<https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md>

## 错误处理结论

| 类型 | 策略 |
|---|---|
| 输入/配置错误 | 同步拒绝，保留稳定 code 的控制面错误 |
| 文件与执行预期失败 | `Result<FileError/ExecutionError>`，不抛出到 ExecutionEnv 外 |
| Tool 失败 | 在 tool 边界抛出，让 Pi 生成标准 error tool result |
| Provider 失败 | 转换为 Pi error/aborted assistant message，避免 detached rejection |
| Session/compaction 失败 | 拒绝当前操作，不静默回退到未持久化 transcript |
| 遥测失败 | 不终止 Agent，写入最多 100 条的 Project diagnostics |
| 终态持久化失败 | 向调用方抛出并与 cleanup failures 聚合 |
| abort/远程实例/sandbox 清理失败 | 每一步继续执行，最后用 `AggregateError` 一次报告 |

移除的过度防御包括：Solver 自写 transcript compaction、自写 skill frontmatter/XML/tool、
RunStore 在 Solver 工具里的直接依赖，以及 blackboard 注入失败时无痕返回空字符串。

## 测试收缩与保留重点

- 删除自写 compaction 与自写 skill loader 的实现型测试，改测 Pi session 恢复和共享 skill 边界；
- 保留 Docker `ExecutionEnv` 的 path/abort/timeout/streaming 行为；
- 保留 Solver cleanup 顺序与 cleanup error 聚合；
- 保留 runner/scheduler 并发、取消、超时、重试和同题去重；
- 保留 RunStore migration/WAL/blackboard 上限和 Project 生命周期；
- 新增 session 恢复 active tools/compaction entry、小上下文不误压缩、skill symlink 拒绝与诊断可观察性。

## 后续建议

1. 用共享 Pi `Models` registry 替换 `AgentOptions` 兼容桥，统一 provider/auth/compaction 请求。
2. 为 Project 增加显式 `resumeRun(runId)`，校验平台 capability 与 sandbox 重建后再重开 session。
3. 按需增加 prompt-template/context-file loader；不要把完整 Pi CLI/TUI 搬入 BaseAgent。
4. 若未来 Agent 需要权限审批或多 Agent 协作，将其作为 base-agent 上层策略，不侵入 Solver。
