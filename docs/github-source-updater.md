# GitHub 源码更新插件设计

> 状态：Implemented baseline（GitHub 检查、WebUI、Worker 协议与本地 Worker 已实现；Compose 镜像切换仍需部署适配）
> 插件 ID：`github-source-updater`
> 作用域：全局运维插件，不是 `PlatformPlugin`

## 实现状态

本次实现已经落地：

- `apps/backend/src/domain/build-identity.ts`：从构建环境或 Git 工作区读取当前版本身份。
- `apps/backend/src/domain/github-source-updater.ts`：GitHub branch/Release 检查、Compare、ETag、状态持久化、候选准备/应用编排和自动检查。
- `apps/backend/src/http/routes/source-updater.ts`：全局配置、Token、检查、准备、应用、回滚 API。
- `apps/frontend/src/pages/settings/GitHubSourceUpdaterEditor.tsx`：全局配置插件页。
- `apps/updater/src/main.ts`：受 Bearer Token 保护的本地 staging/build/systemd/health/rollback Worker。

当前 Worker 的应用模式面向 `current -> releases/<revision>` 的本地 systemd 部署；Compose/GHCR digest rollout 仍应实现专用部署适配器，不能直接把本地 symlink 模式用于容器。

## 1. 目标

在 WebUI 的“全局配置 → 插件”中提供一个依赖 GitHub 的源码版本更新入口：

- 显示当前运行版本、Git commit、更新通道和可用版本。
- 支持手动检查、准备、应用和回滚。
- 支持定时检查；用户明确开启后，可在维护窗口且系统空闲时自动应用。
- 同一次更新必须让 WebUI、Solver sandbox、Father Validation Gate 和 Audit Worker 使用同一源码 revision。
- 更新失败不能破坏 `.ctf-agent` 状态，健康检查失败时自动回滚。
- GitHub Token、部署凭据和 Docker 权限不能进入浏览器响应、日志或 Project 数据。

非目标：

- 不在正在运行的 WebUI 进程内执行 `git pull` 或覆盖当前源码目录。
- 不允许 WebUI 提交任意 shell、构建命令、Git URL 或 Docker 参数。
- 不把该能力塞进现有平台扩展合同；`PlatformPlugin` 只负责 CTF 平台适配。

## 2. 为什么需要独立更新执行器

当前部署有两个重要事实：

1. 本地模式从工作区运行 `apps/backend/src/main.ts`。
2. 推荐的 Compose 模式把源码和依赖复制进 `ctf-agent-webui:latest`；运行时镜像没有 `.git`、Vite+ 或完整构建工具，而且 WebUI、Solver、Father 验证与 Audit 使用多个镜像。

因此主进程直接更新自己会产生以下问题：

- 更新一半时，旧后端可能开始服务新前端静态文件。
- 只更新 WebUI 会让 `ctf-agent-solver:latest`、`ctf-agent-audit:latest` 与后端协议漂移。
- 当前进程无法可靠替换自己的容器并验证新进程后再回滚。
- WebUI 已经可以访问 Docker socket；继续把源码下载、构建和容器替换逻辑放入互联网暴露进程，会进一步扩大 root 等价权限面。
- SQLite 或 JSON schema 升级后，简单切回旧镜像不一定能读取新状态。

设计采用两层结构：

```text
GlobalSettingsPage
       │ authenticated HTTP / SSE
       ▼
GitHubSourceUpdater（backend control adapter）
       │ 固定协议 + expected revision
       ▼
Update Worker（宿主 systemd 服务或独立 sidecar）
       ├── GitHub API / GHCR
       ├── immutable staging directory / images
       ├── validation + state backup
       └── rollout + health check + rollback
```

后端负责配置、展示、权限和编排意图；独立 Worker 才拥有下载、构建、切换版本和重启服务的权限。

## 3. 更新对象：以源码 revision 为真相，以版本包为部署单元

