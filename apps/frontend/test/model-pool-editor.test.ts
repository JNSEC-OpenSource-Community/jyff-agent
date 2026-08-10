// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { createElement } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { modelPoolEntryId } from "../src/lib/model-pool.ts"
import { ModelPoolEditor } from "../src/pages/settings/ModelPoolEditor.tsx"
import type {
  ModelAuthenticationView,
  ModelConfigurationView,
} from "../src/types.ts"

const configuration: ModelConfigurationView = {
  models: [
    {
      id: "solver",
      provider: "custom-gateway",
      modelId: "model-a",
      contextWindow: 128_000,
      thinkingEnabled: true,
      reasoningEffort: "medium",
      passthroughThinking: false,
      supportedThinkingLevels: ["off", "medium"],
      configured: true,
    },
  ],
  customProviders: [
    {
      id: "custom-gateway",
      name: "Gateway",
      api: "openai-completions",
      baseUrl: "https://models.example.test/v1",
      apiKeyConfigured: true,
    },
  ],
  solverModelId: "solver",
  tldrModelId: "solver",
  fatherModelId: "solver",
  subagentModels: {},
  supportedThinkingLevels: ["off", "medium"],
  configured: true,
}

const authentication: ModelAuthenticationView = {
  importPath: "/auth.json",
  importFileAvailable: false,
  providers: [],
}

describe("模型池自定义供应商模型选择", () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("发现模型后用 Combobox 代替输入框", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(
        async () =>
          new Response(JSON.stringify({ models: ["model-a", "model-b"] }), {
            headers: { "content-type": "application/json" },
          }),
      ),
    )

    render(
      createElement(ModelPoolEditor, {
        configuration,
        authentication,
        onSaved: () => undefined,
      }),
    )

    await waitFor(() => {
      expect(screen.getByLabelText("模型 ID").getAttribute("role")).toBe(
        "combobox",
      )
    })
  })

  it("模型发现失败时保留手工输入框", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ error: "unavailable" }), { status: 502 }),
    )
    vi.stubGlobal("fetch", fetchMock)

    render(
      createElement(ModelPoolEditor, {
        configuration,
        authentication,
        onSaved: () => undefined,
      }),
    )

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    expect(screen.getByPlaceholderText("输入兼容端点的模型 ID")).toBeTruthy()
  })

  it("新模型使用 Provider、模型和推理档位生成 ID", () => {
    expect(
      modelPoolEntryId({
        provider: "openai",
        modelId: "gpt-5.4",
        thinkingEnabled: true,
        reasoningEffort: "high",
      }),
    ).toBe("openai/gpt-5.4@high")
    expect(
      modelPoolEntryId({
        provider: "openai",
        modelId: "gpt-5.4",
        thinkingEnabled: false,
        reasoningEffort: "high",
      }),
    ).toBe("openai/gpt-5.4@off")
  })

  it("添加新模型时不再生成 m-N ID", () => {
    render(
      createElement(ModelPoolEditor, {
        configuration: { ...configuration, customProviders: [] },
        authentication: {
          ...authentication,
          providers: [
            {
              id: "openai",
              name: "OpenAI",
              description: "OpenAI API",
              configured: true,
              credentialType: "api_key",
              methods: [],
              models: [
                {
                  id: "gpt-5.4",
                  name: "GPT-5.4",
                  contextWindow: 400_000,
                  reasoning: true,
                },
              ],
            },
          ],
        },
        onSaved: () => undefined,
      }),
    )

    fireEvent.click(screen.getByRole("button", { name: "添加" }))
    const ids = screen.getAllByLabelText<HTMLInputElement>("模型配置 ID")
    expect(ids.at(-1)?.value).toBe("openai/gpt-5.4@medium")
    expect(ids.at(-1)?.readOnly).toBe(true)
  })
})
