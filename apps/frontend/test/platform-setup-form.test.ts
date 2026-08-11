// @vitest-environment jsdom
import type { ControlPlaneSetupSnapshot } from "@ctf-agent/core"
import { fireEvent, render, screen } from "@testing-library/react"
import { createElement } from "react"
import { describe, expect, it, vi } from "vite-plus/test"
import { PlatformSetupForm } from "../src/components/platform/PlatformSetupForm.tsx"

const platform: ControlPlaneSetupSnapshot["platforms"][number] = {
  id: "future-platform",
  setup: {
    label: "Future Platform",
    description: "测试插件",
    defaultConfig: { endpoint: "https://ctf.example" },
    fields: [
      {
        key: "endpoint",
        label: "比赛地址",
        type: "url",
        required: true,
      },
    ],
    authStrategies: [
      {
        id: "token",
        label: "Access Token",
        config: { auth: { type: "token" } },
        secrets: [
          {
            name: "FUTURE_TOKEN",
            label: "Token",
            type: "token",
            required: true,
          },
        ],
      },
    ],
  },
}

describe("PlatformSetupForm", () => {
  it("从插件元数据生成配置和 Secret 字段", () => {
    const onConfigChange = vi.fn()
    const onSecretsChange = vi.fn()
    render(
      createElement(PlatformSetupForm, {
        platform,
        strategyId: "token",
        config: { endpoint: "https://ctf.example" },
        secrets: {},
        onStrategyChange: vi.fn(),
        onConfigChange,
        onSecretsChange,
      }),
    )

    fireEvent.change(screen.getByLabelText("比赛地址 *"), {
      target: { value: "https://next.example" },
    })
    fireEvent.change(screen.getByLabelText("Token *"), {
      target: { value: "token-value" },
    })

    expect(onConfigChange).toHaveBeenCalledWith({
      endpoint: "https://next.example",
    })
    expect(onSecretsChange).toHaveBeenCalledWith({
      FUTURE_TOKEN: "token-value",
    })
  })
})
