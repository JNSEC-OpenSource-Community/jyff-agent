import { Icon } from "@iconify/react"
import * as CollapsiblePrimitive from "@radix-ui/react-collapsible"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { Slot } from "@radix-ui/react-slot"
import * as TabsPrimitive from "@radix-ui/react-tabs"
import * as TooltipPrimitive from "@radix-ui/react-tooltip"
import { cva, type VariantProps } from "class-variance-authority"
import { type ClassValue, clsx } from "clsx"
import type * as React from "react"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

const buttonVariants = cva("button", {
  variants: {
    variant: {
      primary: "button-primary",
      secondary: "button-secondary",
      ghost: "button-ghost",
      danger: "button-danger",
    },
    size: {
      default: "button-default",
      sm: "button-sm",
      icon: "button-icon",
    },
  },
  defaultVariants: { variant: "primary", size: "default" },
})

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

export function Button({
  className,
  variant,
  size,
  asChild,
  ...props
}: ButtonProps): React.ReactElement {
  const Component = asChild ? Slot : "button"
  return (
    <Component
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  )
}

export function Card({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.ReactElement {
  return <div className={cn("card", className)} {...props} />
}

export function Badge({
  tone = "neutral",
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & {
  tone?: "neutral" | "positive" | "warning" | "danger" | "info"
}): React.ReactElement {
  return <span className={cn("badge", `badge-${tone}`, className)} {...props} />
}

export const Tabs = TabsPrimitive.Root
export const TabsContent = TabsPrimitive.Content

export function TabsList({
  className,
  ...props
}: React.ComponentPropsWithoutRef<
  typeof TabsPrimitive.List
>): React.ReactElement {
  return (
    <TabsPrimitive.List className={cn("tabs-list", className)} {...props} />
  )
}

export function TabsTrigger({
  className,
  ...props
}: React.ComponentPropsWithoutRef<
  typeof TabsPrimitive.Trigger
>): React.ReactElement {
  return (
    <TabsPrimitive.Trigger
      className={cn("tabs-trigger", className)}
      {...props}
    />
  )
}

export const Collapsible = CollapsiblePrimitive.Root
export const CollapsibleTrigger = CollapsiblePrimitive.Trigger
export const CollapsibleContent = CollapsiblePrimitive.Content

export function Tooltip({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}): React.ReactElement {
  return (
    <TooltipPrimitive.Root delayDuration={250}>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content className="tooltip" sideOffset={8}>
          {label}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  )
}

export function MobileSheet({
  open,
  onOpenChange,
  children,
}: {
  open: boolean
  onOpenChange(open: boolean): void
  children: React.ReactNode
}): React.ReactElement {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="sheet-overlay" />
        <DialogPrimitive.Content className="sheet-content">
          <DialogPrimitive.Title className="sr-only">
            导航
          </DialogPrimitive.Title>
          {children}
          <DialogPrimitive.Close className="sheet-close" aria-label="关闭导航">
            <Icon icon="lucide:x" width="18" />
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: string
  title: string
  description: string
  action?: React.ReactNode
}): React.ReactElement {
  return (
    <div className="empty-state">
      <div className="empty-state-icon">
        <Icon icon={icon} width="24" />
      </div>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  )
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string
  title: string
  description?: string
  actions?: React.ReactNode
}): React.ReactElement {
  return (
    <header className="page-header">
      <div>
        {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
        <h1>{title}</h1>
        {description ? <p className="page-description">{description}</p> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </header>
  )
}

export function Spinner({
  label = "正在载入",
}: {
  label?: string
}): React.ReactElement {
  return (
    <div className="loading-state" role="status">
      <Icon icon="lucide:loader-circle" className="spin" width="20" />
      <span>{label}</span>
    </div>
  )
}

export function ErrorNotice({
  message,
}: {
  message: string
}): React.ReactElement {
  return (
    <div className="notice notice-error" role="alert">
      <Icon icon="lucide:circle-alert" width="18" />
      <span>{message}</span>
    </div>
  )
}
