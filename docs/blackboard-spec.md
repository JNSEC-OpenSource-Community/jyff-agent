# Blackboard 协议

黑板是跨 Run 保留的调查知识层，分为 Evidence 与 Opportunity。

黑板不替代 Run 日志：日志记录过程，黑板记录可复用结论。每条记录都关联 Project 和题目；跨题目的平台事实应放在平台级 Evidence，不能复制到每个 Run。

## Evidence

Evidence 包含 `id`、`challengeId`、`kind`、`summary`、`details`、来源、置信度、标签和时间。内容应记录可复现事实，不写未经验证的猜测。

推荐的 `kind` 有 `observation`、`request`、`result`、`credential_hint` 和 `artifact`。`details` 应包含命令、输入、输出摘要和文件路径；二进制文件放 workspace，Evidence 只记录 hash 和路径。凭据值、Cookie 和完整 token 禁止写入。

## Opportunity

Opportunity 描述待验证方向：目标、假设、优先级、状态和负责人。Solver 可创建、更新、结束；结束时写入结果 Evidence。`resolution` 使用 `confirmed`、`rejected` 或 `dead_end`。

状态流转为 `open → active → resolved|cancelled`。同一题目的相同假设应复用已有 Opportunity；更新时增加新证据引用，不要覆盖历史结论。`dead_end` 必须说明尝试过什么以及为什么排除。

## 一致性

结束 Opportunity、写结果 Evidence 和更新状态在一个 SQLite 事务中完成。`event_key` 幂等，崩溃重放不得重复计分。敏感凭据不得写入黑板。

并行 SubAgent 先写 Evidence，再由主 Solver 合并为 Opportunity 结论。删除或纠正结论时保留原记录和纠正原因，以便 compact、重启和审计后仍能还原决策依据。
