import type * as React from "react"
import { cn } from "#lib/utils"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">): React.ReactElement {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex min-h-16 w-full min-w-0 rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none transition-[background-color,border-color,box-shadow] placeholder:text-muted-foreground/50 hover:border-muted-foreground/50 focus-visible:border-primary/60 focus-visible:bg-card focus-visible:ring-2 focus-visible:ring-primary/15 disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  )
}

export { Textarea }
