import { Icon } from "@iconify/react"
import { useState } from "react"
import {
  Button,
  Card,
  Checkbox,
  ErrorNotice,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/index.ts"
import { apiMutation } from "../../lib/api.ts"
import { errorMessage } from "../../lib/format.ts"
import type {
  ModelAuthenticationView,
  ModelConfigurationUpdate,
  ModelConfigurationView,
  ModelPoolEntryUpdate,
} from "../../types.ts"

interface EditableModel extends ModelPoolEntryUpdate {
  uiKey: string
  apiKeyConfigured: boolean
  supportedThinkingLevels: string[]
}

function editableModel(
  model: ModelConfigurationView["models"][number],
): EditableModel {
  return {
    uiKey: crypto.randomUUID(),
    id: model.id,
    provider: model.provider,
    modelId: model.modelId,
    baseUrl: model.baseUrl,
    contextWindow: model.contextWindow,
    thinkingEnabled: model.thinkingEnabled,
    reasoningEffort: model.reasoningEffort,
    passthroughThinking: model.passthroughThinking,
    apiKeyConfigured: model.apiKeyConfigured,
    supportedThinkingLevels: model.supportedThinkingLevels,
  }
}

export function ModelPoolEditor({
  configuration,
  authentication,
  onSaved,
}: {
  configuration: ModelConfigurationView
  authentication: ModelAuthenticationView
  onSaved(next: ModelConfigurationView): void
}): React.ReactElement {
  const [models, setModels] = useState<EditableModel[]>(
    configuration.models.map(editableModel),
  )
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)

  function update(index: number, patch: Partial<EditableModel>): void {
    setModels((current) =>
      current.map((model, candidate) =>
        candidate === index ? { ...model, ...patch } : model,
      ),
    )
  }

  function addModel(): void {
    const provider = authentication.providers[0]
    const suggested = provider?.models[0]
    setModels((current) => [
      ...current,
      {
        uiKey: crypto.randomUUID(),
        id: `model-${current.length + 1}`,
        provider: provider?.id ?? "openai",
        modelId: suggested?.id ?? "",
        baseUrl: "",
        contextWindow: suggested?.contextWindow ?? 128_000,
        thinkingEnabled: suggested?.reasoning ?? true,
        reasoningEffort: suggested?.reasoning ? "medium" : "off",
        passthroughThinking: false,
        apiKeyConfigured: false,
        supportedThinkingLevels: suggested?.reasoning
          ? ["off", "low", "medium", "high"]
          : ["off"],
      },
    ])
  }

  async function save(): Promise<void> {
    setBusy(true)
    setError("")
    try {
      const payload: ModelConfigurationUpdate = {
        models: models.map(
          ({
            uiKey: _,
            apiKeyConfigured: __,
            supportedThinkingLevels: ___,
            ...model
          }) => model,
        ),
        solverModelId: configuration.solverModelId,
        tldrModelId: configuration.tldrModelId,
        subagentModels: configuration.subagentModels,
      }
      const result = await apiMutation<{
        configuration: ModelConfigurationView
      }>("/api/model-config", "POST", payload)
      setModels(result.configuration.models.map(editableModel))
      onSaved(result.configuration)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="settings-stack">
      {error ? <ErrorNotice message={error} /> : null}
      {models.map((model, index) => {
        const provider = authentication.providers.find(
          (candidate) => candidate.id === model.provider,
        )
        return (
          <Card className="model-card" key={model.uiKey}>
            <div className="model-card-heading">
              <span>{String(index + 1).padStart(2, "0")}</span>
              <Input
                aria-label="模型配置 ID"
                value={model.id}
                onChange={(event) => update(index, { id: event.target.value })}
                className="h-8 w-48"
              />
              <Button
                size="icon"
                variant="ghost"
                aria-label="删除模型"
                onClick={() =>
                  setModels((current) =>
                    current.filter((_, candidate) => candidate !== index),
                  )
                }
              >
                <Icon icon="lucide:trash-2" width="15" />
              </Button>
            </div>
            <div className="form-grid model-grid">
              <div className="field">
                <span>Provider</span>
                <Input
                  list="provider-options"
                  value={model.provider}
                  onChange={(event) =>
                    update(index, { provider: event.target.value })
                  }
                />
              </div>
              <div className="field">
                <span>Model ID</span>
                <Input
                  list={`model-options-${index}`}
                  value={model.modelId}
                  onChange={(event) => {
                    const selected = provider?.models.find(
                      (candidate) => candidate.id === event.target.value,
                    )
                    update(index, {
                      modelId: event.target.value,
                      ...(selected
                        ? {
                            contextWindow: selected.contextWindow,
                            thinkingEnabled: selected.reasoning,
                            reasoningEffort: selected.reasoning
                              ? "medium"
                              : "off",
                          }
                        : {}),
                    })
                  }}
                />
                <datalist id={`model-options-${index}`}>
                  {provider?.models.map((candidate) => (
                    <option value={candidate.id} key={candidate.id}>
                      {candidate.name}
                    </option>
                  ))}
                </datalist>
              </div>
              <div className="field">
                <span>Base URL（可选）</span>
                <Input
                  type="url"
                  value={model.baseUrl}
                  onChange={(event) =>
                    update(index, { baseUrl: event.target.value })
                  }
                  placeholder="使用 Provider 默认地址"
                />
              </div>
              <div className="field">
                <span>Context Window</span>
                <Input
                  type="number"
                  min="1"
                  value={model.contextWindow}
                  onChange={(event) =>
                    update(index, { contextWindow: Number(event.target.value) })
                  }
                />
              </div>
              <div className="field">
                <span>Reasoning Effort</span>
                <Select
                  value={model.reasoningEffort}
                  onValueChange={(level) =>
                    update(index, { reasoningEffort: level })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[
                      "off",
                      "minimal",
                      "low",
                      "medium",
                      "high",
                      "xhigh",
                      "max",
                    ].map((level) => (
                      <SelectItem value={level} key={level}>
                        {level}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="field">
                <span>模型专用 API Key</span>
                <Input
                  type="password"
                  value={model.apiKey ?? ""}
                  onChange={(event) =>
                    update(index, {
                      apiKey: event.target.value,
                      clearApiKey: false,
                    })
                  }
                  placeholder={
                    model.apiKeyConfigured
                      ? "已配置；留空保持不变"
                      : "优先使用 Provider 凭据"
                  }
                />
              </div>
            </div>
            <div className="toggle-row">
              <div>
                <Checkbox
                  checked={model.thinkingEnabled}
                  onCheckedChange={(checked) =>
                    update(index, { thinkingEnabled: checked === true })
                  }
                />
                启用模型推理
              </div>
              <div>
                <Checkbox
                  checked={model.passthroughThinking}
                  onCheckedChange={(checked) =>
                    update(index, { passthroughThinking: checked === true })
                  }
                />
                透传自定义推理档位
              </div>
              {model.apiKeyConfigured ? (
                <div>
                  <Checkbox
                    checked={model.clearApiKey === true}
                    onCheckedChange={(checked) =>
                      update(index, {
                        clearApiKey: checked === true,
                        apiKey: "",
                      })
                    }
                  />
                  清除专用 Key
                </div>
              ) : null}
            </div>
          </Card>
        )
      })}
      <datalist id="provider-options">
        {authentication.providers.map((provider) => (
          <option value={provider.id} key={provider.id}>
            {provider.name}
          </option>
        ))}
      </datalist>
      <div className="settings-actions">
        <Button variant="secondary" onClick={addModel}>
          <Icon icon="lucide:plus" width="15" />
          添加模型
        </Button>
        <Button
          onClick={() => void save()}
          disabled={busy || models.length === 0}
        >
          <Icon
            icon={busy ? "lucide:loader-circle" : "lucide:save"}
            className={busy ? "animate-spin" : ""}
            width="15"
          />
          保存模型池
        </Button>
      </div>
    </div>
  )
}
