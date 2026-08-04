import { webcrypto } from "node:crypto"

const X25519_PUBLIC_KEY_BYTES = 32
const NONCE_BYTES = 12

/** Implements GZCTF's X25519 + SHA-256 + AES-256-GCM request encryption. */
export async function encryptGZCTFApiData(plainText: string, publicKey?: string | null): Promise<string> {
  if (!publicKey) return plainText
  if (plainText.length === 0) throw new Error("GZCTF 加密内容不能为空")

  let recipientBytes: Uint8Array
  try {
    recipientBytes = Buffer.from(publicKey, "base64")
  } catch (error) {
    throw new Error("GZCTF API 公钥不是有效的 Base64", { cause: error })
  }
  if (recipientBytes.byteLength !== X25519_PUBLIC_KEY_BYTES) throw new Error("GZCTF API 公钥长度无效")

  try {
    const recipientKey = await webcrypto.subtle.importKey("raw", recipientBytes, "X25519", false, [])
    const ephemeral = await webcrypto.subtle.generateKey("X25519", true, ["deriveBits"]) as webcrypto.CryptoKeyPair
    const shared = await webcrypto.subtle.deriveBits({ name: "X25519", public: recipientKey }, ephemeral.privateKey, 256)
    const aesBytes = await webcrypto.subtle.digest("SHA-256", shared)
    const aesKey = await webcrypto.subtle.importKey("raw", aesBytes, { name: "AES-GCM", length: 256 }, false, ["encrypt"])
    const nonce = webcrypto.getRandomValues(new Uint8Array(NONCE_BYTES))
    const ciphertext = new Uint8Array(await webcrypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce, tagLength: 128 }, aesKey, new TextEncoder().encode(plainText),
    ))
    const ephemeralPublic = new Uint8Array(await webcrypto.subtle.exportKey("raw", ephemeral.publicKey))
    return Buffer.concat([ephemeralPublic, nonce, ciphertext]).toString("base64")
  } catch (error) {
    throw new Error("无法按 GZCTF 协议加密 API 数据", { cause: error })
  }
}
