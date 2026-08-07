import * as AlertDialogPrimitive from "@radix-ui/react-alert-dialog"
import type * as React from "react"
import { cn } from "#lib/utils"
import { buttonVariants } from "./button.tsx"

export const AlertDialog = AlertDialogPrimitive.Root
export const AlertDialogTrigger = AlertDialogPrimitive.Trigger

export function AlertDialogContent({
  className,
  ...props
}: React.ComponentPropsWithoutRef<
  typeof AlertDialogPrimitive.Content
>): React.ReactElement {
  return (
    <AlertDialogPrimitive.Portal>
      <AlertDialogPrimitive.Overlay
        data-slot="alert-dialog-overlay"
        className="dialog-overlay"
      />
      <AlertDialogPrimitive.Content
        data-slot="alert-dialog-content"
        className={cn("dialog-content", className)}
        {...props}
      />
    </AlertDialogPrimitive.Portal>
  )
}

export function AlertDialogHeader({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.ReactElement {
  return (
    <div
      data-slot="alert-dialog-header"
      className={cn("grid gap-2", className)}
      {...props}
    />
  )
}

export function AlertDialogFooter({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.ReactElement {
  return (
    <div
      data-slot="alert-dialog-footer"
      className={cn("dialog-actions", className)}
      {...props}
    />
  )
}

export function AlertDialogTitle({
  className,
  ...props
}: React.ComponentPropsWithoutRef<
  typeof AlertDialogPrimitive.Title
>): React.ReactElement {
  return (
    <AlertDialogPrimitive.Title
      data-slot="alert-dialog-title"
      className={cn("text-lg font-semibold", className)}
      {...props}
    />
  )
}

export function AlertDialogDescription({
  className,
  ...props
}: React.ComponentPropsWithoutRef<
  typeof AlertDialogPrimitive.Description
>): React.ReactElement {
  return (
    <AlertDialogPrimitive.Description
      data-slot="alert-dialog-description"
      className={cn("text-muted-foreground text-sm", className)}
      {...props}
    />
  )
}

export function AlertDialogAction({
  className,
  ...props
}: React.ComponentPropsWithoutRef<
  typeof AlertDialogPrimitive.Action
>): React.ReactElement {
  return (
    <AlertDialogPrimitive.Action
      data-slot="alert-dialog-action"
      className={cn(buttonVariants({ variant: "danger" }), className)}
      {...props}
    />
  )
}

export function AlertDialogCancel({
  className,
  ...props
}: React.ComponentPropsWithoutRef<
  typeof AlertDialogPrimitive.Cancel
>): React.ReactElement {
  return (
    <AlertDialogPrimitive.Cancel
      data-slot="alert-dialog-cancel"
      className={cn(buttonVariants({ variant: "secondary" }), className)}
      {...props}
    />
  )
}
