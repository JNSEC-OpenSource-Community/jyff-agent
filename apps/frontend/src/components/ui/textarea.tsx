import type * as React from "react"
import { cn } from "#lib/utils"

function Textarea({
  className,
  ...props
}: React.ComponentProps<"textarea">): React.ReactElement {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex min-h-16 w-full min-w-0 rounded-md border border-border bg-background/40 px-3 py-2 text-sm text-foreground shadow-sm outline-none transition-all placeholder:text-muted-foreground/50 hover:border-border focus-visible:border-primary/40 focus-visible:bg-background/60 focus-visible:ring-[3px] focus-visible:ring-primary/15 disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  )
}

export { Textarea }