一次更新不是一个文件，也不是单个 WebUI 镜像，而是一个不可拆分的 **revision bundle**：

```json
{
  "schemaVersion": 1,
  "version": "0.2.0",
  "revision": "40-character-git-sha",
  "repository": "JNSEC-OpenSource-Community/jyff-agent",
  "createdAt": "2026-08-22T00:00:00.000Z",
  "images": {
    "webui": "ghcr.io/.../webui@sha256:...",
    "solver": "ghcr.io/.../solver@sha256:...",
    "audit": "ghcr.io/.../audit@sha256:..."
  },
  "stateSchema": 1,
  "minimumUpdaterProtocol": 1,
  "provenance": {
    "required": true,
    "workflow": ".github/workflows/release.yml"
  }
}
```

`revision` 必须嵌入三类镜像和 WebUI `/health` 响应。Worker 只接受 digest，不使用可漂移的 `latest` 作为最终部署引用。

### 3.1 GitHub 通道

插件支持两种通道：

| 通道      | GitHub 来源                                                  | 用途                                      | 自动应用默认值           |
| --------- | ------------------------------------------------------------ | ----------------------------------------- | ------------------------ |
| `release` | 最新非 draft、非 prerelease Release + `update-manifest.json` | 生产稳定版                                | 可显式开启               |
| `branch`  | `GET /repos/{owner}/{repo}/commits/{ref}`，默认 `main`       | 当前仓库尚未建立 Release 流程时的过渡通道 | 禁止，除非部署端显式放行 |

当前仓库根 `package.json` 没有产品版本合同，且运行镜像使用 `latest`。正式开放 `release` 自动更新前，先建立 semver、GitHub Release、SHA tag、digest manifest 和 provenance 流程。没有 Release 时可以检查 `main`，但不应静默把 branch head 当成稳定版本。

### 3.2 版本关系

候选 revision 必须满足：

1. 与当前 build identity 属于同一个受信仓库。
2. GitHub Compare API 判定当前 revision 只落后于候选 revision，或 Release manifest 显式声明允许的升级路径。
3. `ahead` 不降级；`diverged` 阻止自动更新；未知当前 SHA 只允许人工恢复流程。
4. 候选 SHA、manifest SHA、镜像 OCI label 和健康检查返回 SHA 完全一致。
5. 应用时再次校验 `expectedCurrentRevision` 和 `expectedTargetRevision`，避免检查与应用之间的 TOCTOU。

## 4. 插件配置与持久化

非敏感配置保存到：

```text
<root>/.ctf-agent/source-updater/config.json
```

建议 schema：

```json
{
  "schemaVersion": 1,
  "enabled": false,
  "repository": "JNSEC-OpenSource-Community/jyff-agent",
  "channel": { "kind": "branch", "ref": "main" },
  "check": {
    "automatic": true,
    "intervalMinutes": 360
  },
  "apply": {
    "automatic": false,
    "policy": "when-idle",
    "maintenanceWindow": null,
    "drainTimeoutMinutes": 30
  },
  "security": {
    "requireVerifiedProvenance": true
  },
  "retention": 2
}
```

约束：

- `repository` 只接受部署时 allowlist 中的 `owner/repo`，默认固定为当前 build identity；不能通过 WebUI 指向任意仓库。
- GitHub API base URL 固定为 `https://api.github.com`。如需 GHES，只能由启动配置提供允许的 origin。
- `intervalMinutes` 建议范围为 15–1440；失败使用指数退避并加 jitter。
- `retention` 至少保留当前版本和一个可回滚版本。
- 自动应用默认关闭；从 branch 自动应用还需 Worker 启动参数显式允许。

敏感值只保存到全局 `SecretStore`：

- `CTF_GITHUB_UPDATER_TOKEN`：GitHub Contents/Metadata read-only；公共仓库可省略。
- `CTF_GITHUB_PACKAGES_TOKEN`：仅私有 GHCR 需要，单独授权 `packages:read`。
- `CTF_UPDATE_WORKER_TOKEN`：后端和 Worker 的本地协议认证，自动生成，不在表单显示。

