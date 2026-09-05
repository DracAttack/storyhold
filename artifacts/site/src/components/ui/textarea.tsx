import * as React from "react"

import { cn } from "@/lib/utils"

const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.ComponentProps<"textarea">
>(({ className, ...props }, ref) => {
  return (
    <textarea
      className={cn(
        "storyhold-neu-inset flex min-h-[80px] w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-base shadow-inner transition-[border-color,box-shadow,background-color] placeholder:text-muted-foreground/80 hover:border-white/15 focus-visible:border-primary/55 focus-visible:bg-black/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/15 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        className
      )}
      ref={ref}
      {...props}
    />
  )
})
Textarea.displayName = "Textarea"

export { Textarea }
