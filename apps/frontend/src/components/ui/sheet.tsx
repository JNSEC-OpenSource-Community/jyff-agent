import { Icon } from "@iconify/react"
import * as SheetPrimitive from "@radix-ui/react-dialog"
import type * as React from "react"
import { cn } from "#lib/utils"

const Sheet = SheetPrimitive.Root
const SheetTrigger = SheetPrimitive.Trigger
const SheetClose = SheetPrimitive.Close
const SheetTitle = SheetPrimitive.Title
const SheetDescription = SheetPrimitive.Description

function SheetContent({
  className,
  children,
  ...props
}: React.ComponentPropsWithoutRef<
  typeof SheetPrimitive.Content
>): React.ReactElement {
  return (
    <SheetPrimitive.Portal>
      <SheetPrimitive.Overlay
        data-slot="sheet-overlay"
        className="data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 bg-black/60 fixed inset-0 z-50 backdrop-blur-sm"
      />
      <SheetPrimitive.Content
        data-slot="sheet-content"
        className={cn(
          "bg-sidebar data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left fixed inset-y-0 left-0 z-50 flex w-72 flex-col border-r border-border shadow-xl outline-none",
          className,
        )}
        {...props}
      >
        {children}
      </SheetPrimitive.Content>
    </SheetPrimitive.Portal>
  )
}

function SheetCloseButton({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Close>): React.ReactElement {
  return (
    <SheetPrimitive.Close
      data-slot="sheet-close"
      className={cn(
        "text-muted-foreground hover:text-foreground absolute top-3 right-3 flex size-8 items-center justify-center rounded-lg opacity-70 transition-all hover:bg-muted hover:opacity-100",
        className,
      )}
      {...props}
    >
      <Icon icon="lucide:x" width="18" />
    </SheetPrimitive.Close>
  )
}

export {
  Sheet,
  SheetClose,
  SheetCloseButton,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
}
