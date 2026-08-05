import { fileURLToPath } from "node:url"
import { build } from "esbuild"

await build({
  entryPoints: [
    fileURLToPath(new URL("../src/client/app.tsx", import.meta.url)),
  ],
  outfile: fileURLToPath(new URL("../src/client/app.js", import.meta.url)),
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["es2022"],
  jsx: "automatic",
  sourcemap: false,
  minify: true,
  legalComments: "none",
})
