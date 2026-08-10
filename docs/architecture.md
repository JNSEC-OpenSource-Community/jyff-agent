# 系统架构

## 分层

```text
WebUI → Hono/SSE → ControlPlane → Project → Scheduler → Agent/Sandbox
                         ├─ ModelPool
                         ├─ PlatformRegistry
                         └─ RunStore(SQLite)
```

每个 Project 都有独立配置、workspace、SQLite、Scheduler 和平台凭据命名空间。服务端 API、SSE 和文件访问必须显式携带 Project ID。

| 层 | 责任 | 边界 |
| --- | --- | --- |
| WebUI | 展示状态、收集输入、订阅 SSE | 不保存凭据，不推断 Project |
| HTTP/SSE | 鉴权、校验、事件分发 | 不跨 Project 读取数据 |
| ControlPlane | 管理连接和生命周期 | 不持有浏览器本地状态 |
| Project/Scheduler | 调度 Run、限制并发、恢复 | 不绕过 RunStore 写状态 |
| Agent/Sandbox | 调查、工具和文件操作 | 不访问宿主机任意路径 |

## Project 生命周期

1. `ProjectConfigStore` 从 v1 注册表读取 Project。
2. `ControlPlane` 打开本地记录或连接平台。
3. 连接成功后刷新题目、公告、环境并写入快照。
4. Scheduler 根据队列创建 Run；Run 关闭后持久化 usage、状态和会话路径。
5. 连接失败时使用最后成功快照，标记 `degraded/read-only`，禁止继续解题；恢复连接后解除只读。

Project 阶段包括 `unconfigured`、`connecting`、`ready`、`degraded` 和 `closed`。归档只影响列表分组；归档 Project 使用本地快照，不启动远程调度。

## Agent 与容器

- Solver、SubAgent、TLDR 共用一个 Run sandbox；TLDR 使用宿主 workspace 的只读文件工具。
- 每个 Agent 使用独立 Pi JSONL session，SubAgent 结果以结构化通知进入主 session。
- sandbox 默认限制 CPU、内存、进程数和可写层；workspace bind mount 不计入容器层配额。
- Docker create 冲突必须清理同名残留容器，不能通过无限等待掩盖失败。

容器名称由 `projectId/runId` 派生。重试前只处理属于当前 Run 的同名残留，不能删除其他 Project 的容器。

## 持久化

RunStore 保存 Run、消息、usage、SubAgent snapshot、黑板、平台快照和 compact 事件。SQLite 表结构迁移只服务于当前数据库结构升级，不承担已删除的应用配置兼容。

权威性顺序为 RunStore 终态、Agent snapshot、内存队列、UI 临时状态。SSE 断线后先重新拉取快照，再从事件序列继续订阅；重复事件按稳定 ID 去重。

## 模型

全局 `model-config.json` 只接受 v3。模型池保留完整 Pi Models registry，再按 Project runtime 绑定角色。模型 ID 使用 `provider/model-id@thinkingLevel`。

| 角色 | 配置位置 | 缺省行为 |
| --- | --- | --- |
| Solver | Project runtime | 未配置时禁止调度 |
| TLDR | Project runtime | 回退到 Solver 绑定 |
| SubAgent | Project runtime/frontmatter | 使用角色模型 |
| Father | 全局模型池 | Father 未绑定时使用 Solver |

Provider API Key 只在后端解析。模型发现失败时保留手工输入，不把上游错误正文或凭据返回浏览器。

## 插件与 Father

插件 manifest 必须是 schema v2，并提供静态 `setup`。候选先由 WebUI 展示配置表单，再进入 Docker Validation Gate；报告绑定 session、内容 hash、revision 和 setup fingerprint。只有验证成功且用户批准后才注册到 PlatformRegistry。

Father session 可以在没有运行 Solver 时创建。session 初始使用随机名称，Father 识别插件后再替换为插件名。修复插件时创建新 session，历史 session、候选目录和验证报告保留，便于追溯。

## SSE 与前端

后端推送 session、工具调用、SubAgent、验证和运行状态事件。前端按 session 保留滚动位置；切换 Solver/SubAgent 时读取对应 usage。长 URL 使用截断展示，复制操作使用原值。

事件包含 `projectId`、`sessionId`、类型和服务端时间。SubAgent 的新建、取消、等待和结果调用显示为特殊卡片；点击卡片可跳转对应 session。等待结果时若 steer 队列出现消息，后端取消等待并优先处理 steer。

## 约束

- 文件列表最多 2,000 项；预览仅允许白名单扩展名与 256 KiB 内 UTF-8。
- 平台未提供 `needsEnvironment` 时保持 `unknown`。
- 归档只影响列表，不停止运行中的 Scheduler。
- 文件列表最多 2,000 个普通文件，不跟随 symlink；下载和预览都做 containment 校验。
- 环境 endpoint 过长时只截断视觉文本，复制操作使用完整原值。
