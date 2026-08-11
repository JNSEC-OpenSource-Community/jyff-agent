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
  side = "left",
  ...props
}: React.ComponentPropsWithoutRef<typeof SheetPrimitive.Content> & {
  side?: "left" | "bottom"
}): React.ReactElement {
  return (
    <SheetPrimitive.Portal>
      <SheetPrimitive.Overlay
        data-slot="sheet-overlay"
        className="sheet-overlay fixed inset-0 z-50 bg-black/60 backdrop-blur-[2px]"
      />
      <SheetPrimitive.Content
        data-slot="sheet-content"
        data-side={side}
        className={cn(
          "sheet-content fixed z-50 flex min-h-0 flex-col border-border bg-sidebar outline-none",
          side === "left"
            ? "inset-y-0 left-0 w-[min(18rem,calc(100vw-1rem))] border-r"
            : "inset-x-0 bottom-0 h-[min(85dvh,42rem)] max-h-[85dvh] overflow-hidden rounded-t-xl border-t",
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
        "absolute top-3 right-3 flex size-8 items-center justify-center rounded-md text-foreground/70 transition-colors hover:bg-muted hover:text-foreground",
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
