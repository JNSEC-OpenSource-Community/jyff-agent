# SubAgent

SubAgent 是 Solver Run 内的并行 worker，共享同一 sandbox、workspace、平台上下文和黑板。

## 派发

主 Solver 使用 registry 按角色选择模型和提示词，创建独立 JSONL session。worker 有并发上限、超时和取消信号；主 Solver 可取消等待，让 steer 消息优先进入。

## 通知

worker 完成、失败或被取消后立即发送结构化 `<subagent_notification>`，包含 agent ID、状态、摘要、Evidence 引用和时间。WebUI 可从工具调用跳转对应聊天页。

## 终态

`completed`、`failed`、`cancelled`、`timed_out` 均写入 RunStore snapshot。compact 或 blocked 收尾前必须停止仍运行的 worker，并保留最终报告。
