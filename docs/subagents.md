# SubAgent 生命周期

SubAgent 是一个 Solver Run 内的受限并行 worker。它与主 Solver 共享题目 Docker sandbox、workspace、题目信息和可选 Web Access，但拥有独立 Pi JSONL session、稳定 ID 和默认工作目录。实现入口是 `packages/core/src/collaboration/subagent-manager.ts`，Agent 实现位于 `packages/agents/src/subagent/`。

SubAgent 不是独立 Solver：它不能提交 Flag、销毁远程实例、修改 Project 调度或直接修改黑板。主 Solver 负责验证其结果，并通过黑板工具记录可复用结论。

Project 会提供当前题目的黑板只读工具 `blackboard_read`。角色未设置工具白名单时可使用该工具；设置了 `tools` 时，需显式列入 `blackboard_read`。黑板写入和管理工具只提供给主 Solver，读取方式与权限边界见[黑板协议](blackboard-spec.md)。

## 1. 角色发现

`packages/agents/src/subagent/registry.ts` 内置三个角色：

| 名称              | 用途                             | 默认 thinking |
| ----------------- | -------------------------------- | ------------- |
| `general-purpose` | 跨领域、范围明确的通用调查       | `high`        |
| `explorer`        | 源码和攻击面探索                 | `max`         |
| `fuzzer`          | 黑盒输入、模糊测试和卡住时的探索 | `medium`      |

Project 可以用 Markdown 覆盖角色：

```text
<project-root>/.agents/agents/<role>.md
<project-root>/.pi/agents/<role>.md
```

文件名是 role ID，frontmatter 支持：

```yaml
---
display_name: SQL 探索
description: 检查 SQL 拼接和数据库边界
model: provider/model-id
thinking: high
tools: [read, list, bash]
enabled: true
---
只调查输入到 SQL 的数据流，返回可复现的证据。
```

扫描顺序是 `.agents/agents` 后 `.pi/agents`，后者可以覆盖同名角色。无效 frontmatter、symlink 或禁用角色会进入诊断，不会作为可用 role 暴露给工具。

## 2. 派发接口

主 Solver 使用 `createSubagentManagerTools()` 注入以下工具：

| 工具                  | 作用                                                             |
| --------------------- | ---------------------------------------------------------------- |
| `Agent`               | 创建或恢复 worker；支持同步等待和 `run_in_background`            |
| `get_subagent_result` | 读取结果或等待后台 worker                                        |
| `steer_subagent`      | 向运行中的 worker 追加指导，或从持久化 session 恢复已结束 worker |
| `cancel_subagent`     | 取消 queued 或 running worker                                    |
| `list_subagents`      | 查看当前 Run 的所有 worker                                       |

`Agent` 的关键参数：

```json
{
  "subagent_type": "explorer",
  "description": "检查上传文件解析链路",
  "prompt": "验证文件名、MIME 和路径是否存在可利用差异",
  "run_in_background": true
}
```

prompt 最多 32,000 字符，description 最多 240 字符，steer 消息最多 4,000 字符。未启用或不存在的 role 会立即拒绝，避免产生不可追踪的 worker。

## 3. 运行隔离

每个 worker 的 `SubagentRecord` 包含：

- `id`、`runId`、role、父 Run 和显示信息
- 独立 `sessionPath`：`<runDirectory>/subagents/<id>/session.jsonl`
- 容器工作目录：`/workspace/subagents/<id>`
- prompt、执行身份 `executionId`、结果与 `resultKind`、错误、活动工具、turn/tool 计数和 token usage
- 创建、启动、更新时间及完成时间

worker 通过 `DockerExecutionEnv` 在同一个 Run sandbox 内创建自己的 cwd。共享 sandbox 便于主 Solver 和 worker 复用附件、脚本和分析结果；独立 cwd 减少临时文件相互覆盖。共享 workspace 也意味着角色提示必须明确文件所有权，不能把共享目录当作互不影响的副本。

SubAgent 公共提示词位于 `packages/prompts/src/subagent.ts`，明确禁止：

