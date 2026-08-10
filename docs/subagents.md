# SubAgent

SubAgent 是 Solver Run 内的并行 worker，共享同一 sandbox、workspace、平台上下文和黑板。

worker 不是独立 Solver：它不能改变调度队列、平台配置或 Project 状态，只能通过分配给它的工具和黑板接口工作。每个 worker 有稳定的 `agentId`、角色、父 session、创建时间和取消原因。

## 派发

主 Solver 使用 registry 按角色选择模型和提示词，创建独立 JSONL session。worker 有并发上限、超时和取消信号；主 Solver 可取消等待，让 steer 消息优先进入。

派发请求至少包含题目 ID、目标、已知约束、输出格式和截止时间。重复派发相同 `taskKey` 时返回已有 worker，而不是创建隐形副本。达到 Project 或 Run 并发上限时，工具返回排队状态并明确预计等待原因。

## 通知

worker 完成、失败或被取消后立即发送结构化 `<subagent_notification>`，包含 agent ID、状态、摘要、Evidence 引用和时间。WebUI 可从工具调用跳转对应聊天页。

通知摘要不应复制整段模型思考或敏感输出；完整结果保存在 worker session 和 RunStore。通知到达后主 Solver 可以继续当前 turn，也可以在下一 turn 使用 Evidence ID 读取细节。

## 终态

`completed`、`failed`、`cancelled`、`timed_out` 均写入 RunStore snapshot。compact 或 blocked 收尾前必须停止仍运行的 worker，并保留最终报告。

关闭顺序为：发送取消信号 → 等待当前工具返回 → 写入终态 snapshot → 关闭 session → 回收 sandbox 资源。超过收尾等待时间的 worker 标记 `timed_out`，不能继续占用调度并发。WebUI 显示终态后仍允许查看历史消息和 usage，但不允许向终态 worker 发送新指令。