浏览器只收到 `githubTokenConfigured`、`packagesTokenConfigured` 等布尔值。

运行状态和审计记录保存到：

```text
<root>/.ctf-agent/source-updater/
├── config.json
├── status.json                 # 原子写；重启后可恢复最后状态
├── operations/<operation-id>.json
├── audit.jsonl                 # 不含 Token、Header 和上游正文
└── backups/<operation-id>/     # 由 Worker 管理或引用外部快照
```

## 5. 后端合同

### 5.1 领域接口

建议新增独立接口，不扩展 `PlatformPlugin`：

```ts
interface SourceUpdater {
  snapshot(): Promise<SourceUpdaterView>
  updateConfiguration(input: SourceUpdaterConfigurationUpdate): Promise<SourceUpdaterView>
  setGitHubToken(token: string | undefined): Promise<void>
  checkNow(): Promise<SourceUpdateOperationView>
  prepare(input: { expectedTargetRevision: string }): Promise<SourceUpdateOperationView>
  apply(input: {
    operationId: string
    expectedCurrentRevision: string
    expectedTargetRevision: string
  }): Promise<SourceUpdateOperationView>
  rollback(input: { operationId: string }): Promise<SourceUpdateOperationView>
}
```

`SourceUpdaterView` 至少包含：

```ts
interface SourceUpdaterView {
  configuration: {
    enabled: boolean
    repository: string
    channel: { kind: "release" | "branch"; ref?: string }
    automaticCheck: boolean
    automaticApply: boolean
    intervalMinutes: number
    applyPolicy: "when-idle" | "maintenance-window"
  }
  current: {
    version: string | null
    revision: string | null
    builtAt: string | null
    repository: string | null
  }
  candidate: {
    version: string | null
    revision: string
    htmlUrl: string
    changelog: string | null
    verified: boolean
    relation: "behind" | "ahead" | "identical" | "diverged" | "unknown"
  } | null
  executor: {
    connected: boolean
    protocolVersion: number | null
    canPrepare: boolean
    canApply: boolean
    reason: string | null
  }
  operation: SourceUpdateOperationView | null
  githubTokenConfigured: boolean
  packagesTokenConfigured: boolean
  lastCheckedAt: string | null
  nextCheckAt: string | null
  error: { code: string; message: string } | null
}
```

API 错误只返回稳定 code 和脱敏后的操作提示，例如：

- `source_updater_disabled`
- `source_update_authentication_required`
- `source_update_executor_unavailable`
- `source_update_revision_conflict`
- `source_update_diverged`
- `source_update_unverified`
- `source_update_system_busy`
- `source_update_validation_failed`
- `source_update_rollback_failed`

### 5.2 HTTP 路由

建议新建 `apps/backend/src/http/routes/source-updater.ts`：

| 方法   | 路径                                             | 作用                           |
| ------ | ------------------------------------------------ | ------------------------------ |
| `GET`  | `/api/global-config/source-updater`              | 配置、版本、能力和当前操作快照 |
| `POST` | `/api/global-config/source-updater`              | 更新非敏感配置                 |
| `POST` | `/api/global-config/source-updater/github-token` | 写入或删除 GitHub Token        |
| `POST` | `/api/global-config/source-updater/check`        | 立即检查                       |
| `POST` | `/api/global-config/source-updater/prepare`      | 下载并验证固定 revision        |
| `POST` | `/api/global-config/source-updater/apply`        | 进入 drain、切换和重启         |
| `POST` | `/api/global-config/source-updater/rollback`     | 回滚指定失败操作               |

所有写操作必须：

