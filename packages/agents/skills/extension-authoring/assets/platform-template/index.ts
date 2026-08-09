import type { PlatformPlugin } from "@ctf-agent/platform"

export const platformPlugin: PlatformPlugin = {
  id: "example-platform",
  config: {
    parse(value) {
      if (!value || typeof value !== "object") throw new Error("Invalid config")
      return value
    },
  },
  async connect() {
    throw new Error("Implement the platform connection")
  },
}

export default platformPlugin
