# 贡献指南

感谢参与 JYFF Agent 的开发。请先阅读 [README.md](README.md) 和相关架构文档，再提交改动。

## 开始开发

环境要求：

- Node.js `>=22.19.0`
- pnpm `11.20.0`（仓库通过 `packageManager` 固定版本）
- Docker Engine 或 Docker Desktop

安装依赖：

```bash
vp install
```

启动 WebUI：

```bash
vp run webui
```

需要运行 Solver、Father 或插件验证时，先构建 sandbox 镜像：

```bash
vp run build:sandbox
```

## 编码与测试

- 使用仓库提供的 `vp` 命令，不要绕过 Vite+ 自行替换工具链。
- 新行为应在受影响包的 `test/` 目录增加面向公共行为的测试。
- Project 级 API、SSE 和 workspace 操作必须保留 Project ID 作用域；Run 状态以 RunStore 为准。
- 修改 `packages/web-access` 前先阅读其 `UPSTREAM_PIN.md`。

提交前按以下顺序执行：

```bash
vp check
vp run typecheck
vp test
vp build
```

修改 Dockerfile 时另外执行：

```bash
docker build --check -f apps/backend/Dockerfile .
```

运行单个测试文件：

```bash
vp test run path/to/file.test.ts
```

平台 live 测试默认跳过，只有在明确需要时设置 `CTFD_DEMO_TOKEN` 或 `GZCTF_LIVE=1`。

## 提交 Pull Request

1. 从 `main` 创建分支，保持每个 PR 聚焦于一个主题。
2. 说明改动目的、用户可见影响和已执行的验证命令。
3. 不要提交密钥、`.ctf-agent/`、构建产物或本地日志。
4. 涉及配置、接口或安全边界时，同时更新必要文档和测试。
5. 提交信息使用 gitmoji + Conventional Commits，例如：`✨ feat(core): add project lifecycle`。

PR 会运行格式/静态检查、类型检查、测试、构建和 Dockerfile 检查；请在 CI 通过后再请求合并。
