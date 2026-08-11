# 平台插件与 Validation Gate

平台插件把外部 CTF 服务映射成统一的题目能力。接口、内置适配器和扩展验证分别位于 `packages/platform/src/`、`packages/core/src/extensions/` 和 `apps/backend/src/http/routes/father.ts`。

## 1. 统一契约

### `PlatformPlugin`

定义于 `packages/platform/src/index.ts`：

```ts
interface PlatformPlugin {
  readonly id: string
  readonly config: PlatformConfig
  readonly setup?: PlatformSetupDescriptor
  connect(options: PlatformConnectOptions): Promise<PlatformProject>
}
```

`config.parse()` 负责拒绝未知字段、校验 URL 和非敏感配置。`connect()` 接收 Project ID、名称、解析 Secret 的函数，并返回 `PlatformProject`。

### `PlatformProject`

平台连接至少提供：

- overview 和刷新
- 题目列表及公告列表
- 绑定题目并读取详情、附件
- Flag 提交，业务拒绝返回 `rejected`，不把普通错误 Flag 当作异常
- 远程环境列举、状态和销毁
- `close()`，连接部分初始化失败时也应可安全清理

Agent 永远不能拿到完整 `PlatformProject`。`Project.bindChallenge()` 只向 Solver 传递不带题目 ID 参数的 `ChallengeCapability`，因此 Agent 只能操作已经绑定的当前题目。

### `PlatformSetupDescriptor`

供 WebUI 静态生成配置表单：

- `fields` 只允许 `text`、`url`、`integer`。
- `authStrategies` 声明 Secret 名称、类型和是否必需。
- Secret 值只进入 SecretStore，setup 和 Project config 只保存 Secret 名称及非敏感配置。
- `parsePlatformSetupDescriptor()` 拒绝未知字段、重复 ID、非法字段名和非法 Secret 名称。

## 2. 内置平台

内置平台在 `apps/backend/src/main.ts` 中直接注册，不经过 `extension.json`：

| 平台  | 代码                             | 认证                                      | 能力                                             |
| ----- | -------------------------------- | ----------------------------------------- | ------------------------------------------------ |
| CTFd  | `packages/platform/src/ctfd.ts`  | Access Token，默认 Secret 名 `CTFD_TOKEN` | REST API `/api/v1/`、题目、公告、附件、Flag 提交 |
| GZCTF | `packages/platform/src/gzctf.ts` | 用户名/密码或 `GZCTF_Token` Cookie        | 题目、公告、附件、Flag 提交、远程环境生命周期    |

两种配置都会拒绝带凭据、query 或 fragment 的 `baseUrl`。CTFd 将网络、限流和 HTTP 5xx 标记为可重试；GZCTF 还实现请求重试、短期缓存、登录恢复、提交轮询和 API 数据加密。GZCTF 的 X25519 + SHA-256 + AES-256-GCM 请求封装由 `encryptGZCTFApiData()` 实现。

内置插件不能被扩展覆盖：`PlatformPluginRegistry.registerExtension()` 会拒绝 ID `ctfd` 和 `gzctf`。

## 3. 扩展目录和 manifest

Father 生成的候选目录通常是：

```text
<father-session>/workspace/output/
├── extension.json
├── index.ts              # 或其他目录内 .js/.mjs/.ts 入口
└── ...                   # fixture、辅助模块等
```

`extension.json` 的实际要求由 `packages/core/src/extensions/extension-store.ts` 的 `parseManifest()` 执行：

```json
{
  "schemaVersion": 2,
  "id": "example-ctf",
  "name": "Example CTF",
  "version": "1.0.0",
  "entry": "index.ts",
  "setup": {
    "label": "连接配置",
    "description": "Example CTF 连接参数",
    "defaultConfig": { "baseUrl": "https://ctf.example" },
    "fields": [{ "key": "baseUrl", "label": "Base URL", "type": "url", "required": true }],
    "authStrategies": []
  }
}
```

约束如下：

- 只支持 `schemaVersion: 2`。
- `id` 为小写字母、数字和连字符组成的有效 ID，不能使用 `ctfd` 或 `gzctf`。
- `version` 必须是三段式 semver。
- `entry` 必须是候选目录内的 `.js`、`.mjs` 或 `.ts` 文件，禁止绝对路径、`..` 和 symlink。
- 候选最多 200 个文件，总大小最多 2 MiB。
- 扩展候选必须声明静态 `setup`；入口导出 `platformPlugin` 或默认导出的插件对象。
- 入口导出的 `id` 和 `setup` 必须分别与 manifest 完全一致。

setup fingerprint 是对静态 setup 的稳定 JSON SHA-256。表单字段变化后 fingerprint 变化，旧的验证配置和报告不能继续复用。

## 4. Validation Gate

Father 提交 `father_request_test_access` 后，WebUI 从 setup 构造测试表单。`POST /api/father/sessions/:sessionId/validate` 保存测试配置，然后调用 `PlatformExtensionStore.validate()`。

