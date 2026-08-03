// examples/mock-ctf/platform-env.ts —— 平台远程模式的 env 覆盖与运行期配置注入
// 双模式:由 .pi/ctf-config.json 的 contest.platform 决定插件(mock/remote)。
// Project.open 不支持外部注入 config(内部从 .pi/ctf-config.json 读取 platform.config),
// 因此 remote 模式采取接线方式 B:把 env 覆盖后的 platform.config 临时写回文件再 open,
// open 结束后立即恢复原内容;文件内 token 保持占位符 `__PLACEHOLDER__`,真实 token 仅临时落盘。
// 并发加固:.pi/ctf-config.json 是 git 跟踪文件,webui 与 run-moe 可能同时写回;
// 恢复守卫只在文件内容仍是自己写回的内容时才恢复,且恢复目标统一回"占位状态"
// (启动快照若已含他人真实 token,归一化为占位符再写回),保证进程退出后文件永不残留真实 token。
import { readFile, writeFile } from "node:fs/promises"

export interface PlatformConfig {
  baseUrl: string
  token: string
  name?: string
}

// 读 process.env.CTF_PLATFORM_BASE_URL / CTF_PLATFORM_TOKEN,有值则覆盖配置文件中的对应项。
// overrides 优先(WebUI 场景由 PersistentModelEnvironment.platformToken() 提供,env 兜底)。
export function resolvePlatformConfig(
  base: PlatformConfig,
  overrides: { token?: string; baseUrl?: string } = {},
): PlatformConfig {
  const baseUrl = overrides.baseUrl ?? process.env.CTF_PLATFORM_BASE_URL?.trim()
  const token = overrides.token ?? process.env.CTF_PLATFORM_TOKEN?.trim()
  const resolved: PlatformConfig = {
    baseUrl: baseUrl ?? base.baseUrl,
    token: token ?? base.token,
    ...(base.name ? { name: base.name } : {}),
  }
  if (resolved.token == null || resolved.token === "" || resolved.token === "__PLACEHOLDER__") {
    console.error("未设置平台 token:请在 .env 填入 CTF_PLATFORM_TOKEN(服务器 token 从服务器 /root/ctf-platform-data/token 获取)。")
    process.exit(1)
  }
  if (resolved.baseUrl == null || resolved.baseUrl === "") {
    console.error("未设置平台 baseUrl:请在 .env 或配置中填入 CTF_PLATFORM_BASE_URL。")
    process.exit(1)
  }
  return resolved
}

/**
 * 运行期配置覆盖(接线方式 B):仅当配置文件声明 remote 平台时,把 env 覆盖后的
 * platform.config 写回 .pi/ctf-config.json 供 Project.open 读取;run 完成后恢复原文件。
 * mock 模式不写文件、不校验 token(占位/缺失 token 只在 remote 模式报错)。
 * 若 run 抛错,finally 仍恢复原文件。
 */
export async function withPlatformConfigOverride<T>(
  configPath: string,
  run: () => Promise<T>,
  overrides: { token?: string; baseUrl?: string } = {},
): Promise<T> {
  const original = await readFile(configPath, "utf8")
  const raw = JSON.parse(original) as {
    contest?: { platform?: string }
    platform?: { config?: PlatformConfig }
  }
  if (raw.contest?.platform !== "remote") return run()
  raw.platform ??= {}
  // 额外字段(challenges 等)经展开保留;token/baseUrl 以 overrides → env → 配置的顺序取。
  raw.platform.config = {
    ...raw.platform.config,
    ...resolvePlatformConfig(raw.platform.config ?? { baseUrl: "", token: "" }, overrides),
  }
  const written = JSON.stringify(raw, null, 2)
  await writeFile(configPath, written, { mode: 0o600 })
  try {
    return await run()
  } finally {
    await restoreIfMine(configPath, written, original)
  }
}

/**
 * 并发恢复守卫:仅当文件内容仍是自己写回的内容时才恢复,避免覆盖并发进程的写回;
 * 恢复目标经 placeholderState 归一化——启动快照即使已含他人真实 token(并发窗口内
 * 进入,original 捕获了他人写回),也不会把 token 固化回 git 跟踪文件。
 */
async function restoreIfMine(configPath: string, written: string, original: string): Promise<void> {
  let current: string
  try {
    current = await readFile(configPath, "utf8")
  } catch {
    return // 文件已被外部删除/替换,不恢复
  }
  if (current !== written) return // 已被他人覆盖,跳过恢复
  await writeFile(configPath, placeholderState(original), { mode: 0o600 })
}

// 把配置文本中的 token 归一化为占位符;已是占位/空/缺失则原样返回(保持字节不变)。
function placeholderState(configText: string): string {
  const raw = JSON.parse(configText) as { platform?: { config?: Record<string, unknown> } }
  const token = raw.platform?.config?.token
  if (token === undefined || token === "" || token === "__PLACEHOLDER__") return configText
  raw.platform ??= {}
  raw.platform.config ??= {}
  raw.platform.config.token = "__PLACEHOLDER__"
  return JSON.stringify(raw, null, 2)
}
