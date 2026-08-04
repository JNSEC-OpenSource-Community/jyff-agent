# CTF SubAgent 设计规范

## 目标

SubAgent 用于在单道题的主求解流程内并行验证多个独立思路。主 `CtfSolverAgent`
保留完整解题能力和最终决策权，Worker 只负责有边界的探索任务。

每道题始终只有一个平台 capability、一个远程实例所有者和一个 Docker Sandbox。
所有 Worker 复用该 Sandbox，避免重复下载附件、重复启动实例以及不同容器环境造成的
分析结果漂移。

## 所有权与能力边界

- 主 Agent 拥有 Flag 提交、实例启动/销毁、Blackboard 写入和 Solver 生命周期。
- `SubagentManager` 随主 Agent 创建，在实例和 Sandbox 关闭前优先关闭。
- Worker 是普通 Pi `Agent`，不能嵌套创建 `CtfSolverAgent`。
- Worker 可执行 shell、读写其工作目录、读取题目信息、下载附件和查询实例状态。
- Worker 不拥有 Flag 提交、实例启动/销毁、Blackboard 或递归创建 Agent 的工具。
- Worker 的默认目录为 `/workspace/subagents/<id>`；共享附件位于
  `/workspace/attachments`。这是避免意外文件冲突的工作约定，不是安全边界。

## 生命周期

```text
queued -> running -> completed
                  -> failed
                  -> timed_out
queued/running    -> cancelled
```

默认每个 Run 最多并行 3 个 Worker、累计创建 8 个 Worker、单个 Worker 最长运行
10 分钟。队列等待不消耗 Worker 自身超时；从目录准备和 Agent 配置开始计时。

主 Agent 关闭、Run 取消或 Flag 被接受后，管理器先取消排队和运行中的 Worker，等待
有限的 abort 宽限期，再允许远程实例与 Sandbox 被销毁。

## 主 Agent 工具

- `ctf_subagent_spawn`：批量入队并立即返回任务 ID。
- `ctf_subagent_list`：读取所有或指定任务的状态和报告。
- `ctf_subagent_wait`：等待任意或全部任务；等待超时不会取消 Worker。
- `ctf_subagent_cancel`：取消排队或运行中的任务。

Worker 必须使用 `ctf_subagent_report` 返回 `found`、`not_found` 或 `blocked` 报告，
包含摘要、发现、产物路径、关键命令、下一步和置信度。若 Worker 正常结束但没有调用该
工具，管理器生成低置信度的 `blocked` 回退报告。

## Blackboard 集成原则

Worker 报告不自动成为 Evidence，也不自动关闭 Opportunity。主 Agent 应独立验证报告，
再通过现有 Blackboard 工具记录 Evidence 或 conclude Opportunity。后续持久化阶段会把
Worker 运行状态独立存入 `run_subagents`，而不扩展 Opportunity 的业务状态。

## 兼容性

SubAgent 通过 `CreateSolverOptions.subagents` 显式启用。未配置时不创建管理器、不注入
管理工具，现有单 Agent 行为保持不变。Runner 和 Scheduler 只透传该配置，不改变比赛级
并发语义。
