# Upstream Pin — pi-web-access

本目录是 [pi-web-access](https://github.com/nicobailon/pi-web-access) 的 fork，作为纯 Agent 工具库（`createWebAccessTools`）接入 ctf-agent，**不是** Pi TUI 扩展。

- **上游仓库**：https://github.com/nicobailon/pi-web-access
- **固定 commit**：`7bf05f9acc4a61d9ff50927fa8be7ad3f87d77b6`
- **版本**：v0.19.0（`chore: release 0.19.0`，2026-08-08）
- **License**：MIT（见 `LICENSE`、`THIRD_PARTY_NOTICES.md`）

## 已删除（不可在此 fork 中恢复）

下列上游文件未拷入，对应能力被永久移除：

- `curator-server.ts`、`curator-page.ts` — curator 浏览器 UI 与本地 HTTP server。
- `gemini-web.ts` — Gemini Web（浏览器登录态）。
- `gemini-web-config.ts` — `allowBrowserCookies` 及 `PI_ALLOW_BROWSER_COOKIES` / `FEYNMAN_ALLOW_BROWSER_COOKIES` 入口。
- `chrome-cookies.ts` — Chromium cookie 读取。
- `activity.ts` — activity widget / 监控 UI。
- `banner.png`、`pi-web-fetch-demo.mp4` — 资源文件。

`index.ts` 中所有 `pi.registerCommand`（`websearch` / `curator` / `google-account` / `search`）、`pi.registerShortcut`（`curate` / `activity`）、`pi.on("session_*")`、`ctx.ui.*`、`ctx.model`、`ctx.sessionManager`、curator 管线（`startCuratorServer` / `openCuratorBrowser` / `shouldAutoOpenCuratorBrowser` / `closeCurator` / `updateWidget` 等）、`pi.appendEntry` / `pi.sendMessage` 均已删除。

## 已改写

| 文件                     | 改动                                                                                                                                                                                                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `index.ts`               | `export default function (pi: ExtensionAPI)` → `export function createWebAccessTools(config): AgentTool[]`；删除 curator 分支，`web_search` 只保留同步搜索 + 可选 `auto-summary`；`source_check` / `fetch_content` / `get_search_content` 去除第 5 个 `ctx` 参数。 |
| `runtime.ts`（新增）     | `WebAccessRuntime` + `setRuntime` / `getRuntime`，承载闭包注入的配置。                                                                                                                                                                                             |
| `gemini-api.ts`          | `loadConfig().geminiApiKey` → `getRuntime().resolveSecret("gemini")`；移除 `process.env.GEMINI_API_KEY` 兜底。                                                                                                                                                     |
| `gemini-search.ts`       | `extensionContext?: ExtensionContext` → `modelAuth?: ModelAuthResolver`；`searchWithOpenAI` / `searchWithXai` 改用 `getRuntime().modelAuth`。                                                                                                                      |
| `ssrf-protection.ts`     | `loadConfigRoot()` / `loadSsrfConfig()` / `loadFetchContentDomainPolicy()` → `getRuntime().ssrf` + `getRuntime().fetchContent`。SSRF 私网拦截、重定向限制、超时、AbortSignal 保持原样。                                                                            |
| `extract.ts`             | 配置读取改走 `getRuntime()`；GitHub clone 禁用/失败的错误现在正确浮出（上游会静默吞掉后继续走 HTTP）；直接图片改由本地 `resizeImage` 透传（无浏览器 canvas，返回原字节）。                                                                                         |
| `github-extract.ts`      | clone 路径 `/tmp/pi-github-repos` → `getRuntime().githubClonePath`（落 sandbox 可见 workspace）。                                                                                                                                                                  |
| `pdf-extract.ts`         | 输出目录 `os.tmpdir()/pi-web-pdf` → `getRuntime().pdfDir`。                                                                                                                                                                                                        |
| `runtime.ts`（新增）     | `WebAccessRuntime` + `setRuntime` / `getRuntime` / `withRuntime`；runtime 经 **AsyncLocalStorage** 按工具执行上下文隔离，多 Project/run 并发时各自读到自己的配置。                                                                                                 |
| `summary-review.ts`      | `SummaryGenerationContext` 去 `modelRegistry`，改用 `ModelAuthResolver`。                                                                                                                                                                                          |
| `summary-model-scope.ts` | 去文件读取，enabled-patterns 由 runtime 提供。                                                                                                                                                                                                                     |
| 所有 provider 模块       | `loadConfig()` / `getApiKey()` 改用 `getRuntime().resolveSecret(provider)`；移除 `process.env.<PROVIDER>_API_KEY` 兜底。                                                                                                                                           |
| `storage.ts`             | 删除 `restoreFromSession`（依赖 `ctx.sessionManager`）。                                                                                                                                                                                                           |
| `utils.ts`               | 删除 `getWebSearchConfigPath` / `getWebSearchConfigDir` / `resolveCuratorNetworkConfig`。                                                                                                                                                                          |

## 破坏性变更

- **环境变量兜底移除**：上游 provider 兜底 `process.env.<PROVIDER>_API_KEY`，本 fork **只走 `resolveSecret`（宿主 SecretStore）**。env-based 部署需改为通过 WebUI / SecretStore 配置密钥。
- **curator / 浏览器 / cookie 全部禁用**：`workflow: "summary-review"` 视为 `"none"`；默认 `workflow: "none"` 或 `"auto-summary"`（无 TUI）。

## 宿主运行模型（重要）

`web_search` / `fetch_content` / `source_check` 用 Node `fetch` 在 **ctf-agent backend 宿主进程**内执行网络请求，**不在 Docker sandbox 容器内**。Web 出口完全由宿主网络 + SSRF 守卫决定，**与 solver 容器的 `networkMode` 无关**——不要期望 `networkMode: none` 能 gate web 工具。Web 工具是否启用由全局 `enabled` 开关控制。

GitHub clone、PDF 抽取的临时文件落在宿主 challenge-workspace（已 bind-mount 到容器 `/workspace`），solver 通过现有 `read` / `list` 工具读取；`workspaceHostPath` 缺省时这两个分支被禁用并返回明确错误。

## 宿主二进制依赖

- `github-extract.ts` shell out 到宿主 `git`（或 `gh`）。
- `youtube-extract.ts` / `video-extract.ts` 需 `ffmpeg` / `ffprobe`（可选）。
- `pdf-extract.ts` 用 `unpdf`（纯 JS，无外部二进制）。

backend 宿主需具备 `git`；其余为可选能力。

## 重新 pin

更新上游时：在本仓库外 `git clone` pi-web-access → 对比 commit → 拷贝 KEEP 文件 → 重新应用本表的 ADAPT 改写 → 更新本文件 commit 与版本。保持文件边界与上游一致以便产出可读 diff。
