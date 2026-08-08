import { pinyin } from "pinyin-pro"

/** 将平台比赛名称转为稳定、可读的 ASCII 路由 ID。 */
export function contestIdFromName(name: string): string {
  return pinyin(name.normalize("NFKC"), {
    toneType: "none",
    type: "string",
    nonZh: "consecutive",
    v: true,
  })
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
}