- 要求 WebUI 鉴权已启用；当前“鉴权关闭即所有请求可信”的行为不足以保护更新权限。
- `apply`/`rollback` 要求近期重新输入管理员密码，或使用单独的一次性 elevation token。
- 依赖 `SameSite=Strict` Cookie 的同时加入 CSRF nonce。
- 使用 `expectedCurrentRevision`、`expectedTargetRevision` 和 operation ID 做乐观并发控制。
- 同一时刻只允许一个更新操作；重复请求应返回同一个 operation，而不是启动第二次构建。

`GET /api/global-config` 可包含 updater 摘要，详细和高频状态走独立端点。状态变化通过全局 SSE 广播 `source_update_status`，页面断线后重新读取 snapshot，不能把 SSE 当作唯一事实。

### 5.3 GitHub 客户端

- 请求带固定 `User-Agent`、`Accept: application/vnd.github+json` 和显式 API version。
- 保存 `ETag`，轮询时发送 `If-None-Match`；`304` 只更新时间，不清空现有候选。
- 无 Token 时按 GitHub 公共 API 低频限制运行；配置 Token 后仍遵守 rate-limit header 和 secondary rate limit。
- 每次请求有连接/总超时和 `AbortSignal`。
- Release 模式只接受 published、非 draft、符合通道规则的 manifest。
- branch 模式解析 commit 后调用 Compare；自动应用还要确认目标 revision 的必需 GitHub Actions checks 成功。
- 不把 GitHub 错误响应正文原样返回浏览器或写入日志。
- 下载只允许 GitHub/GHCR 固定 host 和受限 redirect，阻止插件变成任意 URL fetcher。

## 6. Update Worker

### 6.1 协议和权限

Worker 建议作为宿主 systemd 服务运行；Compose 环境也可以使用独立 sidecar。后端通过 Unix socket 或只监听 loopback 的 mTLS/随机 Bearer token 访问它。

Worker 只暴露结构化操作：

```text
GET  /v1/status
POST /v1/operations/check
POST /v1/operations/prepare
POST /v1/operations/apply
POST /v1/operations/rollback
GET  /v1/operations/:id
```

禁止传入 shell、环境变量、任意路径、任意镜像名或任意 Compose service 名。仓库、服务名、状态卷和镜像前缀来自 Worker 启动配置。

不要把原始 Docker socket 暴露给 WebUI 路由逻辑。若 sidecar 必须使用 Docker socket，它应是唯一持有者，并尽量通过受限 socket proxy；拥有原始 socket 等价于宿主 root。

### 6.2 Docker/Compose 执行器（推荐生产路径）

准备阶段可在线完成，不影响当前比赛：

1. 从 GitHub 固定 revision 取得并验证 `update-manifest.json`。
2. 验证 GitHub artifact attestation/provenance 和允许的 workflow/repository。
3. 按 digest 拉取 webui、solver、audit 三个镜像。
4. 检查 OCI label 中 repository/revision/version 与 manifest 一致。
5. 使用临时空状态卷启动候选 WebUI，等待 `/health`，验证返回 revision。
6. 记录 `prepared` 操作；不得把 `latest` 提前指向候选。

应用阶段：

1. 后端进入全局 maintenance：暂停所有 Scheduler 领取新任务，拒绝新 Solver、Father turn 和 Audit run。
2. 等待所有 Project 的 `scheduler.active`、Father 活跃 turn 和 Audit Worker 为空。默认超时后取消更新，不强杀任务。
3. 关闭数据库句柄并让 Worker 获得 drain lease。
4. 对 `.ctf-agent` 做一致性快照；至少覆盖所有 SQLite、JSON、Father session 和 extension active pointer。
5. 把 Compose override/部署指针切到 manifest 中的 digest，并设置统一的 `CTF_AGENT_REVISION`、solver image 和 audit image。
6. 替换 WebUI 容器，等待 healthcheck 和一次真实 snapshot refresh。
7. 成功后提交 active manifest；失败则恢复旧 digest 和必要的状态快照。
8. 保留最近两个 bundle 和操作审计记录。

Compose 本身没有业务级数据库回滚语义，因此不能只依靠 `docker compose up -d`。状态快照、健康验证和旧 digest 都由 Worker 管理。

