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
    setupFiles: ["./test/setup.ts"],
    include: [
      // Keep the workspace depth explicit: ** also follows pnpm's package
      // symlinks under node_modules and executes dependency tests repeatedly.
      "../../packages/*/test/**/*.test.ts",
      "../../apps/backend/test/**/*.test.ts",
      "test/**/*.test.ts",
    ],
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
