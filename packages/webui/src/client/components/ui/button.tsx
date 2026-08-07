import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"
import type * as React from "react"
import { cn } from "#lib/utils"

export const buttonVariants = cva(
  "button inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium outline-none transition-all focus-visible:ring-[3px] disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        primary: "button-primary",
        secondary: "button-secondary",
        ghost: "button-ghost",
        danger: "button-danger",
      },
      size: {
        default: "button-default",
        sm: "button-sm",
        icon: "button-icon",
      },
    },
    defaultVariants: { variant: "primary", size: "default" },
  },
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

export function Button({
  className,
  variant,
  size,
  asChild,
  ...props
}: ButtonProps): React.ReactElement {
  const Component = asChild ? Slot : "button"
  return (
    <Component
      data-slot="button"
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  )
}
