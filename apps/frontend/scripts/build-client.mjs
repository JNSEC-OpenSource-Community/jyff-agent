import { copyFile, mkdir } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"

const frontendDir = fileURLToPath(new URL("..", import.meta.url))

await mkdir(new URL("../dist/", import.meta.url), { recursive: true })
await build({
  entryPoints: [fileURLToPath(new URL("../src/main.tsx", import.meta.url))],
  outfile: fileURLToPath(new URL("../dist/app.js", import.meta.url)),
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["es2022"],
  jsx: "automatic",
  sourcemap: false,
  minify: true,
  legalComments: "none",
})
await copyFile(
  fileURLToPath(new URL("../index.html", import.meta.url)),
  fileURLToPath(new URL("../dist/index.html", import.meta.url)),
)
console.log(`frontend built → ${frontendDir}dist/`)
