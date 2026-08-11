import type * as React from "react"
import { cn } from "#lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">): React.ReactElement {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "flex h-9 w-full min-w-0 rounded-md border border-border bg-background px-3 py-1 text-sm text-foreground outline-none transition-[background-color,border-color,box-shadow] placeholder:text-muted-foreground/50 hover:border-muted-foreground/50 focus-visible:border-primary/60 focus-visible:bg-card focus-visible:ring-2 focus-visible:ring-primary/15 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-danger/40 aria-invalid:ring-danger/10",
        className,
      )}
      {...props}
    />
  )
}

export { Input }
