import { readdir, readFile } from "node:fs/promises"
import { dirname, extname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export interface StaticAsset {
  content: Uint8Array<ArrayBuffer>
  contentType: string
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
}

/** 前端不可用时的兜底页面，保证 /health 之外的核心测试路径不依赖构建产物。 */
const FALLBACK_HTML = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>CTF Agent · Operations</title>
  </head>
  <body>
    <main id="root" class="boot-screen" aria-busy="true">正在载入控制面…</main>
  </body>
</html>`

function contentTypeFor(path: string): string {
  return (
    CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream"
  )
}

/** 递归加载前端构建产物到内存；找不到 dist 时退化为兜底首页。 */
export async function loadStaticAssets(
  frontendDist?: string,
): Promise<Map<string, StaticAsset>> {
  const assets = new Map<string, StaticAsset>()
  const dist =
    frontendDist ??
    process.env.WEBUI_FRONTEND_DIST ??
    resolve(dirname(fileURLToPath(import.meta.url)), "../../../frontend/dist")
  try {
    await collectFiles(dist, assets)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    console.warn(`[webui] 前端产物不存在（${dist}），使用兜底页面`)
  }
  const index = assets.get("/index.html")
  assets.set("/", {
    content: index ? index.content : new TextEncoder().encode(FALLBACK_HTML),
    contentType: "text/html; charset=utf-8",
  })
  return assets
}

async function collectFiles(
  directory: string,
  assets: Map<string, StaticAsset>,
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    const absolute = join(directory, entry.name)
    if (entry.isDirectory()) {
      await collectFiles(absolute, assets)
      continue
    }
    assets.set(`/${relativeRoute(directory, absolute)}`, {
      content: new Uint8Array(await readFile(absolute)),
      contentType: contentTypeFor(absolute),
    })
  }
}

function relativeRoute(base: string, absolute: string): string {
  return absolute.slice(base.length).replaceAll("\\", "/").replace(/^\//, "")
}
