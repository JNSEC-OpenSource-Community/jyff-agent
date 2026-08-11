import tailwindcss from "@tailwindcss/vite"
import { defineConfig } from "vite-plus"

export default defineConfig({
  root: "apps/frontend",
  plugins: [...tailwindcss()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  test: {
    include: ["../../packages/**/test/**/*.test.ts", "test/**/*.test.ts"],
    testTimeout: 20_000,
  },
  staged: {
    "*": "vp check --fix",
  },
  lint: { options: { typeAware: true, typeCheck: true } },
  fmt: {
    semi: false,
  },
})
