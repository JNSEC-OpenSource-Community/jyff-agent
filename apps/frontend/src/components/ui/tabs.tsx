import * as TabsPrimitive from "@radix-ui/react-tabs"
import type * as React from "react"
import { cn } from "#lib/utils"

function Tabs({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof TabsPrimitive.Root>): React.ReactElement {
  return (
    <TabsPrimitive.Root data-slot="tabs" className={cn("flex flex-col", className)} {...props} />
  )
}

function TabsList({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>): React.ReactElement {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn(
        "inline-flex h-9 w-fit items-center gap-0.5 rounded-md border border-border bg-muted p-0.5",
        className,
      )}
      {...props}
    />
  )
}

function TabsTrigger({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>): React.ReactElement {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        "inline-flex h-full items-center justify-center gap-1.5 rounded-sm px-2.5 py-1 text-sm font-medium whitespace-nowrap text-muted-foreground outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-background data-[state=active]:text-foreground",
        className,
      )}
      {...props}
    />
  )
}

function TabsContent({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>): React.ReactElement {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn("flex-1 outline-none", className)}
      {...props}
    />
  )
}

export { Tabs, TabsContent, TabsList, TabsTrigger }
