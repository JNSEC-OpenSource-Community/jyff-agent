import { Icon } from "@iconify/react"
import type * as React from "react"
import { cn } from "#lib/utils"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../ui/alert-dialog.tsx"
import { Sheet, SheetCloseButton, SheetContent, SheetTitle } from "../ui/sheet.tsx"

function MobileSheet({
  open,
  onOpenChange,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  children: React.ReactNode
}): React.ReactElement {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent>
        <SheetTitle className="sr-only">导航</SheetTitle>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        <SheetCloseButton aria-label="关闭导航" />
      </SheetContent>
    </Sheet>
  )
}

function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  busy = false,
  busyLabel = "正在删除…",
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  confirmLabel: string
  busy?: boolean
  busyLabel?: string
  onConfirm: () => void
}): React.ReactElement {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader className="grid-cols-[2.5rem_minmax(0,1fr)] gap-x-3 gap-y-0">
          <span
            className="row-span-2 flex size-10 items-center justify-center rounded-lg bg-danger/10 text-danger ring-1 ring-inset ring-danger/15"
            aria-hidden="true"
          >
            <Icon icon="lucide:triangle-alert" width="18" />
          </span>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription className="mt-1">{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
          <AlertDialogAction
            disabled={busy}
            onClick={(event) => {
              event.preventDefault()
              onConfirm()
            }}
          >
            {busy ? busyLabel : confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon: string
  title: string
  description: string
  action?: React.ReactNode
  className?: string
}): React.ReactElement {
  return (
    <div
      data-slot="empty"
      className={cn(
        "flex min-h-32 flex-col items-center justify-center p-6 text-center",
        className,
      )}
    >
      <div
        data-slot="empty-icon"
        className="mb-3 flex size-10 items-center justify-center rounded-md border border-border bg-muted text-muted-foreground"
      >
        <Icon icon={icon} width="24" aria-hidden="true" />
      </div>
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="mt-2! max-w-sm text-sm leading-6 text-muted-foreground">{description}</p>
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  )
}

function PageHeader({
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
    <header className="page-header flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        {eyebrow ? (
          <p className="mb-1! text-[11px] font-bold uppercase tracking-[0.18em] text-muted-foreground">
            {eyebrow}
          </p>
        ) : null}
        <h1 className="page-title">{title}</h1>
        {description ? <p className="page-description">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  )
}

function ErrorNotice({
  message,
  className,
}: {
  message: string
  className?: string
}): React.ReactElement {
  return (
    <div
      className={cn(
        "flex items-start gap-2.5 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger",
        className,
      )}
      role="alert"
    >
      <Icon icon="lucide:circle-alert" width="18" className="mt-0.5 shrink-0" aria-hidden="true" />
      <span>{message}</span>
    </div>
  )
}

function SettingsSection({
  title,
  description,
  meta,
  children,
  danger = false,
}: {
  title: string
  description: string
  meta?: React.ReactNode
  children: React.ReactNode
  danger?: boolean
}): React.ReactElement {
  return (
    <section className="grid gap-4 border-t border-border py-5 first:border-t-0 first:pt-0 lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-8">
      <header className="min-w-0">
        <div className="flex items-start justify-between gap-3">
          <h2 className={cn("text-sm font-semibold tracking-tight", danger && "text-danger")}>
            {title}
          </h2>
          {meta ? <div className="shrink-0">{meta}</div> : null}
        </div>
        <p className="mt-1.5! text-xs leading-5 text-muted-foreground">{description}</p>
      </header>
      <div className="min-w-0">{children}</div>
    </section>
  )
}

export { ConfirmDialog, EmptyState, ErrorNotice, MobileSheet, PageHeader, SettingsSection }
