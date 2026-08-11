import type { PlatformPlugin, PlatformSetupDescriptor } from "@ctf-agent/platform"

const setup = {
  label: "Example Platform",
  description: "Connect to an Example Platform contest.",
  defaultConfig: {
    baseUrl: "https://example.invalid",
    auth: { type: "token" },
  },
  fields: [
    {
      key: "baseUrl",
      label: "Site URL",
      type: "url",
      required: true,
      placeholder: "https://ctf.example.com",
    },
  ],
  authStrategies: [
    {
      id: "token",
      label: "Access token",
      config: { auth: { type: "token" } },
      secrets: [
        {
          name: "EXAMPLE_TOKEN",
          label: "Access token",
          type: "token",
          required: true,
        },
      ],
    },
  ],
} satisfies PlatformSetupDescriptor

export const platformPlugin: PlatformPlugin = {
  id: "example-platform",
  setup,
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
