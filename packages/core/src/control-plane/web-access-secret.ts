import { createHash } from "node:crypto"

/** web-access 各 provider 的 API key 在全局 SecretStore 中的命名前缀。 */
const WEB_ACCESS_KEY_PREFIX = "CTF_WEBACCESS_KEY_"

/**
 * 计算某 web-access provider（如 "brave"、"gemini"、"searxng"）的
 * SecretStore 键名。镜像 model-pool 的 `CTF_MODEL_API_KEY_<sha256>` 约定，
 * 保证 WebUI 配置服务与 Project 注入共用同一个名字。
 */
export function webAccessSecretName(provider: string): string {
  const digest = createHash("sha256").update(provider).digest("hex")
  return `${WEB_ACCESS_KEY_PREFIX}${digest.slice(0, 32).toUpperCase()}`
}
