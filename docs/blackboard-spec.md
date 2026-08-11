# 黑板协议

黑板是按题目共享、跨 Run 保留的调查状态。它保存可复用的事实和待验证方向，不替代 Pi JSONL Run 日志：日志记录过程，黑板记录主 Solver 下一次接管时仍需要的结论。

当前实现以 `packages/core/src/persistence/run-store.ts` 的 SQLite 数据模型为准。不要把其他系统常见的 `kind`、置信度、标签、负责人或 `active/resolved/cancelled` 状态写入本项目协议；这些字段目前不存在。

## 1. 数据模型

### Evidence

`EvidenceRecord` 的字段为：

| 字段          | 含义                                     |
| ------------- | ---------------------------------------- |
| `id`          | SQLite 自增 ID，工具中以 `e<id>` 引用    |
| `challengeId` | 所属题目 ID                              |
| `description` | 经验证的事实、命令结果、路径或可复现观察 |
| `runId`       | 首次记录该事实的 Run                     |
| `createdAt`   | 创建时间                                 |

描述最多 4,000 个字符。二进制、脚本和大输出放在题目 workspace，Evidence 只记录路径、hash、关键输入和结果摘要。API key、Cookie、完整 token 和其他秘密禁止写入。

### Opportunity

`OpportunityRecord` 的字段为：

| 字段                       | 含义                                              |
| -------------------------- | ------------------------------------------------- |
| `id`                       | SQLite 自增 ID，工具中以 `o<id>` 引用             |
| `challengeId`              | 所属题目 ID                                       |
| `description`              | 待验证假设或攻击方向                              |
| `status`                   | 只有 `open` 和 `concluded`                        |
| `resolution`               | 结束时为 `confirmed` 或 `dead_end`，否则为 `null` |
| `runId`                    | 创建或结束该方向的 Run                            |
| `sourceEvidenceIds`        | 支撑该方向的 Evidence ID，最多 32 个              |
| `targetEvidenceId`         | 结束时产生的结果 Evidence ID，可为空              |
| `createdAt`、`concludedAt` | 生命周期时间                                      |

实际状态流转只有：

```text
open ── concludeOpportunity ──> concluded
```

`dead_end` 必须在结果 Evidence 中说明尝试过的输入、命令或观察，以及为什么排除该方向。

## 2. Agent 工具

工具由 `packages/core/src/collaboration/blackboard.ts` 的 `createBlackboardTools()` 注入主 Solver。SubAgent 不直接获得黑板工具，只能将调查结果返回主 Solver：

### `blackboard_read`

读取当前题目的 bounded snapshot，返回 Evidence、open Opportunity 和 concluded Opportunity。序列化函数是 `serializeBlackboard()`，输出以 Markdown 供模型读取，并保留 `e<id>`/`o<id>` 引用。

### `blackboard_record`

可以在一次调用中提交以下任意操作：

```json
{
  "evidence": { "description": "确认输入经过 URL 解码两次" },
  "opportunity": {
    "description": "验证二次解码是否绕过路径过滤",
    "sourceEvidenceIds": [12]
  },
  "concludeOpportunity": {
    "opportunityId": 7,
    "resolution": "dead_end",
    "resultDescription": "第二次解码后仍被 canonical path 校验拒绝"
  }
}
```

三种对象都是可选的，但至少要提供一个。单项错误会写入结果中的 `evidenceError`、`opportunityError` 或 `concludeError`，不应假定整次调用已经成功。

### `blackboard_manage`

用于按 ID 修正或删除记录：

- `update_evidence`
- `delete_evidence`
- `update_opportunity`
- `delete_opportunity`

被 Opportunity 引用的 Evidence 不能直接删除，必须先处理引用关系。更新是原地更新，不生成自动的修订历史；需要保留纠正依据时，应先写入新的 Evidence，再更新相关 Opportunity 描述或引用。

## 3. 写入规则

推荐的解题顺序：

1. 验证一个事实后立即记录 Evidence；描述应包含足以复现的命令、输入、输出摘要和文件路径。
2. 只有值得执行实验的方向才创建 Opportunity，不要把可以直接排除的猜测写入黑板。
3. 实验否定方向时，用 `dead_end` 结束 Opportunity，并写入结果 Evidence。
4. 并行 SubAgent 返回结果后，由主 Solver 判断是否是可靠 Evidence，再合并为 Opportunity 结论。
5. 对已被证伪的记录及时修正或删除，但不要把秘密或整段模型思考复制到黑板。

Solver 的行为约束位于 `packages/prompts/src/solver.ts`；SubAgent 被明确禁止直接修改黑板，主 Solver 负责合并其报告。黑板按 `challengeId` 隔离，同一 Project 的不同题目不会共享记录。

## 4. 一致性、容量与上下文

`RunStore.concludeOpportunity()` 在一个 SQLite 事务中完成：

1. 校验 Opportunity 属于当前题目且仍为 `open`。
2. 创建结果 Evidence。
3. 写入 `targetEvidenceId`、`resolution`、`concludedAt`，并将 Opportunity 设为 `concluded`。

Evidence、Opportunity 数量分别限制为每题 256 条；描述限制为 4,000 字符，Opportunity source Evidence 最多 32 条。`blackboard_read` 序列化默认最多 64,000 字符；注入 Solver compaction 后上下文的黑板快照最多 16,000 字符，超出时附带截断提示，要求 Agent 再调用 `blackboard_read`。

黑板摘要会进入 `Project` 组装的 challenge prompt，并在 compaction 后重新注入。RunStore 重启恢复黑板，但不会恢复尚未写入 SQLite 的模型临时结论。

当前实现没有 `event_key` 幂等字段，也没有自动的纠正历史或跨题平台级 Evidence。需要审计时依靠 SQLite 时间、Run ID、Pi JSONL 和 workspace 文件共同还原过程。

## 5. 代码位置与预期效果

| 代码                                                     | 作用                                                                 |
| -------------------------------------------------------- | -------------------------------------------------------------------- |
| `packages/core/src/persistence/run-store.ts`             | 类型、schema、CRUD、容量检查和事务；黑板的持久化事实来源             |
| `packages/core/src/collaboration/blackboard.ts`          | Agent 工具 schema、Markdown 序列化和上下文长度限制                   |
| `packages/core/src/project/project.ts`                   | 按题目创建工具、读取摘要并注入 challenge/compaction prompt           |
| `packages/prompts/src/solver.ts`                         | 要求记录 Evidence、管理 Opportunity、结束前清理 workspace 的行为规则 |
| `packages/core/test/blackboard/blackboard-tools.test.ts` | 工具输入、引用关系、限制和公开结果测试                               |
| `packages/core/test/project/blackboard-store.test.ts`    | 跨 Run、事务和 SQLite 重启行为测试                                   |

修改黑板字段或状态时，必须同时更新本文件、工具参数、RunStore schema、prompt 和公开行为测试。
