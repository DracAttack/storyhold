import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { chicagoTitleChildren, cn } from "@/lib/utils"

const badgeVariants = cva(
  // @replit
  // Whitespace-nowrap: Badges should never wrap.
  "whitespace-nowrap inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      variant: {
        default:
          // @replit shadow-xs instead of shadow, no hover because we use hover-elevate
          "border-primary/30 bg-primary/90 text-primary-foreground shadow-[0_6px_16px_-10px_rgba(56,189,248,0.8),inset_0_1px_0_rgba(255,255,255,0.25)]",
        secondary:
          // @replit no hover because we use hover-elevate
          "border-white/8 bg-white/[0.06] text-secondary-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] backdrop-blur-md",
        destructive:
          // @replit shadow-xs instead of shadow, no hover because we use hover-elevate
          "border-red-300/20 bg-destructive/90 text-destructive-foreground shadow-[0_6px_16px_-10px_rgba(239,68,68,0.7)]",
          // @replit shadow-xs" - use badge outline variable
        outline: "border-white/10 bg-black/15 text-foreground backdrop-blur-md",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, children, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props}>
      {chicagoTitleChildren(children)}
    </div>
  )
}

export { Badge, badgeVariants }
