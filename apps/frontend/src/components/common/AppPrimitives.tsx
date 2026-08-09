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
import {
  Sheet,
  SheetCloseButton,
  SheetContent,
  SheetTitle,
} from "../ui/sheet.tsx"

function MobileSheet({
  open,
  onOpenChange,
  children,
}: {
  open: boolean
  onOpenChange(open: boolean): void
  children: React.ReactNode
}): React.ReactElement {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent>
        <SheetTitle className="sr-only">导航</SheetTitle>
        <div className="flex-1 overflow-y-auto">{children}</div>
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
  onOpenChange(open: boolean): void
  title: string
  description: string
  confirmLabel: string
  busy?: boolean
  busyLabel?: string
  onConfirm(): void
}): React.ReactElement {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
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
        "flex min-h-40 flex-col items-center justify-center p-8 text-center",
        className,
      )}
    >
      <div
        data-slot="empty-icon"
        className="mb-4 flex size-12 items-center justify-center rounded-full border border-border bg-muted text-muted-foreground shadow-sm"
      >
        <Icon icon={icon} width="24" />
      </div>
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="mt-2! max-w-sm text-sm leading-6 text-muted-foreground">
        {description}
      </p>
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
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        {eyebrow ? (
          <p className="mb-1! text-[11px] font-bold uppercase tracking-[0.18em] text-muted-foreground">
            {eyebrow}
          </p>
        ) : null}
        <h1 className="text-3xl font-bold tracking-tight">{title}</h1>
        {description ? (
          <p className="mt-1.5! max-w-2xl text-sm text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex shrink-0 items-center gap-2">{actions}</div>
      ) : null}
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
        "flex items-start gap-2.5 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2.5 text-sm text-danger",
        className,
      )}
      role="alert"
    >
      <Icon icon="lucide:circle-alert" width="18" className="mt-0.5 shrink-0" />
      <span>{message}</span>
    </div>
  )
}

export { ConfirmDialog, EmptyState, ErrorNotice, MobileSheet, PageHeader }