- 提交 Flag
- 销毁远程题目实例
- 编辑或删除已有 workspace 文件
- 直接修改黑板

它必须在返回前给出可复现的路径、命令、地址、常量、否定结果和下一步建议，而不是只返回计划。

## 4. 队列与生命周期

状态由 `SubagentStatus` 定义：

```text
queued → running → completed
                 ├→ failed
                 ├→ cancelled
                 ├→ aborted
                 └→ interrupted
```

后台 worker 受每个 Run 的 `maxConcurrent` 限制，默认最多 4 个。超过限制的任务保持 `queued`，前一个后台任务结束后由 `drainQueue()` 启动。前台任务立即启动并由主 Solver 等待。

生命周期行为：

1. `spawn()` 校验 role 和输入，生成 ID、执行身份、session 路径及容器 cwd；执行记录持久化成功后才启动任务。
2. 启动后创建 `CtfSubagent`，加载 role prompt、工具白名单、skills 和可选 Web Access，发送 `started`。
3. Agent harness 的 turn、tool 和 usage 事件更新记录，并通过 `onAgentEvent` 转发给 WebUI。
4. 正常完成保存本次执行最后一条 assistant 消息的完整文本；失败或取消时保存本次执行最近可用的 assistant 或工具文本，并标明结果类型。thinking 和压缩摘要不会作为报告正文。
5. 后台 worker 结束且结果未被消费时，管理器向主 Solver steer 一个 `<subagent_notification>`。

worker 一旦获得具体 Flag 候选或可直接使用的 exploit，应立即返回最小可复现结果。主 Solver
将首个此类结果作为中断优先验证，不等待其他 worker；只有平台返回 `accepted` 或
`already_solved` 才构成获胜结果。

单任务通知和工具默认首屏最多包含 8,000 个 Unicode 码点，以及结果类型、版本和后续偏移等元数据。完整报告按需分页读取；列表、压缩恢复和 blocked 收尾使用较短预览，避免反复广播全文。`details` 不重复报告正文。

子模型使用独立的 compaction 规则，要求保留委派目标、实验条件、关键证据、未交接发现和下一步，不假设主模型的上下文快照会自动注入子模型。

## 5. 等待、steer 与恢复

`get_subagent_result` 等待后台任务时默认监听主 Solver 的 steer 队列。如果主 Solver 收到新的人工消息，等待会返回 `waitInterrupted: true`，但不会取消 worker；主 Solver 可以先处理新指令，再继续读取同一个 worker。

`steer_subagent` 对运行中 worker 直接调用 `CtfSubagent.steer()`。对终态 worker，管理器关闭内存 Agent 并从原 JSONL session 恢复，再以同一 ID 继续运行，不会创建隐藏的新 worker。

每次 `spawn` 或恢复执行都会生成新的 `executionId`。恢复前先持久化新身份并清空当前报告；旧执行的迟到更新不能覆盖新记录。报告采集沿 Pi session 的原始父链查找本次执行标记，边界不可用时返回错误，不回退扫描整个会话。迁移前的报告保留为 `legacy`，不能恢复此前已经截断的内容。

`resultKind` 区分 `assistant_final`、`assistant_partial`、`tool_partial` 和 `legacy`，调用方应将部分输出视为待核验信息。

`get_subagent_result` 支持 `offset`、`limit` 和 `expectedResultVersion`：偏移按 Unicode 码点计算，默认和最大 `limit` 均为 8,000，单次工具响应预算为 96 KiB。首屏返回 `resultVersion`、`totalLength`、`nextOffset` 和 `hasMore`；读取后续页时传入该版本和 `nextOffset`。报告或执行身份变化时返回 `result_changed`，调用方应从新版本首屏重新读取。任务尚无报告时返回 `result_pending`，终态无报告时返回 `result_unavailable`。

