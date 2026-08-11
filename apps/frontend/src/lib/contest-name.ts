/** 将平台比赛名称转为稳定、可读的 ASCII 路由 ID。 */
export async function contestIdFromName(name: string): Promise<string> {
  const normalized = name.normalize("NFKC")
  if (!/[\u3400-\u9fff]/u.test(normalized)) return normalizeId(normalized)

  // 拼音词库较大，只有输入中文比赛名时才加载。
  const { pinyin } = await import("pinyin-pro")
  return normalizeId(
    pinyin(normalized, {
      toneType: "none",
      type: "string",
      nonZh: "consecutive",
      v: true,
    }),
  )
}

function normalizeId(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
}
