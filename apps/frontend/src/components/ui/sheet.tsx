import * as SheetPrimitive from "@radix-ui/react-dialog"
import type * as React from "react"
import { cn } from "#lib/utils"

export const Sheet = SheetPrimitive.Root
export const SheetTrigger = SheetPrimitive.Trigger
export const SheetClose = SheetPrimitive.Close
export const SheetTitle = SheetPrimitive.Title
export const SheetDescription = SheetPrimitive.Description

export function SheetContent({
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
        className="sheet-overlay"
      />
      <SheetPrimitive.Content
        data-slot="sheet-content"
        className={cn("sheet-content", className)}
        {...props}
      >
        {children}
      </SheetPrimitive.Content>
    </SheetPrimitive.Portal>
  )
}
