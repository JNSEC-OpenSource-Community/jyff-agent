# 平台插件

## 内置插件

`packages/platform` 提供 CTFd 与 GZCTF。插件实现连接、题目、公告、环境、提交和可选管理能力，并通过统一 `PlatformPlugin` 契约注册。

内置插件直接编译进控制面，不经过 `extension.json` 加载流程，因此不携带扩展 schema 版本。它们和外部 schema v2 插件共享同一 `PlatformPlugin`、`PlatformSetupDescriptor`、Validation 和 Secret 边界。代码中的 CTFd `/api/v1/` 是 CTFd 服务端的上游 REST API 版本，与本项目插件 schema 无关。

插件生命周期为：解析配置 → `connect` → 获取 overview → 刷新题目/公告 → 绑定题目 → 读取详情/附件/提交 → 管理远程环境 → `close`。`close` 必须幂等，即使连接只完成了一半也能安全调用。

| 能力 | 必需 | 约束 |
| --- | --- | --- |
| 配置解析 | 是 | 拒绝未知字段和明文凭据 |
| 题目列表/详情 | 是 | ID 稳定、分页可重复 |
| 公告 | 是 | 返回原始公告，不自行绑定题目 |
| Flag 提交 | 是 | 错误 flag 返回业务结果，不抛异常 |
| 远程环境 | 可选 | 支持列举、启动、状态、销毁 |

## 配置与凭据

Project 配置保存平台 ID、非敏感选项和 Secret 名称。Secret Store 使用 `projectSecretName(projectId, name)` 命名；插件不得读取未命名空间全局键。

## 扩展插件 schema v2

候选目录至少包含：

```text
extension.json
index.ts
```

`extension.json` 必须包含 `schemaVersion: 2`、`id`、`name`、`version`、`entry` 和 `setup`。setup 是静态表单描述，入口导出平台插件。禁止 symlink、保留 ID、路径穿越和超限文件。

示例：

```json
{
  "schemaVersion": 2,
  "id": "example-ctf",
  "name": "Example CTF",
  "version": "1.0.0",
  "entry": "index.ts",
  "setup": { "label": "连接配置", "fields": [], "authStrategies": [] }
}
```

入口应导出 `platformPlugin` 或默认导出。配置字段、Secret 名称和 setup 字段必须一一对应；setup 变更会改变 fingerprint 并使旧验证报告失效。

## Validation Gate

Father 产出候选后，WebUI 根据 setup 生成表单。用户保存测试配置后，控制面在短生命周期 Docker sandbox 中运行连接、读取和必要的生命周期检查。报告包含状态、内容 hash、revision、session ID 和 setup fingerprint。候选变化或配置字段变化必须重新验证。

只读 Gate 至少检查配置解析、连接、overview、题目列表、公告、题目详情、稳定 ID 和 cleanup。若提供测试 flag，再检查 accepted/rejected；若启用环境，再检查 start/status/destroy。网络、认证、权限、限流和协议错误都必须返回不泄露凭据的有限错误。

## 安装

只有 `read_only_verified` 或 `fully_verified` 报告可安装；安装仍需用户批准。成功后复制 revision、写入 author/report，并注册 PlatformRegistry。主进程不会在验证前导入候选代码。

安装后的 revision 不原地覆盖。更新插件会创建新 revision；active 指针切换失败时保留旧 revision，出现回归可停用新 revision 并回到上一份已验证版本。
