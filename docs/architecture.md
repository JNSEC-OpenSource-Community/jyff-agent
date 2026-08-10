# 系统架构

## 分层

```text
WebUI → Hono/SSE → ControlPlane → Project → Scheduler → Agent/Sandbox
                         ├─ ModelPool
                         ├─ PlatformRegistry
                         └─ RunStore(SQLite)
```

每个 Project 都有独立配置、workspace、SQLite、Scheduler 和平台凭据命名空间。服务端 API、SSE 和文件访问必须显式携带 Project ID。

## Project 生命周期

1. `ProjectConfigStore` 从 v1 注册表读取 Project。
2. `ControlPlane` 打开本地记录或连接平台。
3. 连接成功后刷新题目、公告、环境并写入快照。
4. Scheduler 根据队列创建 Run；Run 关闭后持久化 usage、状态和会话路径。
5. 连接失败时使用最后成功快照，标记 `degraded/read-only`，禁止继续解题；恢复连接后解除只读。

## Agent 与容器

- Solver、SubAgent、TLDR 共用一个 Run sandbox；TLDR 使用宿主 workspace 的只读文件工具。
- 每个 Agent 使用独立 Pi JSONL session，SubAgent 结果以结构化通知进入主 session。
- sandbox 默认限制 CPU、内存、进程数和可写层；workspace bind mount 不计入容器层配额。
- Docker create 冲突必须清理同名残留容器，不能通过无限等待掩盖失败。

## 持久化

RunStore 保存 Run、消息、usage、SubAgent snapshot、黑板、平台快照和 compact 事件。SQLite 表结构迁移只服务于当前数据库结构升级，不承担已删除的应用配置兼容。

## 模型

全局 `model-config.json` 只接受 v3。模型池保留完整 Pi Models registry，再按 Project runtime 绑定角色。模型 ID 使用 `provider/model-id@thinkingLevel`。

## 插件与 Father

插件 manifest 必须是 schema v2，并提供静态 `setup`。候选先由 WebUI 展示配置表单，再进入 Docker Validation Gate；报告绑定 session、内容 hash、revision 和 setup fingerprint。只有验证成功且用户批准后才注册到 PlatformRegistry。

## SSE 与前端

后端推送 session、工具调用、SubAgent、验证和运行状态事件。前端按 session 保留滚动位置；切换 Solver/SubAgent 时读取对应 usage。长 URL 使用截断展示，复制操作使用原值。

## 约束

- 文件列表最多 2,000 项；预览仅允许白名单扩展名与 256 KiB 内 UTF-8。
- 平台未提供 `needsEnvironment` 时保持 `unknown`。
- 归档只影响列表，不停止运行中的 Scheduler。
