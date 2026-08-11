import { cva, type VariantProps } from "class-variance-authority"
import type * as React from "react"
import { cn } from "#lib/utils"

const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-sm border px-1.5 py-0.5 font-sans text-[10px] leading-4 font-medium tracking-[0.01em] antialiased [&>svg]:size-3",
  {
    variants: {
      tone: {
        neutral: "border-border bg-muted/60 text-muted-foreground",
        positive: "border-success/30 bg-success/10 text-success",
        warning: "border-warning/30 bg-warning/10 text-warning",
        danger: "border-danger/30 bg-danger/10 text-danger",
        info: "border-info/30 bg-info/10 text-info",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
)

function Badge({
  tone,
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>): React.ReactElement {
  return <span data-slot="badge" className={cn(badgeVariants({ tone }), className)} {...props} />
}

export { Badge, badgeVariants }
