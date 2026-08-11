import * as DialogPrimitive from "@radix-ui/react-dialog"
import type * as React from "react"
import { cn } from "#lib/utils"

const Dialog = DialogPrimitive.Root
const DialogTrigger = DialogPrimitive.Trigger
const DialogClose = DialogPrimitive.Close
const DialogTitle = DialogPrimitive.Title
const DialogDescription = DialogPrimitive.Description

function DialogContent({
  className,
  children,
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>): React.ReactElement {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black/60 backdrop-blur-[2px]" />
      <DialogPrimitive.Content
        className={cn(
          "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 flex h-dvh w-screen flex-col overflow-hidden bg-card outline-none sm:inset-auto sm:top-1/2 sm:left-1/2 sm:h-[min(86dvh,56rem)] sm:w-[min(94vw,72rem)] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-lg sm:border sm:border-border sm:shadow-xl",
          className,
        )}
        {...props}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  )
}

export { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle, DialogTrigger }
