import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { chicagoTitleChildren, cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl border text-sm font-semibold transition-[transform,filter,background-color,border-color,box-shadow] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45 focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 motion-safe:hover:-translate-y-px motion-safe:active:translate-y-0",
  {
    variants: {
      variant: {
        default:
          "border-sky-200/65 bg-gradient-to-br from-[#9ce4ff] via-primary to-[#247ac7] text-primary-foreground shadow-[0_10px_26px_-14px_rgba(56,189,248,0.9),inset_0_1px_0_rgba(255,255,255,0.42),inset_0_-1px_0_rgba(5,62,105,0.3)] hover:brightness-110 active:shadow-[inset_2px_2px_6px_rgba(5,62,105,0.34)]",
        destructive:
          "border-red-300/20 bg-gradient-to-br from-red-500 to-red-700 text-destructive-foreground shadow-[0_10px_24px_-16px_rgba(239,68,68,0.75),inset_0_1px_0_rgba(255,255,255,0.22)] hover:brightness-110",
        outline:
          "border-white/10 bg-white/[0.035] text-foreground shadow-[0_8px_20px_-16px_rgba(0,0,0,0.9),inset_0_1px_0_rgba(255,255,255,0.05)] backdrop-blur-md hover:border-primary/35 hover:bg-primary/[0.07]",
        secondary:
          "border-white/10 bg-gradient-to-br from-white/[0.095] to-white/[0.035] text-secondary-foreground shadow-[0_8px_22px_-18px_rgba(0,0,0,0.95),inset_0_1px_0_rgba(255,255,255,0.06)] backdrop-blur-md hover:border-white/20 hover:bg-white/[0.11]",
        ghost: "border-transparent bg-transparent hover:border-white/8 hover:bg-white/[0.055]",
        link: "border-transparent bg-transparent text-primary underline-offset-4 shadow-none hover:underline",
      },
      size: {
        // @replit changed sizes
        default: "min-h-10 px-4 py-2",
        sm: "min-h-8 rounded-lg px-3 text-xs",
        lg: "min-h-11 px-8",
        icon: "h-10 w-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, children, ...props }, ref) => {
    const Comp = asChild ? Slot : "button"
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      >
        {chicagoTitleChildren(children)}
      </Comp>
    )
  }
)
Button.displayName = "Button"

export { Button, buttonVariants }