### 6.3 本地源码执行器

本地部署也不修改开发者当前工作区。Worker 使用 immutable release directory：

```text
/opt/ctf-agent/
├── releases/<revision>/       # git archive/clone + lockfile install + build
├── current -> releases/<revision>
└── previous -> releases/<old-revision>
/var/lib/ctf-agent/.ctf-agent  # 独立持久数据
```

准备阶段在新目录执行仓库规定的校验顺序：

```text
vp install --frozen-lockfile
vp check
vp run typecheck
vp test
vp build
vp run build:sandbox           # Docker/Agent 能力启用时必需
```

通过后才原子切换 `current` symlink，并让 systemd/进程管理器重启。若健康检查失败，切回 `previous`。开发工作区 dirty、ahead 或 diverged 都不会被覆盖。

## 7. 更新状态机

```text
disabled
   └─> idle ──check──> up_to_date
          └──────────> available
                           └─prepare─> preparing ─> prepared
                                                    └─apply─> waiting_for_idle
                                                               └─> draining
                                                                   └─> applying
                                                                       └─> restarting
                                                                           └─> verifying
                                                                               └─> succeeded

任何非终态 ──> failed ──rollback──> rolling_back ──> rolled_back
                   └────────────────────────────────> rollback_failed
```

不变量：

- `preparing` 之前固定 target SHA；后续不能跟随 branch 漂移。
- `applying` 之前必须有通过验证且未过期的 prepared operation。
- `waiting_for_idle` 不清空持久队列，只暂停领取；更新后 Scheduler 按 RunStore 恢复。
- 一个 operation 的日志只能追加，终态不能回到运行态。
- 后端或 Worker 重启后，从 `status.json`/operation journal 恢复；不能凭内存猜测成功。
- Worker 失联时 UI 保留最后事实并显示“执行器离线”，不能把操作标成失败或成功。

## 8. WebUI 设计

入口保持在 `GlobalSettingsPage` 的“插件”Tab，新增 `GitHubSourceUpdaterEditor.tsx`。它是运维控制面，不与模型或 Platform extension 混排成普通开关列表。

建议结构：

```text
GitHub 源码更新                                  [状态 Badge] [启用 Switch]
从受信仓库检查并部署一组一致的 WebUI / Solver / Audit 版本

┌ 当前版本 ────────────────┬ 可用版本 ─────────────────┐
│ 0.1.0                    │ main · a1b2c3d             │
│ 9f31e2a · 2 天前         │ 12 commits · 查看 GitHub   │
└──────────────────────────┴────────────────────────────┘

[检查更新] [准备更新] [应用并重启]

状态轨：检查 → 下载 → 验证 → 等待空闲 → 切换 → 健康检查

仓库（只读/allowlist）  通道  分支
自动检查                间隔
自动应用                维护窗口 / 仅空闲
GitHub Token             [已配置] [替换] [清除]
```

交互要求：

- “检查更新”始终是安全的只读操作。
- “准备更新”明确说明不会重启服务。
- “应用并重启”显示当前活跃 Solver/Father/Audit 数量、预计停机和目标 SHA，并要求二次确认。
- 自动应用开启时，紧邻开关说明“仅在系统空闲和维护窗口内执行”；不能把风险藏在 tooltip。
- branch、未验证、diverged、执行器离线、鉴权关闭、系统繁忙等状态均给出可执行的修复说明。
- operation 运行时禁用冲突按钮，但允许离开页面；重进页面从服务端恢复进度。
- commit、tag、Release 和 changelog 链接只指向配置中受信的 GitHub repository。
- 移动端先显示当前/候选和主要动作，高级策略折叠；所有状态不能只靠颜色表达。

## 9. 与现有系统的具体改动点

### 9.1 构建身份与镜像一致性

新增 `BuildIdentity`，由构建参数生成，不从运行目录猜测：