### 4.1 执行边界

验证在短生命周期 Docker sandbox 中运行：

- `privileged: false`
- `networkMode: bridge`
- 2 CPU、1 GiB 内存/交换、256 PIDs、2 GiB 可写层
- 最长 5 分钟

运行入口为复制到 `.father-runtime/validation-runner.ts` 的独立 runner。它在容器内导入候选入口，验证 manifest 与导出对象一致，再调用 `validatePlatformPlugin()`。主进程在 Gate 通过前不会导入候选代码。

### 4.2 检查项

必需的只读检查：

1. `config.parse`
2. `plugin.connect`
3. `project.getOverview`
4. `project.refresh`
5. 连续两次 `project.listChallenges`，检查题目 ID、分值和结果稳定性
6. `project.listAnnouncements`，检查公告 ID 和时间
7. `project.close`

如果 profile 指定题目，还会检查 `bindChallenge` 和 `challenge.getInfo`，包括详情 ID、附件 ID。该检查是条件性的，不是所有插件的最低 Gate 要求。

可选变更检查：

- 提供 `mutations.invalidFlag` 时提交错误 Flag，期望返回 `rejected`。
- 同时提供 `expected.environmentChallengeId` 和 `testEnvironmentLifecycle: true` 时，检查 `start → status → destroy`。

报告中的错误会截断并通过 `redactReport()` 替换 profile 中的 Secret。报告携带 plugin ID、revision、content hash、harness version、profile fingerprint、Father session ID、检查结果、能力结果和 cleanup 结果。

### 4.3 验证等级

| 等级                 | 条件                                         | 作用                               |
| -------------------- | -------------------------------------------- | ---------------------------------- |
| `failed`             | 任意必需检查失败或连接未闭合                 | 不可安装                           |
| `read_only_verified` | 所有只读检查通过，未启用或未通过变更能力     | 可安装；表示 Gate 只验证了只读能力 |
| `fully_verified`     | 只读检查和已启用的 Flag/环境变更检查全部通过 | 可安装完整平台能力                 |

候选内容、setup、profile 或 Father session 发生变化，都必须重新验证。验证失败时，`FatherSessionManager.notifyValidation()` 将结构化报告发送回当前 Father session，Agent 可根据失败检查修复并再次请求 Gate。

## 5. 安装与 revision

WebUI 只有在 Gate 状态为 `ready` 时允许调用 `POST /api/father/sessions/:sessionId/activate`。`PlatformExtensionStore.activate()` 再次校验：

1. 报告等级为 `read_only_verified` 或 `fully_verified`。
2. 报告的 `authorSessionId` 与当前 session 相同。
3. `revision` 等于 content hash 前 16 位。
4. 当前候选 content hash 与报告一致。
5. manifest ID 与报告 plugin ID 一致。

通过后，候选会复制到：

```text
<root>/.ctf-agent/extensions/<plugin-id>/
├── revisions/<revision>/
│   ├── extension.json
│   ├── validation-report.json
│   └── author.json
└── active.json
```

之后加载 revision、注册 `PlatformPluginRegistry` 并写入 active 指针。更新插件不会覆盖已有 revision；启动时 `loadInstalled()` 只加载 active 指针指向的已验证 revision。安装请求本身就是 WebUI 的明确用户动作，服务端不会在验证完成后自动激活。

## 6. 代码位置与预期效果

| 代码                                                        | 作用和预期效果                                               |
| ----------------------------------------------------------- | ------------------------------------------------------------ |
| `packages/platform/src/index.ts`                            | 契约、setup 解析和通用错误分类；平台实现只依赖这些接口       |
| `packages/platform/src/ctfd.ts`                             | CTFd 配置、HTTP client、题目/附件/公告/提交映射              |
| `packages/platform/src/gzctf.ts`                            | GZCTF 认证、加密、重试、题目和远程环境映射                   |
| `packages/platform/src/registry.ts`                         | 内置和扩展插件注册；禁止覆盖内置 ID                          |
| `packages/platform/src/validation.ts`                       | 只读/变更能力检查和报告等级计算                              |
| `packages/core/src/extensions/extension-store.ts`           | 候选检查、Docker Gate、报告脱敏、revision 复制和激活         |
| `packages/core/src/extensions/validation-runner.ts`         | 容器内导入候选并调用平台验证器                               |
| `packages/core/src/father/father-manager.ts`                | Father session、临时 sandbox、workspace、Gate 状态和实时事件 |
| `apps/backend/src/http/routes/father.ts`                    | 候选描述、配置保存、验证、激活和 workspace API               |
| `packages/platform/test/`、`packages/core/test/extensions/` | 平台契约、Gate、hash 变化、报告脱敏和 revision 行为测试      |

新增平台适配器时，先实现 `PlatformPlugin` 和 `PlatformProject`，再补配置解析、setup、凭据命名、错误重试语义和测试。不要在 Agent 或 WebUI 中直接写平台特定 API。
