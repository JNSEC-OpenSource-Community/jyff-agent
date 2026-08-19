/**
 * ShellPoop API 密钥在全局 SecretStore 中的命名。
 *
 * ShellPoop 服务通过 `SHELLPOOP_API_KEY` 启用可选认证；Agent 侧需要把该密钥
 * 存进全局 SecretStore，并让 WebUI 配置服务与 Project 注入共用同一个名字，
 * 因此与 [[webAccessSecretName]] 一样放在 core，两端统一引用。
 *
 * 单个服务固定一个键，无需像 provider 那样做 sha256 哈希。
 */
const SHELLPOOP_API_KEY_NAME = "CTF_SHELLPOOP_API_KEY"

/** ShellPoop 服务 API 密钥的 SecretStore 键名。 */
export function shellpoopApiKeySecretName(): string {
  return SHELLPOOP_API_KEY_NAME
}
