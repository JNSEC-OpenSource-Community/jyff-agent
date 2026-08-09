# SubAgent 架构与自定义角色

SubAgent 是单个 Solver Run 内的专业 worker。主 Solver 负责拆分任务、复核结果、记录黑板和提交 Flag；worker 每次只处理一个有界任务。实现借鉴 MIT 许可的 [tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents)，采用 manager/runner 分层、后台队列、稳定任务 ID 和完成通知，但不引入 Extension/TUI、worktree、RPC 或嵌套 Agent。

## 内置角色与 thinkingLevel

| 角色 | thinkingLevel | 适用方向 |
|---|---:|---|
| `general-purpose` | `high` | 通用探索和跨方向调查 |
| `explorer` | `max` | 深入浏览代码与攻击面 |
| `fuzzer` | `medium` | 对有界机会执行模糊测试与黑盒枚举 |

这些档位由 `packages/agents/src/subagent/registry.ts` 单独配置，不继承 Solver 的值。最终档位仍由 Pi 根据所选模型支持范围进行 clamp。

## 主 Solver 工具

| 工具 | 作用 |
|---|---|
| `Agent` | 创建前台/后台 worker，或续跑已完成的 worker 会话 |
| `get_subagent_result` | 查询或等待后台结果；`interrupt_on_steer` 默认开启，取消等待不会杀死 worker |
| `steer_subagent` | 向运行中的 worker 注入新方向 |
| `cancel_subagent` | 取消排队或运行中的 worker |
| `list_subagents` | 获取本 Run 的完整 fleet |

后台并发默认上限为 4，前台调用不占后台池。后台任务完成后立即向主 Solver steer 结构化 `<subagent_notification>`；若 Solver 正在以 wait 模式调用 `get_subagent_result` 等待其他 worker，默认中断这次等待，让已排队的 steer 在下一个 turn 进入，但不会取消仍在运行的 worker。调用方可用 `interrupt_on_steer=false` 选择继续等待。主 Solver 关闭时，manager 会取消或终止当前 Run 的全部 worker。共享 system prompt 禁止 worker 以计划、准备切换思路或单纯进度说明提前结束；它必须继续实际调查，直到形成可复现交付物、以具体负面证据穷尽有界方向，或主 Solver 明确要求阶段报告。`steer_subagent` 对 running worker 直接排队消息；对 completed/failed/cancelled/aborted/interrupted worker 则从原 JSONL session 恢复同一 ID，作为后台任务继续，完成后再次通知主 Solver。

派发 prompt 当前受一个基础占位协议约束：只能委派可独立并行、边界清楚且有可验证交付物的任务，不能委派整道题、重复工作或 Flag 提交；prompt 必须使用 `<subagent_task>`，包含 `objective`、`context`、`deliverables` 和 `constraints`。协议定义在 `packages/prompts/src/project.ts`，后续可直接替换。

## Docker 与能力边界

worker 共享题目 Docker 和已下载的 `/workspace/attachments`，默认工作目录为 `/workspace/subagents/<worker-id>`。它们拥有 `bash`、`read`、`write`、`edit`、`list`，可访问容器内任意路径。

系统不再提供题目信息读取或附件下载工具。题目上下文已经附加到主 Solver 的初始消息，附件在 worker 创建前已自动下载；主 Solver在派发任务时应把 worker 所需的题目信息、路径和已验证事实明确写进 prompt，因为 worker 看不到父会话。

worker 不能提交 Flag、启停远程实例或直接修改协作黑板。这些操作由主 Solver复核后完成。

## 自定义角色

项目启动时依次读取：

1. `.agents/agents/*.md`
2. `.pi/agents/*.md`（同名角色覆盖前者）

文件名是传给 `Agent.subagent_type` 的角色名。YAML frontmatter 配置角色，正文是角色 system prompt：

```markdown
---
display_name: Firmware RE
description: 自动识别固件格式、文件系统和启动链
tools: [bash, read, write, edit, list]
thinking: high
enabled: true
---

先识别封装与架构，再拆出文件系统；所有结论附带可复现命令和产物路径。
```

可选字段：

- `display_name`、`description`：WebUI 和主 Solver 可见的角色信息；
- `tools`：worker 工具白名单，未知工具会让任务明确失败；
- `model`：`provider/model`，只能选择控制面模型池中已注册的模型；WebUI 可按 role 覆盖，新 Run 生效；
- `thinking`：`off|minimal|low|medium|high|xhigh|max`，省略时为 `low`；
- `enabled`：设为 `false` 时不向主 Solver 暴露。

无效角色会被隔离并写入 Project diagnostics，不阻止其他角色启动。SQLite 的 `run_subagents` 保存 worker 状态、会话路径、工作目录、当前工具、turn/tool/token 计数、结果和错误；完整生命周期同时写入 Run 事件时间线。WebUI 题目页在右侧列出所属 attempt 的 worker 状态，选择 worker 后复用 Solver 的结构化 Pi session 对话布局；即使 worker 已退出，steer 也会从持久化 JSONL 恢复对象后继续。
