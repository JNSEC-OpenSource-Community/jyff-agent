# Platform plugins

Projects select a platform adapter through the WebUI or configuration. The control plane persists
the first/legacy project in `.ctf-agent/project-config.json` and additional projects below
`.ctf-agent/projects/<project-hash>/project-config.json`; `.pi/ctf-config.json` remains a read-only
legacy fallback. Each plugin parses its own `config` object. Credentials are referenced by secret
name and never persisted in the project configuration.

The WebUI renders both the new-contest and contest-settings forms from each plugin's `setup`
descriptor. Platform and authentication strategy selectors are searchable comboboxes; config and
secret fields come from `fields` and `authStrategies`, so adding a plugin does not require a
platform-specific React form. The UI can test a temporary connection before replacing the selected
Project runtime. Secrets entered there are stored in
`.ctf-agent/secrets.json` with service-only file permissions and a key derived from both the Project
ID and plugin secret name, so multiple Projects can use different platform accounts. Legacy
unscoped keys remain a read-only fallback. The runtime resolves credentials only from this Secret
Store; environment variables are not a credential fallback.

## CTFd

```json
{
  "version": 1,
  "project": { "id": "demo", "name": "CTFd Demo" },
  "platform": {
    "plugin": "ctfd",
    "config": {
      "baseUrl": "https://demo.ctfd.io",
      "tokenSecret": "CTFD_TOKEN"
    }
  },
  "sandbox": {
    "image": "ctf-agent-solver:latest",
    "privileged": false,
    "networkMode": "bridge"
  }
}
```

Enter `CTFD_TOKEN` in the WebUI. The adapter uses CTFd's official `Token` authorization
scheme and supports challenge listing/detail, signed attachment downloads, notifications, and flag
attempts. Core CTFd has no standard per-player container lifecycle API, so this adapter does not
invent one. CTFd notification types are not stable enough to classify at the adapter boundary, so
notifications are emitted with `kind: "unknown"` for Core's conservative classifier.

## GZCTF

```json
{
  "version": 1,
  "project": { "id": "gz-review", "name": "GZCTF Review" },
  "platform": {
    "plugin": "gzctf",
    "config": {
      "baseUrl": "https://gz.imxbt.cn",
      "gameId": 36,
      "auth": {
        "type": "password",
        "usernameSecret": "GZCTF_USERNAME",
        "passwordSecret": "GZCTF_PASSWORD"
      }
    }
  },
  "sandbox": {
    "image": "ctf-agent-solver:latest",
    "privileged": false,
    "networkMode": "bridge"
  }
}
```

GZCTF's player APIs use the ASP.NET Identity `GZCTF_Token` Cookie, not its administrator API token.
The adapter logs in with the named username/password secrets, preserves the Cookie, and applies the
same X25519 + SHA-256 + AES-256-GCM encryption as the official web client whenever the server
publishes `apiPublicKey`.

If automated login is blocked by CAPTCHA, log in with a browser and select Cookie authentication:

```json
{
  "auth": { "type": "cookie", "cookieSecret": "GZCTF_COOKIE" }
}
```

`GZCTF_COOKIE` may contain the Cookie value alone or `GZCTF_Token=<value>`. The account must already
belong to a team participating in the configured game. The adapter supports challenge metadata,
attachments, asynchronous flag judgement, and native start/status/destroy container operations.
GZCTF notice types are normalized without matching challenges: `FirstBlood`, `SecondBlood`, and
`ThirdBlood` become `solve_broadcast`; `NewHint` becomes `hint`; `NewChallenge` becomes
`new_challenge`; the original value remains in `rawType` for diagnostics.

## Announcement data boundary

`Announcement.kind` is an optional normalized platform fact (`normal`, `hint`, `new_challenge`,
`solve_broadcast`, or `unknown`). Platform adapters do not decide which challenge an announcement
belongs to. Core first filters explicit solve broadcasts and conservative title/action patterns,
then performs deterministic NFKC/case/whitespace-normalized full-title or tokenized challenge-ID
matching. Common first/second/third-blood broadcasts and new-challenge notices are discarded before
manual review, leaving only hints or changes that may affect solving. Very short titles require
quoting or brackets, and duplicate normalized titles remain
ambiguous matches rather than being silently assigned to one challenge.
Remote-environment enumeration includes instances observed by the current plugin process because
GZCTF exposes challenge-scoped status but no player-wide instance-list endpoint.

## Validation

All plugin configs reject unknown keys, plaintext credentials, unsupported URL schemes, and invalid
timeouts/IDs. Network, authentication, permission, rate-limit, HTTP, and response-protocol failures
are surfaced as typed adapter errors. Expected business results such as a wrong flag are returned as
`FlagSubmission` values rather than thrown as process errors.
# Clanker Father 扩展与 Validation Gate

WebUI 的全局 **Clanker Father** 用于编写新的平台适配插件。每个 Session 保存独立 Pi JSONL、作者、模型、skill revision 与 Docker workspace；完成后的 Session 只读保留，便于追溯插件问题。

Father 首页只显示历史 Session 和“新建会话”。新 Session 使用随机临时名称并立即打开聊天，插件 ID、正式名称及创建/修复任务由 Father 在理解需求后通过结构化工具声明。候选准备完成时 Father 发出验证请求；对应工具完成事件会刷新 Session 并立即打开 Gate Dialog，关闭后可从会话页的测试入口再次打开。

Father 只能在其 workspace 中产出候选目录 `output/`，不能修改控制面源码。v2 最小候选明确是两个文件：schema v2 `extension.json` 加上由其 `entry` 指向的自包含 TypeScript 入口；不能只提供 `.ts`，因为 WebUI 必须在不执行候选代码的前提下从 `extension.json.setup` 生成配置表单。加载器也接受 `.js`/`.mjs` 入口，候选可包含辅助文档等额外普通文件，但不得覆盖 `ctfd`、`gzctf`、不得包含 symlink，并受 200 个文件与 2 MiB 总体积限制。Validation Gate 会校验 manifest setup 与插件导出的 setup 一致。

安装前 Father 通过 `father_request_test_access` 请求测试站配置和登录凭证。Gate 直接调用生产使用的 `PlatformPlugin` 契约，包括连接、概览、稳定题目列表、公告、题目详情，以及用户明确启用的错误 flag 和环境生命周期测试。未批准候选只在短生命周期 Docker sandbox 中加载，配置和密钥通过 stdin 交给 runner，不写入 workspace、JSONL 或报告。报告绑定候选内容哈希、测试配置指纹和 Father Session；候选发生任何变化后旧报告立即失效。通过只读或完整验证也不会自动安装，仍需用户点击“批准并安装此 Revision”。已安装 revision 以不可变目录保存，并在进程启动时重新注册。

测试表单来自候选 manifest 中的静态 `PlatformSetupDescriptor`，与创建比赛共用 `PlatformSetupForm`。普通配置按 Session 和 setup schema fingerprint 保存，密钥进入 Father 专用 Secret Store 命名空间；schema 未变化时 Father 后续请求会自动复用并验证，字段发生变化时要求用户重新确认。验证结果以结构化消息返回同一 Father 对话。删除 Session 时对应测试配置与密钥一并清理。会话页提供完整 workspace 文件树；普通文件可逐项下载，白名单内的有效 UTF-8 代码、文档和 Markdown 可直接预览，沿用题目 workspace 的 2,000 项、256 KiB 与路径 containment 限制。

测试密钥只用于当次验证，不写入报告；报告只保存密钥字段名。Father Docker 使用 bridge 网络且不挂载 Docker socket 或宿主源码，宿主内网隔离由部署时的 Docker 网络策略负责。
