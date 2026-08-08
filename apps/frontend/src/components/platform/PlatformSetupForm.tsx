import type { ControlPlaneSetupSnapshot } from "@ctf-agent/core"
import { type ReactNode, useId } from "react"
import { Combobox } from "../ui/combobox.tsx"
import { Input } from "../ui/input.tsx"
import { Label } from "../ui/label.tsx"

export type PlatformSetupOption = ControlPlaneSetupSnapshot["platforms"][number]
type SetupField = PlatformSetupOption["setup"]["fields"][number]

export function PlatformSetupForm({
  platform,
  strategyId,
  config,
  secrets,
  configuredSecrets = {},
  onStrategyChange,
  onConfigChange,
  onSecretsChange,
}: {
  platform: PlatformSetupOption
  strategyId: string
  config: Record<string, unknown>
  secrets: Record<string, string>
  configuredSecrets?: Record<string, { configured: boolean }>
  onStrategyChange(id: string, defaults: Record<string, unknown>): void
  onConfigChange(config: Record<string, unknown>): void
  onSecretsChange(secrets: Record<string, string>): void
}) {
  const strategy =
    platform.setup.authStrategies.find((item) => item.id === strategyId) ??
    platform.setup.authStrategies[0]

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        {platform.setup.fields.map((field) => (
          <PluginField
            key={field.key}
            field={field}
            value={config[field.key]}
            onChange={(value) =>
              onConfigChange({ ...config, [field.key]: value })
            }
          />
        ))}
      </div>

      {platform.setup.authStrategies.length > 1 ? (
        <FieldShell label="登录方式" required>
          <Combobox
            value={strategy?.id ?? ""}
            onChange={(id) => {
              const next = platform.setup.authStrategies.find(
                (item) => item.id === id,
              )
              if (next) onStrategyChange(next.id, next.config)
            }}
            options={platform.setup.authStrategies.map((item) => ({
              value: item.id,
              label: item.label,
            }))}
            placeholder="选择登录方式"
            searchPlaceholder="搜索登录方式…"
          />
        </FieldShell>
      ) : null}

      {strategy?.secrets.length ? (
        <div className="grid gap-4 rounded-lg border border-border bg-muted/30 p-4 sm:grid-cols-2">
          {strategy.secrets.map((field) => (
            <SecretField
              key={field.name}
              label={field.label}
              type={field.type}
              required={field.required}
              value={secrets[field.name] ?? ""}
              configured={configuredSecrets[field.name]?.configured === true}
              onChange={(value) =>
                onSecretsChange({ ...secrets, [field.name]: value })
              }
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}

function PluginField({
  field,
  value,
  onChange,
}: {
  field: SetupField
  value: unknown
  onChange(value: string | number): void
}) {
  const id = useId()
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {field.label}
        {field.required ? " *" : ""}
      </Label>
      <Input
        id={id}
        type={field.type === "integer" ? "number" : field.type}
        required={field.required}
        min={field.minimum}
        max={field.maximum}
        placeholder={field.placeholder}
        value={String(value ?? "")}
        onChange={(event) =>
          onChange(
            field.type === "integer"
              ? Number(event.target.value)
              : event.target.value,
          )
        }
      />
    </div>
  )
}

function SecretField({
  label,
  type,
  required,
  value,
  configured,
  onChange,
}: {
  label: string
  type: string
  required: boolean
  value: string
  configured: boolean
  onChange(value: string): void
}) {
  const id = useId()
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
        {required ? " *" : ""}
      </Label>
      <Input
        id={id}
        type={type === "text" ? "text" : "password"}
        autoComplete="off"
        value={value}
        placeholder={configured ? "已保存；留空则保持不变" : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  )
}

function FieldShell({
  label,
  required,
  children,
}: {
  label: string
  required?: boolean
  children: ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">
        {label}
        {required ? " *" : ""}
      </Label>
      {children}
    </div>
  )
}