`list_subagents` 使用 `cursor` 和 `limit` 分页，默认 16 条、最多 32 条，返回 `nextCursor` 和 `omittedCount`。每条报告预览最多 1,200 个码点，集合响应受 16 KiB 预算约束。前端和外部调用方也可通过 Project 作用域的以下接口读取：

- `GET /api/projects/:projectId/runs/:runId/subagents`：支持 `cursor` 和 `limit`。
- `GET /api/projects/:projectId/runs/:runId/subagents/:subagentId/result`：支持 `offset`、`limit` 和 `expectedResultVersion`。

`steer` 和 `cancel` 的 HTTP 响应也使用单任务报告首屏，而非返回完整报告正文。

`restore()` 只重新挂载已持久化的终态记录。新进程不会盲目继续上一次仍处于 running 的 worker；Project 初始化会将遗留状态标为 interrupted，避免旧进程持有的 Docker 资源被当成活跃任务。

## 6. 收尾与终态持久化

`CtfSubagentManager.finalize()` 用于题目进入 blocked 时的收尾屏障：

1. 取消尚未启动的 queued worker。
2. 捕获运行中 worker 的最新回复并取消当前 turn。
3. 在同一 JSONL session 中启动最终报告 turn。
4. 在 grace period 内等待；仍未完成的任务捕获最新结果后取消。
5. 确认所有 worker 进入终态并等待 Agent idle。

平台接受首个 Flag 后会立即启动 `close()`，并在进入 Writeup turn 前等待回收完成。
接受状态会在回收前写入 RunStore，后续清理或 Writeup 失败不会覆盖该状态。
`run_submission_accepted` 事件保存平台返回的 `accepted` 或 `already_solved` 状态及原始提交值；该事件不受常规遥测脱敏等级控制。`already_solved` 表示题目已解决，不证明本次提交值已获验证。

`close()` 会在取消非终态任务时保留当前执行最近可用的 assistant 或工具文本。回收过程是幂等的，重复调用会等待同一个屏障，避免共享 Sandbox 在 worker
完全停止前被销毁。RunStore 保存终态记录、session path、已回收结果、错误和 usage；WebUI
仍可查看历史对话和导出 HTML，但不会允许向终态 worker 发送指令，除非通过 `resume` 恢复。

当前实现没有独立的 `timed_out` SubAgent 状态。超时或硬中止会表现为 `aborted`、`cancelled` 或 `interrupted`，具体取决于触发路径；不要在 API 或文档中假设存在 `timed_out`。

## 7. 代码位置与预期效果

| 代码                                                      | 作用                                                                 |
| --------------------------------------------------------- | -------------------------------------------------------------------- |
| `packages/agents/src/subagent/registry.ts`                | 内置 role、Project role 覆盖、frontmatter 和工具可用性               |
| `packages/agents/src/subagent/subagent-agent.ts`          | `CtfSubagent` 的 Pi session、工具白名单和容器执行环境                |
| `packages/core/src/collaboration/subagent-manager.ts`     | 派发、并发、等待、steer、恢复、通知、finalize 和 close               |
| `packages/core/src/collaboration/subagent-report.ts`      | 执行边界、结果版本、报告分页和列表预览                               |
| `packages/core/src/project/project.ts`                    | 为每个 Run 创建 manager，注入题目信息、skills、sandbox 和 Web Access |
| `apps/backend/src/http/routes/runs.ts`                    | 对话读取、SSE 事件、steer、cancel、retry 和 HTML 导出 API            |
| `apps/frontend/src/pages/challenge/AgentSidebar.tsx`      | 显示 Solver/SubAgent、状态、usage 和切换入口                         |
| `apps/frontend/src/pages/challenge/ConversationPanel.tsx` | 加载指定 session 对话、订阅事件和发送 steer                          |
| `packages/core/test/project/subagent-manager.test.ts`     | 并发、通知、steer 中断等待、恢复和终态行为测试                       |

变更 SubAgent 协议时，应同时核对 role 工具白名单、RunStore 的 `run_subagents` 表、SSE payload、前端状态映射和 `packages/prompts/src/subagent.ts` 的安全边界。
