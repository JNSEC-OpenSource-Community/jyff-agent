import * as LabelPrimitive from "@radix-ui/react-label"
import type * as React from "react"
import { cn } from "#lib/utils"

function Label({
  className,
  ...props
}: React.ComponentProps<typeof LabelPrimitive.Root>): React.ReactElement {
  return (
    <LabelPrimitive.Root
      data-slot="label"
      className={cn(
        "flex items-center gap-2 text-xs font-semibold text-foreground/85 select-none",
        className,
      )}
      {...props}
    />
  )
}

export { Label }
