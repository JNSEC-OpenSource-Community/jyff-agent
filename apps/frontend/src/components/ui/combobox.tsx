import { Icon } from "@iconify/react"
import * as PopoverPrimitive from "@radix-ui/react-popover"
import { Command } from "cmdk"
import { useMemo, useState } from "react"
import { cn } from "#lib/utils"
import { Button } from "./button.tsx"

export interface ComboboxOption {
  value: string
  label: string
  description?: string
  disabled?: boolean
}

interface ComboboxProps {
  /** 当前选中值；传 "" 表示未选择。 */
  value: string
  onChange(value: string): void
  options: ComboboxOption[]
  /** 未选择时 trigger 上显示的文字。 */
  placeholder?: string
  /** 未选择时列表里可选的“空值”选项（例如“继承 Solver”）。 */
  emptyLabel?: string
  searchPlaceholder?: string
  emptyText?: string
  disabled?: boolean
  className?: string
}

/**
 * shadcn 风格 Combobox：Popover + cmdk 命令面板。
 * 受控组件，配合空值选项实现“可选留空”的绑定语义。
 */
function Combobox({
  value,
  onChange,
  options,
  placeholder = "选择…",
  emptyLabel,
  searchPlaceholder = "搜索…",
  emptyText = "没有匹配的选项",
  disabled = false,
  className,
}: ComboboxProps): React.ReactElement {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const selected = options.find((option) => option.value === value)

  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("zh-CN")
    if (!normalized) return options
    return options.filter(
      (option) =>
        option.label.toLocaleLowerCase("zh-CN").includes(normalized) ||
        option.description?.toLocaleLowerCase("zh-CN").includes(normalized),
    )
  }, [options, query])

  function select(next: string): void {
    onChange(next)
    setOpen(false)
    setQuery("")
  }

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild disabled={disabled}>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={cn(
            "w-full justify-between font-normal",
            !selected && "text-muted-foreground/70",
            className,
          )}
        >
          {selected ? selected.label : placeholder}
          <Icon icon="lucide:chevrons-up-down" width="14" />
        </Button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Content
        align="start"
        className="bg-popover text-popover-foreground z-50 w-(--radix-popover-trigger-width) rounded-md border shadow-md"
      >
        <Command className="overflow-hidden">
          <div className="border-b p-1">
            <Command.Input
              value={query}
              onValueChange={setQuery}
              placeholder={searchPlaceholder}
              className="placeholder:text-muted-foreground/60 h-8 w-full bg-transparent px-2 text-sm outline-none"
            />
          </div>
          <Command.List className="max-h-56 overflow-y-auto p-1">
            <Command.Empty className="text-muted-foreground py-4 text-center text-sm">
              {emptyText}
            </Command.Empty>
            {emptyLabel ? (
              <CommandItem
                active={value === ""}
                onSelect={() => select("")}
                label={emptyLabel}
              />
            ) : null}
            {filtered.map((option) => (
              <CommandItem
                key={option.value}
                active={value === option.value}
                disabled={option.disabled}
                onSelect={() => select(option.value)}
                label={option.label}
                description={option.description}
              />
            ))}
          </Command.List>
        </Command>
      </PopoverPrimitive.Content>
    </PopoverPrimitive.Root>
  )
}

function CommandItem({
  active,
  disabled,
  onSelect,
  label,
  description,
}: {
  active: boolean
  disabled?: boolean
  onSelect(value: string): void
  label: string
  description?: string
}): React.ReactElement {
  return (
    <Command.Item
      value={label}
      disabled={disabled}
      onSelect={onSelect}
      className={cn(
        "flex cursor-pointer items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-sm select-none",
        "data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground",
        "data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50",
        active && "bg-accent/60",
      )}
    >
      <span className="min-w-0">
        <span className="block truncate">{label}</span>
        {description ? (
          <span className="text-muted-foreground block truncate text-xs">
            {description}
          </span>
        ) : null}
      </span>
      {active ? (
        <Icon icon="lucide:check" className="shrink-0" width="14" />
      ) : null}
    </Command.Item>
  )
}

export { Combobox }
