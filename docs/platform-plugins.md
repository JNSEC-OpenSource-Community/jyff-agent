# 平台插件

## 内置插件

`packages/platform` 提供 CTFd 与 GZCTF。插件实现连接、题目、公告、环境、提交和可选管理能力，并通过统一 `PlatformPlugin` 契约注册。

## 配置与凭据

Project 配置保存平台 ID、非敏感选项和 Secret 名称。Secret Store 使用 `projectSecretName(projectId, name)` 命名；插件不得读取未命名空间全局键。

## 扩展插件 schema v2

候选目录至少包含：

```text
extension.json
index.ts
```

`extension.json` 必须包含 `schemaVersion: 2`、`id`、`name`、`version`、`entry` 和 `setup`。setup 是静态表单描述，入口导出平台插件。禁止 symlink、保留 ID、路径穿越和超限文件。

## Validation Gate

Father 产出候选后，WebUI 根据 setup 生成表单。用户保存测试配置后，控制面在短生命周期 Docker sandbox 中运行连接、读取和必要的生命周期检查。报告包含状态、内容 hash、revision、session ID 和 setup fingerprint。候选变化或配置字段变化必须重新验证。

## 安装

只有 `read_only_verified` 或 `fully_verified` 报告可安装；安装仍需用户批准。成功后复制 revision、写入 author/report，并注册 PlatformRegistry。主进程不会在验证前导入候选代码。
