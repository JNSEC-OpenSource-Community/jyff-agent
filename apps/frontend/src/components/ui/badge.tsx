import { cva, type VariantProps } from "class-variance-authority"
import type * as React from "react"
import { cn } from "#lib/utils"

const badgeVariants = cva("badge", {
  variants: {
    tone: {
      neutral: "badge-neutral",
      positive: "badge-positive",
      warning: "badge-warning",
      danger: "badge-danger",
      info: "badge-info",
    },
  },
  defaultVariants: { tone: "neutral" },
})

export function Badge({
  tone,
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> &
  VariantProps<typeof badgeVariants>): React.ReactElement {
  return (
    <span
      data-slot="badge"
      className={cn(badgeVariants({ tone }), className)}
      {...props}
    />
  )
}
