import { Icon } from "@iconify/react"
import type * as React from "react"
import { cn } from "#lib/utils"

export function Spinner({
  label = "正在载入",
  className,
}: {
  label?: string
  className?: string
}): React.ReactElement {
  return (
    <div
      data-slot="spinner"
      className={cn(
        "flex flex-col items-center justify-center gap-4 pt-20 pb-12 text-muted-foreground",
        className,
      )}
      role="status"
    >
      <span className="relative flex size-10 items-center justify-center">
        <span className="absolute inline-flex size-full animate-ping-soft rounded-full bg-primary/20" />
        <span className="absolute inset-0 rounded-full border-2 border-primary/10" />
        <Icon
          icon="lucide:loader-circle"
          className="relative animate-spin text-primary"
          width="22"
        />
      </span>
      <span className="text-sm font-medium">{label}</span>
    </div>
  )
}