```ts
interface BuildIdentity {
  version: string | null
  revision: string
  repository: string
  builtAt: string
  bundleSchema: number
}
```

需要替换当前硬编码镜像：

- `apps/backend/src/main.ts` 中 Father Validation 的 `ctf-agent-solver:latest`。
- `apps/backend/src/domain/code-audit-runner.ts` 中 audit/solver 镜像常量。
- Project/Sandbox 创建路径中的 solver image。

所有位置从同一个 revision bundle 解析镜像 digest。`/health` 返回 build identity 和当前 bundle。

### 9.2 全局 maintenance/drain

在 `ControlPlane`/WebUI service 边界新增只读 activity summary 和 maintenance lease：

```ts
interface GlobalActivitySummary {
  activeSolvers: number
  activeFatherTurns: number
  activeAudits: number
  projectsWithAutoScheduling: string[]
}
```

进入 maintenance 后：

- Scheduler `pauseAuto()` 并停止领取 execution queue，但保留 idle/execution 持久状态。
- 新 dispatch、retry、Father send、Audit start 返回 `503 source_update_maintenance`。
- 既有任务默认自然完成；只有管理员另行选择“停止全部”才取消。
- 重启后根据更新 operation 和持久化 Scheduler 意图恢复，而不是无条件开启自动模式。

Run 状态继续以 RunStore 为权威；更新插件不能直接改 SQLite Run 状态。

### 9.3 文件建议

```text
apps/backend/src/domain/build-identity.ts
apps/backend/src/domain/source-updater-config.ts
apps/backend/src/domain/github-source-updater.ts
apps/backend/src/http/routes/source-updater.ts
apps/backend/test/source-updater-config.test.ts
apps/backend/test/source-updater-routes.test.ts
apps/frontend/src/pages/settings/GitHubSourceUpdaterEditor.tsx
apps/frontend/test/github-source-updater.test.ts
packages/update-protocol/                 # backend 与 Worker 的无权限协议类型
apps/updater/                             # 独立执行器；不导入 WebUI HTTP 层
.github/workflows/release.yml
```

`built-in-plugins.json` 可以只记录通用启用状态，也可以由 `source-updater/config.json` 单独作为唯一事实；不要在两个文件重复保存 `enabled`。

## 10. 安全规则

1. **默认关闭**：自动检查可在启用后默认打开，自动应用必须显式开启。
2. **强制鉴权**：鉴权关闭时仍可展示版本，但不能启用、准备、应用或回滚。
3. **最小 GitHub 权限**：公共仓库无需 Token；私有仓库使用 fine-grained read-only Token。
4. **固定供应链**：仓库 allowlist、固定 workflow、固定 revision、digest 镜像、provenance 校验。
5. **不执行用户命令**：WebUI 不能配置 shell、Docker 参数、任意 URL、任意文件路径。
6. **不泄密**：Token 只进 SecretStore；Header、重定向 URL、上游正文和 Worker env 不写 operation 日志。
7. **不扩展 SSRF 面**：GitHub/GHCR origin 固定；所有 redirect 重新校验。
8. **不热改当前进程**：只更新 immutable staging，再由外部执行器原子切换。
9. **不打断比赛**：默认 `when-idle`；超时取消更新，不强杀 Solver、Father 或 Audit。
10. **可恢复**：应用前一致性备份，保留旧 bundle；回滚也需要审计和健康检查。
11. **单飞与幂等**：全局文件锁/Worker lease，operation ID 幂等，expected revision 防止竞态。
12. **日志脱敏与上限**：只记录阶段、SHA、耗时、稳定错误码；输出截断，禁止保存构建环境。

## 11. 测试矩阵

### 单元测试

- 配置 schema、原子持久化、旧版本迁移和未知字段拒绝。
- `owner/repo`、branch/tag、SHA、manifest 和 allowlist 校验。
- ETag/304、rate limit、超时、取消、GitHub 404/403 脱敏。
- compare 的 identical/behind/ahead/diverged 处理，禁止 downgrade。
- SecretStore 快照永不出现 Token。
- 状态机非法跳转、单飞、幂等和 expected revision 冲突。

