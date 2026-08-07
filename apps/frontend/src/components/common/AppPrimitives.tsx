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
        {children}
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
  onConfirm,
}: {
  open: boolean
  onOpenChange(open: boolean): void
  title: string
  description: string
  confirmLabel: string
  busy?: boolean
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
            {busy ? "正在删除…" : confirmLabel}
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
        "flex min-h-40 flex-col items-center justify-center gap-2 p-8 text-center",
        className,
      )}
    >
      <div
        data-slot="empty-icon"
        className="bg-muted text-muted-foreground flex size-12 items-center justify-center rounded-full"
      >
        <Icon icon={icon} width="24" />
      </div>
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="text-muted-foreground max-w-sm text-sm">{description}</p>
      {action ? <div className="mt-2">{action}</div> : null}
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
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        {eyebrow ? (
          <p className="text-muted-foreground mb-1 text-[11px] font-bold tracking-[0.18em] uppercase">
            {eyebrow}
          </p>
        ) : null}
        <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
        {description ? (
          <p className="text-muted-foreground mt-1 max-w-2xl text-sm">
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
        "border-danger/30 bg-danger/10 text-danger flex items-center gap-2 rounded-md border px-3 py-2 text-sm",
        className,
      )}
      role="alert"
    >
      <Icon icon="lucide:circle-alert" width="18" />
      <span>{message}</span>
    </div>
  )
}

export { ConfirmDialog, EmptyState, ErrorNotice, MobileSheet, PageHeader }
