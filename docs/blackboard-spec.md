# Blackboard 协议

黑板是跨 Run 保留的调查知识层，分为 Evidence 与 Opportunity。

## Evidence

Evidence 包含 `id`、`challengeId`、`kind`、`summary`、`details`、来源、置信度、标签和时间。内容应记录可复现事实，不写未经验证的猜测。

## Opportunity

Opportunity 描述待验证方向：目标、假设、优先级、状态和负责人。Solver 可创建、更新、结束；结束时写入结果 Evidence。`resolution` 使用 `confirmed`、`rejected` 或 `dead_end`。

## 一致性

结束 Opportunity、写结果 Evidence 和更新状态在一个 SQLite 事务中完成。`event_key` 幂等，崩溃重放不得重复计分。敏感凭据不得写入黑板。
