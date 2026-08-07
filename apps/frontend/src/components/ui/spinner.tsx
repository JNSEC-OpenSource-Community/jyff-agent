import { Icon } from "@iconify/react"
import type * as React from "react"

export function Spinner({
  label = "正在载入",
}: {
  label?: string
}): React.ReactElement {
  return (
    <div data-slot="spinner" className="loading-state" role="status">
      <Icon icon="lucide:loader-circle" className="animate-spin" width="20" />
      <span>{label}</span>
    </div>
  )
}
