import { Icon } from "@iconify/react"
import * as PopoverPrimitive from "@radix-ui/react-popover"
import { Command } from "cmdk"
import { useMemo, useState } from "react"
import { cn } from "#lib/utils"

export interface ComboboxOption {
  value: string
  label: string
  description?: string
  disabled?: boolean
}

interface ComboboxProps {
  value: string
  onChange(value: string): void
  options: ComboboxOption[]
  placeholder?: string
  emptyLabel?: string
  searchPlaceholder?: string
  emptyText?: string
  disabled?: boolean
  className?: string
  id?: string
  compactOptions?: boolean
}

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
  id,
  compactOptions = false,
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
        <button
          type="button"
          role="combobox"
          id={id}
          aria-expanded={open}
          className={cn(
            "flex h-9 w-full items-center justify-between gap-2 rounded-md border border-border bg-background/40 px-3 py-2 text-sm text-foreground shadow-sm outline-none transition-all hover:border-border focus-visible:border-primary/40 focus-visible:ring-[3px] focus-visible:ring-primary/15 disabled:cursor-not-allowed disabled:opacity-50",
            !selected && "text-muted-foreground/60",
            className,
          )}
        >
          <span
            className="min-w-0 flex-1 truncate text-left"
            title={selected?.label}
          >
            {selected ? selected.label : placeholder}
          </span>
          <Icon
            icon="lucide:chevrons-up-down"
            width="14"
            className="shrink-0 text-muted-foreground/70"
          />
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="start"
          sideOffset={4}
          className={cn(
            "z-50 w-[--radix-popover-trigger-width] rounded-md border border-border bg-popover text-popover-foreground shadow-lg",
            "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
          )}
        >
          <Command className="overflow-hidden rounded-md">
            <div className="flex items-center border-b border-border px-3">
              <Icon
                icon="lucide:search"
                width="14"
                className="mr-2 shrink-0 text-muted-foreground/60"
              />
              <Command.Input
                value={query}
                onValueChange={setQuery}
                placeholder={searchPlaceholder}
                className="flex h-9 w-full bg-transparent py-2 text-sm outline-none placeholder:text-muted-foreground/60"
              />
            </div>
            <Command.List className="max-h-60 overflow-y-auto p-1">
              <Command.Empty className="py-6 text-center text-sm text-muted-foreground">
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
                  compact={compactOptions}
                />
              ))}
            </Command.List>
          </Command>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  )
}

function CommandItem({
  active,
  disabled,
  onSelect,
  label,
  description,
  compact = false,
}: {
  active: boolean
  disabled?: boolean
  onSelect(value: string): void
  label: string
  description?: string
  compact?: boolean
}): React.ReactElement {
  return (
    <Command.Item
      value={label}
      disabled={disabled}
      onSelect={onSelect}
      className={cn(
        "relative flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 pr-8 text-sm outline-none select-none",
        "data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground",
        "data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50",
        active && "bg-accent/60",
      )}
    >
      <span
        className={cn(
          "min-w-0 flex-1",
          compact && "flex items-baseline gap-2 truncate",
        )}
      >
        <span className={cn("truncate", !compact && "block")}>{label}</span>
        {description ? (
          <span
            className={cn(
              "truncate text-xs text-muted-foreground",
              !compact && "block",
            )}
          >
            {compact ? "· " : ""}
            {description}
          </span>
        ) : null}
      </span>
      {active ? (
        <Icon
          icon="lucide:check"
          className="absolute right-2 shrink-0"
          width="14"
        />
      ) : null}
    </Command.Item>
  )
}

export { Combobox }
