import type * as React from "react"
import { cn } from "#lib/utils"

function Input({
  className,
  type,
  ...props
}: React.ComponentProps<"input">): React.ReactElement {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "flex h-9 w-full min-w-0 rounded-md border border-border bg-background/40 px-3 py-1 text-sm text-foreground shadow-sm outline-none transition-all placeholder:text-muted-foreground/50 hover:border-border focus-visible:border-primary/40 focus-visible:bg-background/60 focus-visible:ring-[3px] focus-visible:ring-primary/15 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-danger/40 aria-invalid:ring-danger/10",
        className,
      )}
      {...props}
    />
  )
}

export { Input }
