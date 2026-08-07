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
        "border-input placeholder:text-muted-foreground/60 aria-invalid:ring-destructive/20 dark:bg-input/30 flex min-h-16 w-full min-w-0 rounded-md border bg-background/60 px-3 py-2 text-sm shadow-xs transition-colors outline-none focus-visible:border-ring/60 focus-visible:ring-[3px] focus-visible:ring-ring/25 disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  )
}

export { Textarea }
