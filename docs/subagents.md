# SubAgent 架构与自定义角色

SubAgent 是每个 Solver Run 内部的一组专业 worker。主 Agent 负责拆分任务、验证结果、记录黑板和提交 Flag；worker 只处理一个有界任务，复用同一题目的模型、skills、`ChallengeCapability` 与 Docker sandbox。

实现参考了 MIT 许可的 [tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents)，移植了其中稳定的 manager/runner 分层、后台并发队列、稳定任务 ID、等待/引导/续跑/取消与完成通知。没有引入它依赖的 Extension/TUI、Git worktree、RPC、定时任务或嵌套代理；这些能力与当前项目“每题一个共享 Docker”的执行模型不匹配。

## 内置角色

默认提供 `general-purpose`、`pwn`、`reverse`、`web`、`crypto`、`misc` 和 `reviewer`。主 Agent 可使用以下工具：

| 工具 | 作用 |
|---|---|
| `Agent` | 创建前台或后台 worker，或续跑已完成会话 |
| `get_subagent_result` | 查询或等待后台结果；等待被取消不会杀死 worker |
| `steer_subagent` | 向运行中的 worker 注入新方向 |
| `cancel_subagent` | 取消排队或运行中的 worker |
| `list_subagents` | 获取本 Run 的完整 worker fleet |

后台并发默认上限为 4。前台调用不占后台池；worker 不设置独立 turn 上限，生命周期受所属挑战的统一超时和人工取消控制。后台完成后通过结构化 `<task-notification encoding="json">` 通知主 Agent。

## Docker 与能力边界

所有 worker 共享题目 Docker 的 `/workspace`，但默认工作目录为 `/workspace/subagents/<worker-id>`。附件统一下载到 `/workspace/attachments`，便于多个 worker 复用。

worker 拥有 `bash`、`read`、`write`、`edit`、`list`、题目信息和附件下载工具。它不能提交 Flag、启停远程实例或直接修改协作黑板；这些操作始终由主 Agent 复核后完成。主 Agent 关闭时会先回收 worker，再清理共享远程实例与 sandbox。

## 自定义角色

项目启动时依次读取：

1. `.agents/agents/*.md`
2. `.pi/agents/*.md`（同名角色优先级更高）

文件名就是传给 `Agent.subagent_type` 的角色名。配置使用 YAML frontmatter，正文作为角色提示词：

```markdown
---
display_name: Firmware RE
description: 自动识别固件格式、文件系统和启动链
tools: [bash, read, write, edit, list, ctf_challenge_info, ctf_download_attachment]
thinking: high
enabled: true
---

先识别封装与架构，再拆出文件系统；所有结论附带可复现命令和产物路径。
```

可选字段：

- `display_name`、`description`：WebUI 与主 Agent 可见的角色信息；
- `tools`：worker 工具白名单，未知工具会让该 worker 明确失败；
- `model`：`provider/model` 格式，只能选择当前控制面已注册的模型；
- `thinking`：`off|minimal|low|medium|high|xhigh|max`；
- `enabled`：设为 `false` 时不向主 Agent暴露。

无效角色会被隔离并写入项目 diagnostics，不影响其他角色启动。服务重启后，SQLite 中遗留的 `queued/running` worker 会标记为 `interrupted`，已完成会话仍保留在 Run 详情与导出数据中。

## WebUI 与持久化

`run_subagents` 保存 worker 的最新状态、提示、会话路径、工作目录、活动工具、turn/tool/token 计数、结果和错误；完整生命周期同时作为 `subagent_*` 事件写入 Run 时间线。React WebUI 在每次 attempt 下展示 fleet，并允许对活跃 worker 执行 steer 或 cancel。