### 后端行为测试

- `/api/global-config` 和独立 updater snapshot。
- 鉴权关闭或未登录时，所有危险写操作被拒绝。
- re-auth/CSRF、请求体大小和字段级错误。
- Worker 离线、准备失败、系统繁忙、健康失败和回滚失败。
- SSE 断线后重新拉 snapshot 能恢复真实 operation。

### 前端测试

- 当前/候选版本、GitHub 链接和 executor 能力展示。
- 检查、准备、应用、回滚按钮的可用条件。
- 自动应用风险说明和二次确认。
- busy/diverged/unverified/offline/rollback_failed 的修复文案。
- 进度不能只依赖颜色，键盘和移动端操作可达。

### 集成与故障注入

- 临时 Git 仓库或假 GitHub server：快进、ahead、diverged、force-push。
- 三个镜像故意给出不同 revision 时拒绝部署。
- 候选启动失败、health 超时、Worker 在每个阶段崩溃后的恢复。
- drain 期间有 Solver/Father/Audit、新请求和 Scheduler 自动队列。
- SQLite migration 成功、失败及旧版本不兼容时的状态快照回滚。
- Docker Compose 更新使用 digest，回滚后 `/health` 返回旧 revision。

## 12. 分阶段落地

### Phase 0：版本与发布基础

- 定义产品 semver 和 `BuildIdentity`。
- GitHub Actions 在 `vp check → typecheck → test → build` 成功后构建三个同 revision 镜像。
- 发布 SHA/digest manifest 与 provenance。
- 消除运行时 `latest` 硬编码。

### Phase 1：只读 GitHub 检查

- 实现配置、SecretStore、GitHub conditional request、Compare 和 WebUI 版本卡。
- 支持手动/定时检查，不提供应用按钮。
- 当前无 Release 时使用 `main` branch 模式验证完整检查链路。

### Phase 2：手动安全更新

- 实现独立 Worker、prepare、drain、状态快照、digest rollout、health 和 rollback。
- WebUI 提供准备、二次确认应用和操作进度。
- 先支持 Compose，再支持本地 immutable release directory。

### Phase 3：自动应用

- 加入 maintenance window、仅空闲策略、re-auth/elevation、恢复和通知。
- 只有 Release + 必需 checks + provenance 全部通过时默认允许自动应用。
- branch 自动应用继续由部署端显式解锁。

## 13. 验收标准

插件完成时必须同时满足：

- WebUI 能准确显示正在运行的源码 revision，不依赖 `package.json` 猜测。
- 检查操作使用 GitHub ETag，并能区分无更新、落后、领先和分叉。
- 任意 Token 均不会出现在 API、SSE、日志、operation 文件或 Project 数据中。
- 未启用 WebUI 鉴权时无法执行部署变更。
- 活跃 Solver、Father 或 Audit 存在时，默认自动更新只等待或取消，不强制中断。
- WebUI、Solver、Father Validation 和 Audit 始终来自同一 revision bundle。
- 候选健康检查失败可自动恢复旧 digest 和兼容的状态快照。
- backend/Worker 任一方在更新阶段重启后，都能从持久化 operation 恢复而不重复应用。
- 所有公开行为有单元、HTTP、前端与至少一条真实 Compose 故障回滚测试。

## 14. 相关资料

- GitHub Releases API：<https://docs.github.com/en/rest/releases/releases>
- GitHub Compare API：<https://docs.github.com/en/rest/commits/commits#compare-two-commits>
- GitHub REST conditional requests / rate limits：<https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api>
- GitHub artifact attestations：<https://docs.github.com/en/actions/concepts/security/artifact-attestations>
- Docker Compose pull/up：<https://docs.docker.com/reference/cli/docker/compose/pull/>、<https://docs.docker.com/reference/cli/docker/compose/up/>
